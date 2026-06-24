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
import { isHiggsfieldConfigured, upload } from './higgsfield.js';
import {
    VIDEO_TARGET_MAX, ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL,
} from './config.js';

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
export const isAssemblyConfigured = isHiggsfieldConfigured && !!ffmpegPath;
export const isVoiceoverConfigured = !!ELEVENLABS_KEY;

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

// Synthesize the voiceover with ElevenLabs → mp3 file on disk. Returns the path
// or null when not configured / no text.
async function synthVoiceover(text, dest) {
    if (!ELEVENLABS_KEY || !text || !text.trim()) return null;
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
        method: 'POST',
        headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({
            text,
            model_id: ELEVENLABS_MODEL,
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
    });
    if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`ElevenLabs ${r.status}: ${body.slice(0, 160)}`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    await fs.writeFile(dest, buf);
    return dest;
}

// Normalize one clip to a uniform 9:16 / 30fps / h264+aac file so the concat
// demuxer can stream-copy them together. A silent stereo track is added so
// every segment has audio (required for clean concat) before the VO overlay.
async function normalizeClip(src, dest) {
    await ffmpeg([
        '-y',
        '-i', src,
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-map', '0:v:0', '-map', '1:a:0',
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-ar', '44100', '-ac', '2',
        '-shortest',
        dest,
    ]);
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
    if (!isHiggsfieldConfigured) throw new Error('Higgsfield not configured (needed to host the final asset).');
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

    const work = await fs.mkdtemp(path.join(os.tmpdir(), `asm-${generationId.slice(0, 8)}-`));
    try {
        // 1. Download + normalize every clip in order.
        const normalized = [];
        for (let i = 0; i < clips.length; i++) {
            const raw = path.join(work, `raw-${i}.mp4`);
            await download(clips[i].video_url, raw);
            const norm = path.join(work, `norm-${i}.mp4`);
            await normalizeClip(raw, norm);
            normalized.push(norm);
        }

        // 2. Concat (stream copy — all segments share codec/params now).
        const listPath = path.join(work, 'list.txt');
        await fs.writeFile(listPath, normalized.map((p) => `file '${p}'`).join('\n'));
        const concatPath = path.join(work, 'concat.mp4');
        await ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', concatPath]);

        // 3. Voiceover (optional) + final mux, capped to the target max length.
        const voText = gen.copy_json?.voiceover || gen.script || '';
        let voUrl = null;
        let finalPath = path.join(work, 'final.mp4');
        let voPath = null;
        try {
            voPath = await synthVoiceover(voText, path.join(work, 'vo.mp3'));
        } catch (err) {
            voPath = null; // VO failure should not block the silent cut
        }

        if (voPath) {
            await ffmpeg([
                '-y',
                '-i', concatPath,
                '-i', voPath,
                '-map', '0:v:0', '-map', '1:a:0',
                '-c:v', 'copy', '-c:a', 'aac',
                '-t', String(VIDEO_TARGET_MAX),
                finalPath,
            ]);
            try {
                const voBytes = await fs.readFile(voPath);
                voUrl = await upload(voBytes, 'audio/mpeg');
            } catch { /* non-fatal: VO hosting is a nicety */ }
        } else {
            await ffmpeg(['-y', '-i', concatPath, '-t', String(VIDEO_TARGET_MAX), '-c', 'copy', finalPath]);
        }

        // 4. Host the final cut and record it.
        const finalBytes = await fs.readFile(finalPath);
        const assetUrl = await upload(finalBytes, 'video/mp4');

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
            cappedAt: VIDEO_TARGET_MAX,
            generation: upd.rows[0],
        };
    } finally {
        // Best-effort scratch cleanup.
        fs.rm(work, { recursive: true, force: true }).catch(() => {});
    }
}
