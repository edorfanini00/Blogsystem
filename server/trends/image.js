// ═══════════════════════════════════════════════════════════════════
// Video Generation — Image agent (spec §6)
// Image-first is mandatory: every shot becomes a still before it is ever
// animated. Calls Higgsfield with the shot's model_choice and 4-layer prompt.
// When use_source_frame is true, the source video's representative frame is
// uploaded and passed as a structural reference so the composition is copied
// and only the subject/context are swapped (the "replace the characters"
// workflow).
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';
import {
    isHiggsfieldConfigured, subscribe, upload, pickImageUrl,
} from './higgsfield.js';
import * as fal from './fal.js';
import { extractBeatFrames, isKeyframesSupported } from './keyframes.js';
import {
    HF_IMAGE_MODELS, HF_IMAGE_ASPECT, HF_IMAGE_REF_PARAM, MAX_IMAGE_RENDERS,
    IMAGE_PROVIDER, FAL_IMAGE_MODELS,
} from './config.js';

const USE_FAL = IMAGE_PROVIDER === 'fal';

// Total image generations a generation has consumed (stills + QC regens), used
// to enforce the cost ceiling.
export function imageRendersSpent(shots) {
    return (shots || []).reduce((n, s) => n + ((s.image_url || s.image_error) ? 1 : 0) + (s.regens || 0), 0);
}

export const isImageConfigured = USE_FAL ? fal.isFalConfigured : isHiggsfieldConfigured;

// A still is "kept" only if it lives in our permanent Blob storage. Provider
// URLs (fal.media / Higgsfield) are temporary and expire — those count as
// needing a (re)render so old broken stills can be repaired in place.
export function isPersistedImage(url) {
    return typeof url === 'string' && url.includes('blob.vercel-storage.com');
}
// Source-frame composition is available on fal (image-to-image /edit slugs) as
// long as we can host the frame on Vercel Blob. On Higgsfield it depends on a
// configured reference param (HF_IMAGE_REF_PARAM).
export const isSourceFrameSupported = USE_FAL ? fal.isFalBlobConfigured : !!HF_IMAGE_REF_PARAM;

function slugFor(modelChoice) {
    return HF_IMAGE_MODELS[modelChoice] || HF_IMAGE_MODELS.nano_banana_pro;
}

function falLaneFor(modelChoice) {
    return FAL_IMAGE_MODELS[modelChoice] || FAL_IMAGE_MODELS.nano_banana_pro;
}

// Build the fal input for a shot. nano-banana family uses aspect_ratio; seedream
// uses an explicit image_size. /edit lanes take image_urls (the source frame).
function falInput(modelChoice, { prompt, sourceFrameUrl, edit }) {
    const isSeedream = modelChoice === 'seedream';
    const input = isSeedream
        ? { prompt, image_size: { width: 1080, height: 1920 }, num_images: 1 }
        : { prompt, aspect_ratio: '9:16', resolution: '2K', num_images: 1 };
    if (edit && sourceFrameUrl) input.image_urls = [sourceFrameUrl];
    return input;
}

// Referer the source CDN expects, so server-side fetch of the cover frame is
// not 403'd (same trick the thumbnail proxy uses).
function frameReferer(host) {
    if (/instagram|fbcdn/.test(host)) return 'https://www.instagram.com/';
    if (/tiktok|muscdn|ibyteimg|byteimg|ttwstatic/.test(host)) return 'https://www.tiktok.com/';
    if (/ytimg|ggpht/.test(host)) return 'https://www.youtube.com/';
    return undefined;
}

// Fetch the source frame bytes (with the CDN-appropriate Referer so the fetch
// is not 403'd) and host them on a public URL the image provider can read:
// Vercel Blob for fal, Higgsfield file storage for Higgsfield. Returns null
// when there is no usable frame.
async function uploadSourceFrame(thumbUrl) {
    if (!thumbUrl) return null;
    let host = '';
    try { host = new URL(thumbUrl).hostname.toLowerCase(); } catch { return null; }
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
    };
    const ref = frameReferer(host);
    if (ref) headers.Referer = ref;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const r = await fetch(thumbUrl, { headers, signal: controller.signal });
        if (!r.ok) return null;
        const ct = r.headers.get('content-type') || 'image/jpeg';
        if (!ct.startsWith('image/')) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        if (USE_FAL) {
            const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
            return await fal.uploadPublic(buf, ct, `source-frames/${Date.now()}.${ext}`);
        }
        return await upload(buf, ct);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// When we copy the source frame for COMPOSITION in a non-exact remake, the
