// ═══════════════════════════════════════════════════════════════════
// fal.ai image client (queue API)
// Used by the Image agent for stills. fal hosts the models the Director
// routes to (Nano Banana Pro, Seedream) and, crucially, exposes /edit
// variants that accept image_urls — enabling true source-frame composition
// (copy the viral video's layout, swap subject/product).
//
//   • submit : POST https://queue.fal.run/{model}  → { request_id, status_url, response_url }
//   • status : GET  {status_url}                    → { status: IN_QUEUE|IN_PROGRESS|COMPLETED }
//   • result : GET  {response_url}                  → { images: [{ url }], ... }
//   • auth   : Authorization: Key <FAL_KEY>
//
// The source frame is hosted on Vercel Blob (a public URL fal can fetch),
// since platform CDNs 403 server-side fetches.
// ═══════════════════════════════════════════════════════════════════

const FAL_KEY = process.env.FAL_KEY;
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

export const isFalConfigured = !!FAL_KEY;
export const isFalBlobConfigured = !!BLOB_TOKEN;

function authHeaders() {
    if (!FAL_KEY) throw new Error('FAL_KEY not configured.');
    return { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' };
}

const DONE = ['COMPLETED', 'FAILED', 'ERROR', 'CANCELED', 'CANCELLED'];

// Submit a job to the fal queue. Returns { request_id, status_url, response_url }.
export async function submit(model, input) {
    const res = await fetch(`https://queue.fal.run/${model}`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(input),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`fal submit non-JSON (${res.status}): ${text.slice(0, 200)}`); }
    if (!res.ok) throw new Error(`fal submit ${model} ${res.status}: ${text.slice(0, 240)}`);
    if (!data.status_url || !data.response_url) throw new Error(`fal submit missing urls: ${text.slice(0, 200)}`);
    return data;
}

export async function getStatus(statusUrl) {
    const res = await fetch(statusUrl, { headers: { Authorization: `Key ${FAL_KEY}` } });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`fal status non-JSON (${res.status}): ${text.slice(0, 160)}`); }
    if (!res.ok) throw new Error(`fal status ${res.status}: ${text.slice(0, 160)}`);
    return data;
}

export async function getResult(responseUrl) {
    const res = await fetch(responseUrl, { headers: { Authorization: `Key ${FAL_KEY}` } });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`fal result non-JSON (${res.status}): ${text.slice(0, 160)}`); }
    if (!res.ok) throw new Error(`fal result ${res.status}: ${text.slice(0, 200)}`);
    return data;
}

// Submit then poll to completion within a deadline. If the deadline passes,
// returns { pending, request_id, status_url, response_url } to resume later.
export async function subscribe(model, input, { deadlineMs = 70000, pollMs = 2500 } = {}) {
    const sub = await submit(model, input);
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
        await new Promise((r) => setTimeout(r, pollMs));
        let s;
        try { s = await getStatus(sub.status_url); } catch { continue; }
        const status = String(s.status || '').toUpperCase();
        if (status === 'COMPLETED') {
            const result = await getResult(sub.response_url);
            return { done: true, result, request_id: sub.request_id };
        }
        if (DONE.includes(status)) throw new Error(`fal ${model} ${status}: ${JSON.stringify(s).slice(0, 200)}`);
    }
    return { pending: true, request_id: sub.request_id, status_url: sub.status_url, response_url: sub.response_url };
}

// Resume polling an already-submitted request.
export async function poll(statusUrl, responseUrl, { deadlineMs = 70000, pollMs = 2500 } = {}) {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
        let s;
        try { s = await getStatus(statusUrl); } catch { await new Promise((r) => setTimeout(r, pollMs)); continue; }
        const status = String(s.status || '').toUpperCase();
        if (status === 'COMPLETED') return { done: true, result: await getResult(responseUrl) };
        if (DONE.includes(status)) throw new Error(`fal ${status}: ${JSON.stringify(s).slice(0, 200)}`);
        await new Promise((r) => setTimeout(r, pollMs));
    }
    return { pending: true };
}

// Pull an image URL out of a completed result (fal shapes vary slightly).
export function pickImageUrl(result) {
    if (!result) return null;
    return (
        result.images?.[0]?.url ||
        result.image?.url ||
        (typeof result.images?.[0] === 'string' ? result.images[0] : null) ||
        null
    );
}

// Host raw bytes on Vercel Blob and return a public URL fal can fetch.
export async function uploadPublic(bytes, contentType, name) {
    if (!BLOB_TOKEN) throw new Error('BLOB_READ_WRITE_TOKEN not configured (needed to host the source frame for fal).');
    const { put } = await import('@vercel/blob');
    const res = await put(name, bytes, {
        access: 'public',
        contentType,
        token: BLOB_TOKEN,
        addRandomSuffix: true,
    });
    return res.url;
}
