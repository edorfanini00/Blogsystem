// ═══════════════════════════════════════════════════════════════════
// Video Generation — Assembly agent (spec §11)
// Stitches the per-shot clips into one vertical (1080x1920) cut, lays the
// ElevenLabs voiceover over it, and caps the runtime to the target window.
// On-screen text is already baked into the generated stills (the Director
// writes it into the image prompts), so Assembly does not burn captions — it
// only concatenates, normalizes, and adds the VO. The result is uploaded to
// Higgsfield file storage (already configured) and recorded as asset_url, and
// the generation advances to 'review'.
//
// ffmpeg runs from the bundled ffmpeg-static binary, writing to the serverless
// /tmp scratch space. If ffmpeg is unavailable or fails, the chain degrades
// gracefully: the ordered clip URLs remain on the shots for manual assembly.
// ═══════════════════════════════════════════════════════════════════
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { query } from './db.js';
import { VIDEO_TARGET_MAX, MUSIC_URL, MUSIC_GAIN, MATCH_SOURCE_LENGTH } from './config.js';
import {
    synthVoiceoverTimed, cuesFromAlignment, buildAss,
    CAPTION_FONT_PATH, isCaptionsConfigured,
} from './captions.js';

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
// The final asset (and VO) are hosted on Vercel Blob — Higgsfield file storage
// only accepts image content types, not video/mp4.
export const isAssemblyConfigured = !!BLOB_TOKEN && !!ffmpegPath;
export const isVoiceoverConfigured = !!ELEVENLABS_KEY;

// Upload bytes to Vercel Blob and return the public URL.
async function uploadAsset(bytes, pathname, contentType) {
    const { put } = await import('@vercel/blob');
    const res = await put(pathname, bytes, {
        access: 'public',
        contentType,
        token: BLOB_TOKEN,
        addRandomSuffix: true,
    });
    return res.url;
}

function ffmpeg(args, { timeoutMs = 180000 } = {}) {
    return new Promise((resolve, reject) => {
        if (!ffmpegPath) return reject(new Error('ffmpeg binary not available (ffmpeg-static missing)'));
        const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, timeoutMs);
        proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
        proc.on('error', (err) => { clearTimeout(timer); reject(err); });
        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
        });
    });
}

async function download(url, dest) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
        const r = await fetch(url, { signal: controller.signal });
        if (!r.ok) throw new Error(`download ${r.status} for ${url.slice(0, 80)}`);
        const buf = Buffer.from(await r.arrayBuffer());
        await fs.writeFile(dest, buf);
        return dest;
    } finally {
        clearTimeout(timer);
    }
}