// image /edit lane tends to preserve the original person's identity. This
// directive forces a different individual so we don't ship a near-duplicate of
// the source (which platforms penalize). Composition/framing/lighting are kept.
const REPLACE_PERSON_DIRECTIVE =
    ' IMPORTANT: Use the reference image ONLY for composition, framing, camera angle and lighting. '
    + 'Replace any person with a COMPLETELY DIFFERENT individual — different face, age, ethnicity, '
    + 'hair, body type and clothing. Do NOT reproduce the person from the reference.';

// Generate one shot image. promptOverride lets the QC loop retry with a
// refined prompt. replacePerson appends the identity-swap directive when a
// non-exact remake reuses the source frame for composition.
// Copy a provider image URL into permanent Blob storage so it never expires.
// fal.media / Higgsfield URLs are temporary — without this, older queue items
// (and the source frames fed into animation) break once the link lapses, which
// shows up as broken-image triangles in the grid. Best-effort: returns the
// original URL when Blob isn't configured or the copy fails.
async function persistImage(url) {
    if (!url || !fal.isFalBlobConfigured) return url;
    try {
        const res = await fetch(url);
        if (!res.ok) return url;
        const buf = Buffer.from(await res.arrayBuffer());
        const ct = res.headers.get('content-type') || 'image/jpeg';
        const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
        return await fal.uploadPublic(buf, ct, `shots/shot-${Date.now()}.${ext}`);
    } catch {
        return url;
    }
}

// Returns { image_url } | { pending, request_id, status_url }.
export async function generateShotImage(shot, { sourceFrameUrl = null, promptOverride = null, replacePerson = false } = {}) {
    const wantsFrame = !!(shot.use_source_frame && sourceFrameUrl);
    let prompt = promptOverride || shot.image_prompt;
    if (wantsFrame && replacePerson) prompt = `${prompt}${REPLACE_PERSON_DIRECTIVE}`;

    if (USE_FAL) {
        const lane = falLaneFor(shot.model_choice);
        const model = wantsFrame ? lane.edit : lane.t2i;
        const input = falInput(shot.model_choice, { prompt, sourceFrameUrl, edit: wantsFrame });
        const out = await fal.subscribe(model, input, { deadlineMs: 70000 });
        if (out.pending) {
            return {
                pending: true, request_id: out.request_id,
                status_url: out.status_url, response_url: out.response_url, model,
            };
        }
        const url = fal.pickImageUrl(out.result);
        if (!url) throw new Error(`${model} completed but no image URL`);
        return { image_url: await persistImage(url), request_id: out.request_id, model };
    }

    // Higgsfield fallback.
    const application = slugFor(shot.model_choice);
    const args = {
        prompt,
        aspect_ratio: HF_IMAGE_ASPECT,
    };
    if (wantsFrame && HF_IMAGE_REF_PARAM) {
        args[HF_IMAGE_REF_PARAM] = sourceFrameUrl;
    }
    const out = await subscribe(application, args, { deadlineMs: 70000 });
    if (out.pending) {
        return { pending: true, request_id: out.request_id, status_url: out.status_url, model: application };
    }
    const url = pickImageUrl(out.result);
    if (!url) throw new Error(`${application} completed but no image URL`);
    return { image_url: await persistImage(url), request_id: out.request_id, model: application };
}

async function loadDirected(generationId) {
    const { rows } = await query(
        `select g.*, c.thumbnail, c.media_url, c.url as source_url, c.platform
         from generations g join candidates c on c.id = g.candidate_id
         where g.id = $1`,
        [generationId]
    );
    return rows[0] || null;
}

// Midpoint timestamp (seconds) of each shot, from the Director's per-shot
// target_duration (falls back to 3s/beat). Used to pull the matching source
// frame for that beat.
function beatTimestamps(shots) {
    let t = 0;
    return shots.map((s) => {
        const d = Number(s.target_duration) > 0 ? Number(s.target_duration) : 3;
        const mid = Math.round((t + d / 2) * 10) / 10;
        t += d;
        return mid;
    });
}

