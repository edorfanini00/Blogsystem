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
import {
    HF_IMAGE_MODELS, HF_IMAGE_ASPECT, HF_IMAGE_REF_PARAM,
} from './config.js';

export const isImageConfigured = isHiggsfieldConfigured;

function slugFor(modelChoice) {
    return HF_IMAGE_MODELS[modelChoice] || HF_IMAGE_MODELS.nano_banana_pro;
}

// Referer the source CDN expects, so server-side fetch of the cover frame is
// not 403'd (same trick the thumbnail proxy uses).
function frameReferer(host) {
    if (/instagram|fbcdn/.test(host)) return 'https://www.instagram.com/';
    if (/tiktok|muscdn|ibyteimg|byteimg|ttwstatic/.test(host)) return 'https://www.tiktok.com/';
    if (/ytimg|ggpht/.test(host)) return 'https://www.youtube.com/';
    return undefined;
}

// Fetch the source frame bytes and upload to Higgsfield; return a public URL.
// Returns null when there is no usable frame.
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
        return await upload(buf, ct);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Generate one shot image. promptOverride lets the QC loop retry with a
// refined prompt. Returns { image_url } | { pending, request_id, status_url }.
export async function generateShotImage(shot, { sourceFrameUrl = null, promptOverride = null } = {}) {
    const application = slugFor(shot.model_choice);
    const args = {
        prompt: promptOverride || shot.image_prompt,
        aspect_ratio: HF_IMAGE_ASPECT,
    };
    // Structural reference when the source composition should be copied. Only
    // attached when a reference param name is configured for the model (the
    // accepted field name varies per model and is set via HF_IMAGE_REF_PARAM).
    if (shot.use_source_frame && sourceFrameUrl && HF_IMAGE_REF_PARAM) {
        args[HF_IMAGE_REF_PARAM] = sourceFrameUrl;
    }
    const out = await subscribe(application, args, { deadlineMs: 70000 });
    if (out.pending) {
        return { pending: true, request_id: out.request_id, status_url: out.status_url, model: application };
    }
    const url = pickImageUrl(out.result);
    if (!url) throw new Error(`${application} completed but no image URL`);
    return { image_url: url, request_id: out.request_id, model: application };
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
    if (!isImageConfigured) throw new Error('Higgsfield not configured. Set HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET.');
    const gen = await loadDirected(generationId);
    if (!gen) throw new Error('Generation not found');
    const shots = Array.isArray(gen.shots) ? gen.shots : (gen.director_json?.shots || []);
    if (!shots.length) throw new Error('No shots to render (run the Director first)');

    await query(`update generations set status = 'imaging' where id = $1`, [generationId]);

    // Upload the source frame once if any shot needs it (only when the model's
    // reference param is configured — otherwise the upload would go unused).
    let sourceFrameUrl = null;
    if (HF_IMAGE_REF_PARAM && shots.some((s) => s.use_source_frame && !s.image_url)) {
        sourceFrameUrl = await uploadSourceFrame(gen.thumbnail);
    }

    let made = 0, pending = 0, failed = 0, rendered = 0;
    for (const shot of shots) {
        if (shot.image_url) continue;
        if (rendered >= max) break;
        rendered++;
        try {
            const out = await generateShotImage(shot, { sourceFrameUrl });
            if (out.pending) {
                shot.image_request_id = out.request_id;
                shot.image_status_url = out.status_url;
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
    return { generationId, total: shots.length, made, pending, failed, status, sourceFrameUsed: !!sourceFrameUrl };
}
