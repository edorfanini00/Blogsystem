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
  "transcript": "<full spoken transcript; empty string if no speech>",
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

// Build the media part Gemini should analyze.
async function resolveVideoPart(candidate) {
    if (candidate.platform === 'youtube') {
        return { fileData: { fileUri: candidate.url } };
    }
    const mediaUrl = candidate.media_url;
    if (!mediaUrl) {
        throw new Error(
            'No downloadable video link is stored for this post (the scraper did not return one). Re-run ingest to capture it.'
        );
    }
    const headers = { 'User-Agent': UA };
    if (candidate.platform === 'tiktok') headers.Referer = 'https://www.tiktok.com/';
    if (candidate.platform === 'instagram') headers.Referer = 'https://www.instagram.com/';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    let res;
    try {
        res = await fetch(mediaUrl, { headers, signal: controller.signal });
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') throw new Error('Timed out downloading the video.');
        throw new Error(`Could not download the video: ${err.message}`);
    }
    clearTimeout(timer);
    if (!res.ok) {
        throw new Error(
            `Could not download the video (HTTP ${res.status}). The link likely expired — re-run ingest to refresh it.`
        );
    }
    const ct = res.headers.get('content-type') || 'video/mp4';
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('Downloaded video was empty.');
    if (buf.length > MAX_INLINE_BYTES) {
        throw new Error('Video is too large to analyze inline (over ~18MB).');
    }
    return {
        inlineData: {
            mimeType: ct.startsWith('video/') ? ct : 'video/mp4',
            data: buf.toString('base64'),
        },
    };
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
        generationConfig: { temperature: 0.4, maxOutputTokens: 2048, responseMimeType: 'application/json' },
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
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p.text || '').join('').trim();
    const parsed = parseJsonLoose(text);
    if (!parsed) throw new Error(`Gemini ${model} returned unparseable output`);
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
    for (const model of MODELS) {
        try {
            analysis = await callGemini(model, videoPart, c);
            analysis.model = model;
            break;
        } catch (err) {
            lastErr = err;
            // 4xx that isn't rate-limit usually means the model rejected the
            // request shape — try the next model. 5xx/429 also worth a retry.
            console.error(`analyze: ${err.message}`);
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