// Escape a path for use inside an ffmpeg filtergraph argument.
function filterPath(p) {
    return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

// Build the final-mux ffmpeg args: optional burned captions (re-encode) and an
// optional ducked music bed under the VO. Falls back to stream-copy when there
// is nothing to overlay (fastest path).
function finalArgs({ concatPath, voPath, musicPath, assPath, finalPath, maxLen }) {
    const inputs = ['-i', concatPath];
    const voIdx = voPath ? 1 : null;
    const musIdx = musicPath ? (voPath ? 2 : 1) : null;
    if (voPath) inputs.push('-i', voPath);
    if (musicPath) inputs.push('-i', musicPath);

    const filters = [];
    let vmap = '0:v:0';
    if (assPath) {
        filters.push(`[0:v]ass='${filterPath(assPath)}':fontsdir='${filterPath(path.dirname(CAPTION_FONT_PATH))}'[v]`);
        vmap = '[v]';
    }

    let amap;
    if (voIdx != null && musIdx != null) {
        // Split the VO: one copy keys the sidechain duck, the other is mixed in.
        // (An ffmpeg filter output pad can only feed a single input.)
        filters.push(`[${voIdx}:a]aresample=44100,asplit=2[vo1][vo2]`);
        filters.push(`[${musIdx}:a]aresample=44100,volume=${MUSIC_GAIN}[mus]`);
        filters.push('[mus][vo1]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=250[duck]');
        filters.push('[duck][vo2]amix=inputs=2:duration=longest:normalize=0[aout]');
        amap = '[aout]';
    } else if (voIdx != null) {
        amap = `${voIdx}:a:0`;
    } else if (musIdx != null) {
        filters.push(`[${musIdx}:a]aresample=44100[aout]`);
        amap = '[aout]';
    } else {
        amap = '0:a:0';
    }

    const args = ['-y', ...inputs];
    if (filters.length) args.push('-filter_complex', filters.join(';'));
    args.push('-map', vmap, '-map', amap);
    if (assPath) args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
    else args.push('-c:v', 'copy');
    args.push('-c:a', 'aac', '-ar', '44100', '-ac', '2', '-t', String(maxLen), finalPath);
    return args;
}

// Normalize one clip to a uniform 9:16 / 30fps / h264+aac file so the concat
// demuxer can stream-copy them together. A silent stereo track is added so
// every segment has audio (required for clean concat) before the VO overlay.
// When `trimTo` (seconds) is set, the clip is cut to that length so the
// assembled cut reproduces the source's per-shot pacing and total runtime.
async function normalizeClip(src, dest, trimTo = null) {
    const args = ['-y', '-i', src,
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-map', '0:v:0', '-map', '1:a:0',
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-ar', '44100', '-ac', '2'];
    if (trimTo && trimTo > 0) args.push('-t', String(trimTo));
    else args.push('-shortest');
    args.push(dest);
    await ffmpeg(args);
    return dest;
}

async function loadGen(generationId) {
    const { rows } = await query(
        `select g.*, c.platform from generations g join candidates c on c.id = g.candidate_id where g.id = $1`,
        [generationId]
    );
    return rows[0] || null;
}

// Assemble the final cut. Requires every shot to have a video_url. Returns
// { asset_url, vo_url, status:'review', durationCappedAt }.
export async function runAssembly(generationId) {
    if (!BLOB_TOKEN) throw new Error('BLOB_READ_WRITE_TOKEN not configured (needed to host the final video).');
    if (!ffmpegPath) throw new Error('ffmpeg not available on this runtime.');
    const gen = await loadGen(generationId);
    if (!gen) throw new Error('Generation not found');
    const shots = (Array.isArray(gen.shots) ? gen.shots : [])
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const clips = shots.filter((s) => s.video_url);
    if (!clips.length) throw new Error('No animated clips to assemble (run the Video agent first)');
    if (clips.length < shots.length) {
        throw new Error(`Only ${clips.length}/${shots.length} shots are animated; finish the Video agent first.`);
    }

    await query(`update generations set status = 'assembling' where id = $1`, [generationId]);

    // Length replication: trim each clip to its Director-assigned target so the
    // assembled total matches the source video's runtime. Falls back to the
    // fixed window when targets are absent or the feature is off.
    const hasTargets = MATCH_SOURCE_LENGTH && clips.some((s) => Number(s.target_duration) > 0);
    const totalTarget = hasTargets
        ? Math.round(clips.reduce((n, s) => n + (Number(s.target_duration) || 0), 0) * 10) / 10
        : null;
    const finalCap = (hasTargets && totalTarget > 0)
        ? totalTarget
        : (Number(gen.director_json?.target_duration_total) || VIDEO_TARGET_MAX);

    const work = await fs.mkdtemp(path.join(os.tmpdir(), `asm-${generationId.slice(0, 8)}-`));
    try {
        // 1. Download + normalize (and length-trim) every clip in order.
        const normalized = [];
        for (let i = 0; i < clips.length; i++) {
            const raw = path.join(work, `raw-${i}.mp4`);
            await download(clips[i].video_url, raw);
            const norm = path.join(work, `norm-${i}.mp4`);
            const trimTo = hasTargets ? (Number(clips[i].target_duration) || null) : null;
            await normalizeClip(raw, norm, trimTo);
            normalized.push(norm);
        }

        // 2. Concat (stream copy — all segments share codec/params now).
        const listPath = path.join(work, 'list.txt');
        await fs.writeFile(listPath, normalized.map((p) => `file '${p}'`).join('\n'));
        const concatPath = path.join(work, 'concat.mp4');
        await ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', concatPath]);

        // 3. Voiceover (timestamped) → caption cues, optional music bed.
        const voText = gen.copy_json?.voiceover || gen.script || '';
        const finalPath = path.join(work, 'final.mp4');
        let voPath = null, alignment = null, voUrl = null, assPath = null, captionCount = 0;
        try {
            const vo = await synthVoiceoverTimed(voText, path.join(work, 'vo.mp3'));
            if (vo) { voPath = vo.path; alignment = vo.alignment; }
        } catch {
            voPath = null; // VO failure should not block the silent cut
        }

        // Burned captions from the VO alignment (skip gracefully if disabled or
        // the API returned no timing).
        if (voPath && isCaptionsConfigured && alignment) {
            const cues = cuesFromAlignment(alignment);
            if (cues.length) {
                assPath = path.join(work, 'captions.ass');
                await fs.writeFile(assPath, buildAss(cues));
                captionCount = cues.length;
            }
        }

        // Optional music bed (per-generation override → env default).
        let musicPath = null;
        const musicUrl = gen.copy_json?.music_url || MUSIC_URL;
        if (musicUrl) {
            try { musicPath = await download(musicUrl, path.join(work, 'music.mp3')); }
            catch { musicPath = null; }
        }

        await ffmpeg(finalArgs({ concatPath, voPath, musicPath, assPath, finalPath, maxLen: finalCap }), { timeoutMs: 200000 });

        if (voPath) {
            try { voUrl = await uploadAsset(await fs.readFile(voPath), `remakes/${generationId}-vo.mp3`, 'audio/mpeg'); }
            catch { /* non-fatal */ }
        }

        // 4. Host the final cut and record it.
        const finalBytes = await fs.readFile(finalPath);
        const assetUrl = await uploadAsset(finalBytes, `remakes/${generationId}.mp4`, 'video/mp4');

        const upd = await query(
            `update generations set status = 'review', asset_url = $2, vo_url = $3 where id = $1 returning *`,
            [generationId, assetUrl, voUrl]
        );
        return {
            generationId,
            status: 'review',
            asset_url: assetUrl,
            vo_url: voUrl,
            clips: clips.length,
            voiceover: !!voPath,
            captions: captionCount,
            music: !!musicPath,
            cappedAt: finalCap,
            matchedSourceLength: hasTargets,
            generation: upd.rows[0],
        };
    } finally {
        // Best-effort scratch cleanup.
        fs.rm(work, { recursive: true, force: true }).catch(() => {});
    }
}
