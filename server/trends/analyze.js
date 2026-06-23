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
import { query } from './db.js';
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
  "visualBreakdown": ["<beat-by-beat: what is shown in each segment>"],
  "format": "<e.g. talking head, b-roll montage, text-on-screen explainer, skit, POV, tutorial>",
  "pacing": "<cut speed and rhythm, e.g. 'fast 1-2s cuts' or 'single take'>",
  "whyItWorks": ["<concrete reasons this gets views: hook, relatability, payoff, loop, emotion>"],
  "celeritechAngle": "<how CeleriTech could remake this for its audience and product>",
  "topics": ["<key subjects / themes>"],
  "language": "<spoken/on-screen language>"
}

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
        inlineData: {
            mimeType: ct.startsWith('video/') ? ct : 'video/mp4',
            data: buf.toString('base64'),
        },
    };
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
        return { fileData: { fileUri: candidate.url } };
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

    const videoPart = await resolveVideoPart(c);

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

    analysis.analyzedAt = new Date().toISOString();
    await query('update candidates set analysis = $1, analyzed_at = now() where id = $2', [
        JSON.stringify(analysis),
        candidateId,
    ]);
    return { ...c, analysis, analyzed_at: analysis.analyzedAt };
}
