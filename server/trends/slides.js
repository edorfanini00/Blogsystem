// ═══════════════════════════════════════════════════════════════════
// Slideshow assembly — the photo-carousel counterpart of the video Assembly.
// Takes the QC-approved stills, burns each slide's on-screen text onto the
// image (the words ARE the content for a carousel), and produces:
//   • slide_urls — the composed slide images, ready to post as a native TikTok/
//     Instagram photo carousel;
//   • asset_url  — a rendered slideshow reel (each slide held a few seconds,
//     optional sound bed) so the post is reviewable inline and can also be
//     posted as a video.
// Reuses the bundled ffmpeg + Vercel Blob, same as the video Assembly.
// ═══════════════════════════════════════════════════════════════════
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { query } from './db.js';
import { SLIDE_SECONDS, MUSIC_URL, MUSIC_GAIN } from './config.js';
import { CAPTION_FONT_PATH, CAPTION_FONT_NAME } from './captions.js';

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
export const isSlidesConfigured = !!BLOB_TOKEN && !!ffmpegPath;

const IMG_W = 1080;
const IMG_H = 1920;

async function uploadAsset(bytes, pathname, contentType) {
    const { put } = await import('@vercel/blob');
    const res = await put(pathname, bytes, {
        access: 'public', contentType, token: BLOB_TOKEN, addRandomSuffix: true,
    });
    return res.url;
}