// Pull a per-beat source frame for each shot that wants one and host it, so the
// image /edit lane carries the source composition beat-by-beat. Runs at most
// once per generation (marks shots tried). Best-effort: on any failure the
// single cover thumbnail remains the fallback. Mutates shots in place.
async function ensureBeatFrames(gen, shots) {
    if (!isSourceFrameSupported || !isKeyframesSupported) return;
    const wants = shots.filter((s) => s.use_source_frame && !s.image_url && !s.source_frame_url && !s.source_frame_tried);
    if (!wants.length) return;
    const candidate = { platform: gen.platform, url: gen.source_url, media_url: gen.media_url };
    let frames = null;
    try { frames = await extractBeatFrames(candidate, beatTimestamps(shots)); } catch { frames = null; }
    shots.forEach((s, i) => {
        s.source_frame_tried = true;
        if (frames && frames[i] && s.use_source_frame && !s.source_frame_url) s.source_frame_url = frames[i];
    });
}

async function saveShots(generationId, shots, status) {
    await query(
        `update generations set shots = $2, status = $3 where id = $1`,
        [generationId, JSON.stringify(shots), status]
    );
}

// Render images for every shot of a directed generation that does not have one
// yet. Idempotent: re-running only fills gaps. Leaves status at 'qc' when all
// shots have images, 'imaging' if some are still pending (resume later).
export async function runImages(generationId, { max = Infinity } = {}) {
    if (!isImageConfigured) {
        throw new Error(USE_FAL
            ? 'fal not configured. Set FAL_KEY.'
            : 'Higgsfield not configured. Set HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET.');
    }
    const gen = await loadDirected(generationId);
    if (!gen) throw new Error('Generation not found');
    const shots = Array.isArray(gen.shots) ? gen.shots : (gen.director_json?.shots || []);
    if (!shots.length) throw new Error('No shots to render (run the Director first)');

    // Exact recreations intentionally reproduce the source; everything else must
    // swap the person so we don't post a near-duplicate (algorithm penalty).
    const replacePerson = gen.target_mode !== 'exact';

    await query(`update generations set status = 'imaging' where id = $1`, [generationId]);

    // Per-beat source frames (TikTok/IG): one extracted frame per shot so each
    // still copies the matching source composition. Best-effort, runs once.
    await ensureBeatFrames(gen, shots);

    // Cover-thumbnail fallback, uploaded once, used for any shot that wants a
    // source frame but didn't get a per-beat one (e.g. YouTube, or extraction
    // failed).
    let thumbFrameUrl = null;
    if (isSourceFrameSupported && shots.some((s) => s.use_source_frame && !s.image_url && !s.source_frame_url)) {
        thumbFrameUrl = await uploadSourceFrame(gen.thumbnail);
    }

    let made = 0, pending = 0, failed = 0, rendered = 0, capped = false;
    for (const shot of shots) {
        // Skip shots that already have a PERMANENT still. A temporary provider
        // URL (expired/broken) is re-rendered so the grid repairs itself.
        if (shot.image_url && isPersistedImage(shot.image_url)) continue;
        if (shot.image_url && !isPersistedImage(shot.image_url)) {
            // Drop the stale provider URL so this shot regenerates + persists.
            shot.image_url = null;
            shot.image_error = null;
        }
        if (rendered >= max) break;
        if (MAX_IMAGE_RENDERS && imageRendersSpent(shots) >= MAX_IMAGE_RENDERS) { capped = true; break; }
        rendered++;
        try {
            const sourceFrameUrl = shot.source_frame_url || thumbFrameUrl;
            const out = await generateShotImage(shot, { sourceFrameUrl, replacePerson });
            if (out.pending) {
                shot.image_request_id = out.request_id;
                shot.image_status_url = out.status_url;
                shot.image_response_url = out.response_url || null;
                shot.image_model = out.model;
                pending++;
            } else {
                shot.image_url = out.image_url;
                shot.image_model = out.model;
                shot.image_request_id = out.request_id;
                pending = pending; made++;
            }
        } catch (err) {
            shot.image_error = err.message;
            failed++;
        }
        await saveShots(generationId, shots, 'imaging');
    }

    const allDone = shots.every((s) => s.image_url);
    const status = allDone ? 'qc' : 'imaging';
    await saveShots(generationId, shots, status);
    const beatFrames = shots.filter((s) => s.source_frame_url).length;
    return {
        generationId, total: shots.length, made, pending, failed, status, capped,
        beatFrames, sourceFrameUsed: beatFrames > 0 || !!thumbFrameUrl,
    };
}
