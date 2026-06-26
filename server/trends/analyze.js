// ═══════════════════════════════════════════════════════════════════
// Trend Engine — Deep video analysis (frames + on-screen text + audio)
//
// On demand, we feed the ACTUAL video to a multimodal model (Google Gemini,
// which understands video natively) and get back a structured breakdown:
// the hook, on-screen text, spoken transcript, sound, visual format, pacing,
// why it works, and how CeleriTech could adapt it. The result is stored on
// the candidate and reused by the scorer and the Recreate generator.
//
// Media sourcing per platform:
//   youtube   → Gemini ingests the YouTube URL directly (no download).
//   tiktok/ig → download the playable MP4 captured at ingest and send inline.
//
// Graceful: when GEMINI_API_KEY is absent, isAnalyzeConfigured is false and
// the route returns a clear 503.
// ═══════════════════════════════════════════════════════════════════
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { query } from './db.js';
import * as fal from './fal.js';
import { MESSAGE_BANK } from './config.js';

const GEMINI_KEY = process.env.GEMINI_API_KEY;
export const isAnalyzeConfigured = !!GEMINI_KEY && GEMINI_KEY !== 'placeholder';

// Multimodal understanding models (NOT the -image generation variants), newest
// first. We try each until one accepts the request.
const MODELS = [
    process.env.TREND_ANALYZE_MODEL,
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-flash-latest',
].filter(Boolean);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const MAX_INLINE_BYTES = 18 * 1024 * 1024; // keep request under Gemini inline cap
const DOWNLOAD_TIMEOUT_MS = 30000;
const GEMINI_TIMEOUT_MS = 120000;

const PROMPT = `You are a short-form video analyst. Watch the ENTIRE video — the frames, any on-screen text, and the audio (speech and music) — and return a precise, factual breakdown.

Return ONLY JSON in this exact shape:
{
  "summary": "<2-3 sentences: what happens in the video and why it performs>",
  "hook": "<the first ~3 seconds: exactly what grabs attention (visual + words)>",
  "onScreenText": ["<each distinct text overlay / caption burned into the video, in order>"],
  "transcript": "<the key spoken lines or a close paraphrase of the narration; do NOT copy long verbatim passages; empty string if no speech>",
  "sound": "<describe the audio: voiceover, music genre/mood, trending sound, sfx>",
  "speechType": "<voiceover | on_camera | none — 'voiceover' = an OFF-SCREEN narrator talks over visuals/b-roll; 'on_camera' = a person/character is visibly speaking ON screen (talking head, dialogue, lip movement); 'none' = no speech (music/sfx only)>",
  "voiceProfile": {
    "hasVoiceover": <true if a person narrates/speaks, false if music-only or no speech>,
    "gender": "<male | female | unknown>",
    "age": "<young | adult | older | unknown>",
    "energy": "<calm | moderate | high | hyped>",
    "tone": "<2-4 words: e.g. authoritative, friendly, dramatic, deadpan, hype, soothing>",
    "accent": "<e.g. American, British, neutral, unknown>"
  },
  "visualBreakdown": ["<beat-by-beat: what is shown in each segment>"],
  "durationSeconds": <total length of the video in seconds, as a number — your best estimate from watching it>,
  "clips": [
    { "durationSeconds": <how many seconds THIS distinct shot/cut stays on screen>, "description": "<what is shown in this shot>" }
  ],
  "format": "<e.g. talking head, b-roll montage, text-on-screen explainer, skit, POV, tutorial>",
  "pacing": "<cut speed and rhythm, e.g. 'fast 1-2s cuts' or 'single take'>",
  "whyItWorks": ["<concrete reasons this gets views: hook, relatability, payoff, loop, emotion>"],
  "celeritechAngle": "<how CeleriTech could remake this for its audience and product>",
  "topics": ["<key subjects / themes>"],
  "language": "<spoken/on-screen language>"
}

For "clips": list every distinct shot/cut in chronological order, each with how long it is on screen. The sum of clip durations should roughly equal durationSeconds. This drives an exact-length recreation, so be careful: a 34-second video with six cuts must yield six clips whose durations add up to about 34.

CeleriTech context (for celeritechAngle only):
- Product: ${MESSAGE_BANK.product}
- Buyer: ${MESSAGE_BANK.buyer}

Rules: report only what is actually in the video. If something is absent (no speech, no on-screen text), use an empty string/array. Do not invent.`;

