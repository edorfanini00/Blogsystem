// ═══════════════════════════════════════════════════════════════════
// Higgsfield API client (image + video generation)
// Reverse-engineered from the official SDK (higgsfield-ai/higgsfield-client):
//   • base:   https://platform.higgsfield.ai
//   • auth:   Authorization: Key <apikey:apisecret>
//   • submit: POST /{application}              → { request_id, status_url, cancel_url }
//   • status: GET  {status_url}                → { status: queued|in_progress|completed|failed|nsfw|canceled, ... }
//             (the status endpoint also returns the result payload on completion)
//   • upload: POST /files/generate-upload-url  → { public_url, upload_url }; then PUT bytes to upload_url
//
// Application slugs come from the CLI catalog (job_set_type), e.g. nano_banana_2,
// seedream_v4_5, grok_image, kling3_0. They are config-driven so they can be
// corrected via env without a code change.
// ═══════════════════════════════════════════════════════════════════

const BASE = (process.env.HIGGSFIELD_BASE_URL || 'https://platform.higgsfield.ai').replace(/\/$/, '');

// Accept either a combined "key:secret" or separate key + secret.
function credential() {
    const combined = process.env.HIGGSFIELD_KEY || process.env.HF_KEY;
    if (combined) return combined;
    const key = process.env.HIGGSFIELD_API_KEY || process.env.HF_API_KEY;
    const secret = process.env.HIGGSFIELD_API_SECRET || process.env.HF_API_SECRET;
    if (key && secret) return `${key}:${secret}`;
    return null;
}

export const isHiggsfieldConfigured = !!credential();

function authHeaders() {
    const cred = credential();
    if (!cred) throw new Error('Higgsfield credentials missing. Set HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET (or HIGGSFIELD_KEY="key:secret").');
    return { Authorization: `Key ${cred}`, 'Content-Type': 'application/json' };
}

const DONE = ['completed', 'failed', 'nsfw', 'canceled', 'cancelled'];

// Submit a generation. Returns { request_id, status_url, cancel_url }.
export async function submit(application, args) {
    const res = await fetch(`${BASE}/${application}`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(args),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`Higgsfield submit non-JSON (${res.status}): ${text.slice(0, 200)}`); }
    if (!res.ok) throw new Error(`Higgsfield submit ${res.status}: ${text.slice(0, 240)}`);
    // Response shape varies by endpoint family: the flux application slugs return
    // { request_id, status_url }, while the v1 endpoints (e.g. image2video/dop)
    // return { id, ... }. Normalize to request_id + status_url so callers and the
    // poller work for both.
    const request_id = data.request_id || data.id;
    let status_url = data.status_url || (request_id ? `${BASE}/requests/${request_id}/status` : null);
    if (!status_url || !request_id) throw new Error(`Higgsfield submit missing ids: ${text.slice(0, 200)}`);
    return { ...data, request_id, status_url };
}

export async function getStatus(statusUrl) {
    const res = await fetch(statusUrl, { headers: authHeaders() });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`Higgsfield status non-JSON (${res.status}): ${text.slice(0, 200)}`); }
    if (!res.ok) throw new Error(`Higgsfield status ${res.status}: ${text.slice(0, 200)}`);
    return data;
}

// Submit then poll to completion within a deadline. If the deadline passes
// before completion, returns { pending: true, request_id, status_url } so the
// caller can resume later (keeps us under serverless time limits).
export async function subscribe(application, args, { deadlineMs = 75000, pollMs = 2500 } = {}) {
    const submitted = await submit(application, args);
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
        await new Promise((r) => setTimeout(r, pollMs));
        let s;
        try { s = await getStatus(submitted.status_url); } catch { continue; }
        const status = String(s.status || '').toLowerCase();
        if (status === 'completed') return { done: true, result: s, request_id: submitted.request_id };
        if (DONE.includes(status)) throw new Error(`Higgsfield ${application} ${status}: ${JSON.stringify(s).slice(0, 200)}`);
    }
    return { pending: true, request_id: submitted.request_id, status_url: submitted.status_url };
}

// Resume polling an already-submitted request.
export async function poll(statusUrl, { deadlineMs = 75000, pollMs = 2500 } = {}) {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
        let s;
        try { s = await getStatus(statusUrl); } catch { await new Promise((r) => setTimeout(r, pollMs)); continue; }
        const status = String(s.status || '').toLowerCase();
        if (status === 'completed') return { done: true, result: s };
        if (DONE.includes(status)) throw new Error(`Higgsfield ${status}: ${JSON.stringify(s).slice(0, 200)}`);
        await new Promise((r) => setTimeout(r, pollMs));
    }
    return { pending: true };
}

// Upload raw bytes via the presigned-URL flow. Returns the public URL.
export async function upload(bytes, contentType = 'image/jpeg') {
    const res = await fetch(`${BASE}/files/generate-upload-url`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ content_type: contentType }),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`Higgsfield upload-url non-JSON (${res.status}): ${text.slice(0, 160)}`); }
    if (!res.ok) throw new Error(`Higgsfield upload-url ${res.status}: ${text.slice(0, 160)}`);
    const put = await fetch(data.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: bytes,
    });
    if (!put.ok) throw new Error(`Higgsfield upload PUT ${put.status}`);
    return data.public_url;
}

// Pull an image URL out of a completed result (shape varies).
export function pickImageUrl(result) {
    if (!result) return null;
    return (
        result.images?.[0]?.url ||
        result.image?.url ||
        result.output?.images?.[0]?.url ||
        result.result?.images?.[0]?.url ||
        (Array.isArray(result.results) && result.results[0]?.url) ||
        (typeof result.images?.[0] === 'string' ? result.images[0] : null) ||
        null
    );
}

export function pickVideoUrl(result) {
    if (!result) return null;
    return (
        result.video?.url ||
        result.videos?.[0]?.url ||
        result.output?.video?.url ||
        result.result?.video?.url ||
        (typeof result.videos?.[0] === 'string' ? result.videos[0] : null) ||
        null
    );
}
