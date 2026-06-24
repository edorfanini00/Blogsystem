// ═══════════════════════════════════════════════════════════════════
// Video Generation — Source keyframe extractor
// Pulls one representative frame per source beat from the actual source MP4
// so the Image agent can pass a per-shot structural reference (the /edit
// lanes) instead of a single cover thumbnail. This is what makes the remake
// track the source composition beat-by-beat.
//
// Works where we can fetch a real MP4: TikTok (via the no-watermark resolver)
// and Instagram (stored media_url). YouTube has no direct MP4, so callers fall
// back to the single thumbnail. Frames are extracted with the bundled ffmpeg
// (fast pre-input seek) and hosted on Vercel Blob for the image provider.
// ═══════════════════════════════════════════════════════════════════
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import * as fal from './fal.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const DOWNLOAD_TIMEOUT_MS = 25000;
const MAX_BYTES = 80 * 1024 * 1024; // don't pull huge files into /tmp

// Per-beat keyframes need ffmpeg to extract and Vercel Blob to host the frames.
export const isKeyframesSupported = !!ffmpegPath && fal.isFalBlobConfigured;

function refererFor(host) {
    if (/instagram|fbcdn/.test(host)) return 'https://www.instagram.com/';
    if (/tiktok|muscdn|ibyteimg|byteimg|ttwstatic|tikwm/.test(host)) return 'https://www.tiktok.com/';
    return undefined;
}

// Resolve a clean, downloadable no-watermark MP4 from a TikTok post URL.
async function resolveTikTokMp4(pageUrl) {
    const api = `https://www.tikwm.com/api/?hd=1&url=${encodeURIComponent(pageUrl)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
        const res = await fetch(api, { headers: { 'User-Agent': UA }, signal: controller.signal });
        const j = await res.json();
        const play = j?.data?.hdplay || j?.data?.play || j?.data?.wmplay;
        if (!play) return null;
        return play.startsWith('http') ? play : `https://www.tikwm.com${play}`;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Best downloadable MP4 URL for a candidate, or null when none is reachable.
async function resolveSourceMp4(candidate) {
    if (candidate.platform === 'youtube') return null; // no direct MP4
    if (candidate.platform === 'tiktok') {
        const r = await resolveTikTokMp4(candidate.url);
        if (r) return r;
        return candidate.media_url || null;
    }
    return candidate.media_url || null;
}

async function downloadFile(url, dest) {
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { /* ignore */ }
    const headers = { 'User-Agent': UA };
    const ref = refererFor(host);
    if (ref) headers.Referer = ref;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
        const r = await fetch(url, { headers, signal: controller.signal });
        if (!r.ok) throw new Error(`download ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length) throw new Error('empty body');
        if (buf.length > MAX_BYTES) throw new Error('source too large to keyframe');
        await fs.writeFile(dest, buf);
        return dest;
    } finally {
        clearTimeout(timer);
    }
}

// Extract a single 9:16 frame at `timeSec` (fast pre-input seek). Returns the
// path on success, null if ffmpeg produced nothing.
function extractFrame(file, timeSec, dest) {
    return new Promise((resolve) => {
        const proc = spawn(ffmpegPath, [
            '-y', '-ss', String(Math.max(0, timeSec)), '-i', file,
            '-frames:v', '1', '-q:v', '3',
            '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
            dest,
        ], { stdio: ['ignore', 'ignore', 'ignore'] });
        proc.on('error', () => resolve(null));
        proc.on('close', async (code) => {
            if (code !== 0) return resolve(null);
            try { await fs.access(dest); resolve(dest); } catch { resolve(null); }
        });
    });
}

// Extract one frame per timestamp (seconds) from the candidate's source video
// and host each on Blob. Returns an array aligned to `timestamps` (null where a
// frame could not be produced), or null when the source isn't keyframe-able.
export async function extractBeatFrames(candidate, timestamps) {
    if (!isKeyframesSupported || !Array.isArray(timestamps) || !timestamps.length) return null;
    const mp4 = await resolveSourceMp4(candidate);
    if (!mp4) return null;

    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'kf-'));
    try {
        const file = path.join(work, 'src.mp4');
        await downloadFile(mp4, file);
        const urls = [];
        for (let i = 0; i < timestamps.length; i++) {
            const out = path.join(work, `f-${i}.jpg`);
            const made = await extractFrame(file, timestamps[i], out);
            if (!made) { urls.push(null); continue; }
            try {
                const buf = await fs.readFile(out);
                urls.push(await fal.uploadPublic(buf, 'image/jpeg', `source-frames/${Date.now()}-${i}.jpg`));
            } catch {
                urls.push(null);
            }
        }
        return urls;
    } catch {
        return null;
    } finally {
        fs.rm(work, { recursive: true, force: true }).catch(() => {});
    }
}