function ffmpeg(args, { timeoutMs = 120000 } = {}) {
    return new Promise((resolve, reject) => {
        if (!ffmpegPath) return reject(new Error('ffmpeg binary not available'));
        const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, timeoutMs);
        proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
        proc.on('error', (err) => { clearTimeout(timer); reject(err); });
        proc.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`)); });
    });
}

async function download(url, dest) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
        const r = await fetch(url, { signal: controller.signal });
        if (!r.ok) throw new Error(`download ${r.status}`);
        await fs.writeFile(dest, Buffer.from(await r.arrayBuffer()));
        return dest;
    } finally { clearTimeout(timer); }
}

function filterPath(p) { return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'"); }
function assEscape(t) { return String(t).replace(/[{}]/g, '').replace(/\r?\n/g, ' ').trim(); }
function assTime(sec) {
    const s = Math.max(0, sec);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60), cs = Math.round((s - Math.floor(s)) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// One ASS subtitle holding the slide's text in a readable white box (black text,
// "tiktok-bg" pill look), aligned top/middle/bottom. libass wraps within the
// margins, so long lines break cleanly.
function buildSlideAss(text, position) {
    const align = position === 'top' ? 8 : position === 'middle' ? 5 : 2;
    const fontSize = Math.round(IMG_W * 0.06);
    const pad = Math.round(IMG_W * 0.014);
    const marginV = Math.round(IMG_H * 0.13);
    const header = [
        '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${IMG_W}`, `PlayResY: ${IMG_H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        // Black text on an opaque white box (BorderStyle 3). Outline = box padding.
        `Style: Slide,${CAPTION_FONT_NAME},${fontSize},&H00000000,&H000000FF,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,3,${pad},0,${align},120,120,${marginV},1`,
        '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ];
    const ev = `Dialogue: 0,0:00:00.00,9:59:59.00,Slide,,0,0,0,,{\\an${align}}${assEscape(text)}`;
    return header.concat([ev]).join('\n') + '\n';
}

// Compose one slide: scale/crop the still to 1080x1920 and burn its text.
async function composeSlide(srcImg, text, position, dest, work, idx) {
    const vf = ['scale=1080:1920:force_original_aspect_ratio=increase', 'crop=1080:1920', 'format=yuv420p'];
    if (text && text.trim()) {
        const assPath = path.join(work, `slide-${idx}.ass`);
        await fs.writeFile(assPath, buildSlideAss(text, position));
        vf.push(`ass='${filterPath(assPath)}':fontsdir='${filterPath(path.dirname(CAPTION_FONT_PATH))}'`);
    }
    await ffmpeg(['-y', '-i', srcImg, '-vf', vf.join(','), '-frames:v', '1', '-q:v', '3', dest]);
    return dest;
}

// Build a held-still clip (silent stereo audio) from a composed slide image.
async function slideClip(composedImg, seconds, dest) {
    await ffmpeg([
        '-y', '-loop', '1', '-t', String(seconds), '-i', composedImg,
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-map', '0:v:0', '-map', '1:a:0',
        '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-shortest', dest,
    ]);
    return dest;
}

async function loadGen(generationId) {
    const { rows } = await query(
        `select g.*, c.platform, c.source_audio_url
         from generations g join candidates c on c.id = g.candidate_id where g.id = $1`,
        [generationId]
    );
    return rows[0] || null;
}

// Compose the slideshow. Requires every shot to have an image. Produces the
// slide image set + a rendered reel, advances the generation to 'review'.
export async function runSlides(generationId) {
    if (!BLOB_TOKEN) throw new Error('BLOB_READ_WRITE_TOKEN not configured (needed to host slides).');
    if (!ffmpegPath) throw new Error('ffmpeg not available on this runtime.');
    const gen = await loadGen(generationId);
    if (!gen) throw new Error('Generation not found');
    const shots = (Array.isArray(gen.shots) ? gen.shots : []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const withImg = shots.filter((s) => s.image_url);
    if (!withImg.length) throw new Error('No slide images to compose (run the Image agent first)');
    if (withImg.length < shots.length) throw new Error(`Only ${withImg.length}/${shots.length} slides have images; finish the Image agent first.`);

    await query(`update generations set status = 'composing' where id = $1`, [generationId]);

    const work = await fs.mkdtemp(path.join(os.tmpdir(), `slides-${generationId.slice(0, 8)}-`));
    try {
        // 1. Compose + host each slide (text burned in).
        const slideUrls = [];
        const composedPaths = [];
        for (let i = 0; i < withImg.length; i++) {
            const raw = path.join(work, `raw-${i}.jpg`);
            await download(withImg[i].image_url, raw);
            const composed = path.join(work, `slide-${i}.jpg`);
            await composeSlide(raw, withImg[i].on_screen_text, withImg[i].text_position || 'bottom', composed, work, i);
            composedPaths.push(composed);
            const url = await uploadAsset(await fs.readFile(composed), `slideshows/${generationId}-${i}.jpg`, 'image/jpeg');
            slideUrls.push({ url, text: withImg[i].on_screen_text || '', text_position: withImg[i].text_position || 'bottom' });
        }

        // 2. Render the reel: each slide held SLIDE_SECONDS, concatenated.
        const clips = [];
        for (let i = 0; i < composedPaths.length; i++) {
            const clip = path.join(work, `clip-${i}.mp4`);
            await slideClip(composedPaths[i], SLIDE_SECONDS, clip);
            clips.push(clip);
        }
        const listPath = path.join(work, 'list.txt');
        await fs.writeFile(listPath, clips.map((p) => `file '${p}'`).join('\n'));
        const concatPath = path.join(work, 'concat.mp4');
        await ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', concatPath]);

        // 3. Optional sound bed: the source's own audio (trending sound) or the
        //    configured music. Ducked to a comfortable level under the slides.
        const totalLen = Math.round(SLIDE_SECONDS * composedPaths.length * 10) / 10;
        const soundUrl = gen.source_audio_url || MUSIC_URL || '';
        const finalPath = path.join(work, 'final.mp4');
        let music = false;
        if (soundUrl) {
            try {
                const musicPath = await download(soundUrl, path.join(work, 'bed.mp3'));
                await ffmpeg([
                    '-y', '-i', concatPath, '-i', musicPath,
                    '-filter_complex', `[1:a]aresample=44100,volume=${Math.max(MUSIC_GAIN, 0.6)}[a]`,
                    '-map', '0:v:0', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', '-ac', '2',
                    '-t', String(totalLen), '-shortest', finalPath,
                ]);
                music = true;
            } catch { music = false; }
        }
        if (!music) await fs.copyFile(concatPath, finalPath);

        const assetUrl = await uploadAsset(await fs.readFile(finalPath), `slideshows/${generationId}.mp4`, 'video/mp4');

        const upd = await query(
            `update generations set status = 'review', asset_url = $2, slide_urls = $3 where id = $1 returning *`,
            [generationId, assetUrl, JSON.stringify(slideUrls)]
        );
        return {
            generationId, status: 'review', asset_url: assetUrl, slides: slideUrls.length,
            slide_urls: slideUrls, music, lengthSeconds: totalLen, generation: upd.rows[0],
        };
    } finally {
        fs.rm(work, { recursive: true, force: true }).catch(() => {});
    }
}