// Download a URL and return it as a Gemini inline part. Sends platform-aware
// headers so CDN hotlink protection doesn't 403 us.
async function downloadInline(url, platform) {
    const headers = {
        'User-Agent': UA,
        Accept: '*/*',
        Range: 'bytes=0-',
    };
    if (platform === 'tiktok') headers.Referer = 'https://www.tiktok.com/';
    if (platform === 'instagram') headers.Referer = 'https://www.instagram.com/';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    let res;
    try {
        res = await fetch(url, { headers, signal: controller.signal });
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') throw new Error('Timed out downloading the video.');
        throw new Error(`download failed: ${err.message}`);
    }
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get('content-type') || 'video/mp4';
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('empty body');
    if (buf.length > MAX_INLINE_BYTES) throw new Error('video too large to analyze inline (over ~18MB)');
    return {
        part: {
            inlineData: {
                mimeType: ct.startsWith('video/') ? ct : 'video/mp4',
                data: buf.toString('base64'),
            },
        },
        buffer: buf,
    };
}

// Measure the exact video duration (seconds) from raw bytes using the bundled
// ffmpeg. Returns null when ffmpeg is unavailable or the probe fails.
async function probeDurationSeconds(buffer) {
    if (!ffmpegPath || !buffer || !buffer.length) return null;
    const tmp = path.join(os.tmpdir(), `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`);
    try {
        await fs.writeFile(tmp, buffer);
        return await new Promise((resolve) => {
            const proc = spawn(ffmpegPath, ['-i', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
            let err = '';
            proc.stderr.on('data', (d) => { err += d.toString(); });
            proc.on('error', () => resolve(null));
            proc.on('close', () => {
                const m = err.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
                if (!m) return resolve(null);
                resolve((+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]));
            });
        });
    } catch {
        return null;
    } finally {
        fs.rm(tmp, { force: true }).catch(() => {});
    }
}

// Extract the source's audio track (its trending sound) to an mp3 and host it on
// Blob, so the remake can ride the original sound as a bed. Returns the URL or
// null (no audio track, ffmpeg/Blob unavailable, etc.).
async function extractSourceAudioUrl(buffer) {
    if (!ffmpegPath || !buffer || !buffer.length || !fal.isFalBlobConfigured) return null;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tmp = path.join(os.tmpdir(), `aud-src-${id}.mp4`);
    const out = path.join(os.tmpdir(), `aud-out-${id}.mp3`);
    try {
        await fs.writeFile(tmp, buffer);
        const ok = await new Promise((resolve) => {
            const proc = spawn(ffmpegPath, ['-y', '-i', tmp, '-vn', '-ac', '2', '-ar', '44100', '-b:a', '128k', out], { stdio: ['ignore', 'ignore', 'ignore'] });
            proc.on('error', () => resolve(false));
            proc.on('close', (code) => resolve(code === 0));
        });
        if (!ok) return null;
        const bytes = await fs.readFile(out).catch(() => null);
        if (!bytes || !bytes.length) return null;
        return await fal.uploadPublic(bytes, 'audio/mpeg', `source-audio/${id}.mp3`);
    } catch {
        return null;
    } finally {
        fs.rm(tmp, { force: true }).catch(() => {});
        fs.rm(out, { force: true }).catch(() => {});
    }
}

// Reconcile the analyzer's timing with the measured duration: scale the per-clip
// durations so they sum to the real length, and record clipCount. When no
// measurement is available we keep the model's estimate.
function reconcileTiming(analysis, measured) {
    let clips = Array.isArray(analysis.clips)
        ? analysis.clips.filter((c) => c && Number(c.durationSeconds) > 0)
        : [];
    if (measured && measured > 0) {
        const sum = clips.reduce((n, c) => n + (Number(c.durationSeconds) || 0), 0);
        if (clips.length && sum > 0) {
            const k = measured / sum;
            clips = clips.map((c) => ({ ...c, durationSeconds: Math.round((Number(c.durationSeconds) || 0) * k * 10) / 10 }));
        }
        analysis.durationSeconds = Math.round(measured * 10) / 10;
        analysis.durationMeasured = true;
    } else {
        analysis.durationSeconds = Number(analysis.durationSeconds) || (clips.reduce((n, c) => n + (Number(c.durationSeconds) || 0), 0) || null);
        analysis.durationMeasured = false;
    }
    analysis.clips = clips;
    analysis.clipCount = clips.length || null;
}

// TikTok playback URLs are cookie-gated and 403 server-side. Resolve a clean,
// downloadable no-watermark MP4 from the post page URL instead.
async function resolveTikTokMp4(pageUrl) {
    const api = `https://www.tikwm.com/api/?hd=1&url=${encodeURIComponent(pageUrl)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    let j;
    try {
        const res = await fetch(api, { headers: { 'User-Agent': UA }, signal: controller.signal });
        j = await res.json();
    } finally {
        clearTimeout(timer);
    }
    const play = j?.data?.hdplay || j?.data?.play || j?.data?.wmplay;
    if (!play) throw new Error('resolver returned no video');
    return play.startsWith('http') ? play : `https://www.tikwm.com${play}`;
}

// Build the media part Gemini should analyze.
async function resolveVideoPart(candidate) {
    if (candidate.platform === 'youtube') {
        // No direct MP4 for YouTube — Gemini ingests the URL, so we cannot probe
        // an exact duration (buffer is null; we fall back to the model estimate).
        return { part: { fileData: { fileUri: candidate.url } }, buffer: null };
    }

    if (candidate.platform === 'tiktok') {
        // Prefer the resolver (reliable, no-watermark); fall back to the stored
        // playback URL if the resolver is down.
        try {
            const mp4 = await resolveTikTokMp4(candidate.url);
            return await downloadInline(mp4, 'tiktok');
        } catch (err) {
            if (candidate.media_url) {
                try { return await downloadInline(candidate.media_url, 'tiktok'); } catch { /* fall through */ }
            }
            throw new Error(`Could not fetch the TikTok video (${err.message}).`);
        }
    }

    // Instagram (and anything else): use the stored CDN URL with referer.
    const mediaUrl = candidate.media_url;
    if (!mediaUrl) {
        throw new Error(
            'No downloadable video link is stored for this post. Re-run ingest to capture it.'
        );
    }
    try {
        return await downloadInline(mediaUrl, candidate.platform);
    } catch (err) {
        throw new Error(
            `Could not download the video (${err.message}). The link may have expired — re-run ingest to refresh it.`
        );
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function parseJsonLoose(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch { /* fall through */ }
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
        try { return JSON.parse(fenced[1]); } catch { /* fall through */ }
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
    }
    return null;
}

async function callGemini(model, videoPart, candidate) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
        GEMINI_KEY
    )}`;
    const contextText = `${PROMPT}\n\nPost context — platform: ${candidate.platform}; caption: ${(
        candidate.caption || ''
    ).slice(0, 300)}`;
    const body = {
        contents: [{ role: 'user', parts: [videoPart, { text: contextText }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 8192, responseMimeType: 'application/json' },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
    if (!res.ok) {
        const errText = await res.text();
        const err = new Error(`Gemini ${model} HTTP ${res.status}: ${errText.slice(0, 200)}`);
        err.status = res.status;
        throw err;
    }
    const data = await res.json();
    const cand = data?.candidates?.[0];
    const finish = cand?.finishReason;
    const parts = cand?.content?.parts || [];
    const text = parts.map((p) => p.text || '').join('').trim();
    if (!text) {
        // Empty output usually means RECITATION/SAFETY blocked the response or
        // the prompt was blocked. Surface it so we can try the next model.
        throw new Error(`Gemini ${model} returned no text (finishReason=${finish || data?.promptFeedback?.blockReason || 'unknown'})`);
    }
    const parsed = parseJsonLoose(text);
    if (!parsed) {
        const reason = finish === 'MAX_TOKENS' ? 'output truncated (MAX_TOKENS)' : `unparseable (finishReason=${finish})`;
        throw new Error(`Gemini ${model} ${reason}`);
    }
    return parsed;
}

// Analyze one candidate and persist the result. Returns the updated row.
export async function analyzeCandidate(candidateId) {
    if (!isAnalyzeConfigured) throw new Error('GEMINI_API_KEY not configured');
    const c = (await query('select * from candidates where id = $1', [candidateId])).rows[0];
    if (!c) throw new Error('Candidate not found');

    const { part: videoPart, buffer } = await resolveVideoPart(c);

    let analysis = null;
    let lastErr = null;
    // Try each model; for transient overload (503/429) retry a few times with
    // backoff before moving on, since Gemini throttles video requests.
    outer:
    for (const model of MODELS) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                analysis = await callGemini(model, videoPart, c);
                analysis.model = model;
                break outer;
            } catch (err) {
                lastErr = err;
                console.error(`analyze [${model}] attempt ${attempt + 1}: ${err.message}`);
                const transient = err.status === 503 || err.status === 429;
                if (transient && attempt < 2) {
                    await sleep(2000 * (attempt + 1));
                    continue;
                }
                break; // non-transient or out of retries → next model
            }
        }
    }
    if (!analysis) throw lastErr || new Error('All analysis models failed');

    // Lock the recreation length to the real video: measure the exact duration
    // from the downloaded bytes when we have them (TikTok/IG), then rescale the
    // per-clip timings to match. YouTube keeps the model's estimate.
    let measured = null;
    try { measured = await probeDurationSeconds(buffer); } catch { measured = null; }
    reconcileTiming(analysis, measured);

    // Capture the source's own audio (trending sound) for reuse as a bed.
    let audioUrl = null;
    try { audioUrl = await extractSourceAudioUrl(buffer); } catch { audioUrl = null; }

    analysis.analyzedAt = new Date().toISOString();
    await query(
        `update candidates set analysis = $1, analyzed_at = now(),
            source_audio_url = coalesce($3, source_audio_url) where id = $2`,
        [JSON.stringify(analysis), candidateId, audioUrl]
    );
    return { ...c, analysis, analyzed_at: analysis.analyzedAt, source_audio_url: audioUrl };
}
