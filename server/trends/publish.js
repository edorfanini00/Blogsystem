// ═══════════════════════════════════════════════════════════════════
// Instagram publishing — posts a finished generation straight to your
// Instagram Business/Creator account via the Graph API.
//
// Two media types are supported:
//   • VIDEO     → published as a Reel (REELS container → poll → publish)
//   • SLIDESHOW → published as a photo CAROUSEL from slide_urls
//
// Requirements (see config.js): IG_USER_ID + IG_ACCESS_TOKEN. The asset must be
// reachable at a public URL — our renders live on Vercel Blob, so they are.
//
// The flow is intentionally polite: create the media container(s), wait for
// Instagram to finish processing (videos take a few seconds), then publish.
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';
import {
    IG_USER_ID, IG_ACCESS_TOKEN, IG_GRAPH_VERSION, isInstagramPublishConfigured,
} from './config.js';

const GRAPH = `https://graph.facebook.com/${IG_GRAPH_VERSION}`;

function safeParse(s) {
    if (!s) return null;
    if (typeof s === 'object') return s;
    try { return JSON.parse(s); } catch { return null; }
}

// Pick the best caption: the Instagram-specific copy + hashtags, else the
// generation's primary caption. Instagram caption limit is ~2,200 chars.
function buildCaption(gen) {
    const copy = safeParse(gen.copy_json) || {};
    const captions = copy.captions || {};
    let base = captions.instagram || gen.caption || '';
    const tags = Array.isArray(copy.hashtags) ? copy.hashtags : [];
    if (tags.length) {
        const tagLine = tags.map((t) => '#' + String(t).replace(/^#/, '').trim()).filter((t) => t.length > 1).join(' ');
        // Avoid duplicating hashtags already present in the caption text.
        if (tagLine && !base.includes('#')) base = base ? `${base}\n\n${tagLine}` : tagLine;
    }
    return base.slice(0, 2200);
}

async function graphPost(path, params) {
    const body = new URLSearchParams({ ...params, access_token: IG_ACCESS_TOKEN });
    const res = await fetch(`${GRAPH}/${path}`, { method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
        const msg = data.error?.message || `Graph error ${res.status}`;
        throw new Error(`Instagram: ${msg}`);
    }
    return data;
}

async function graphGet(path, fields) {
    const url = `${GRAPH}/${path}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(IG_ACCESS_TOKEN)}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
        const msg = data.error?.message || `Graph error ${res.status}`;
        throw new Error(`Instagram: ${msg}`);
    }
    return data;
}

// Wait for a media container to finish processing before publishing. Videos
// (Reels) are transcoded server-side and report status_code transitions
// IN_PROGRESS → FINISHED (or ERROR/EXPIRED). Images are usually instant.
async function waitForContainer(containerId, { timeoutMs = 180000, pollMs = 4000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const { status_code: status } = await graphGet(containerId, 'status_code');
        if (status === 'FINISHED') return;
        if (status === 'ERROR' || status === 'EXPIRED') {
            throw new Error(`Instagram: media container ${status}`);
        }
        await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error('Instagram: media processing timed out');
}

async function publishReel(videoUrl, caption) {
    const container = await graphPost(`${IG_USER_ID}/media`, {
        media_type: 'REELS',
        video_url: videoUrl,
        caption,
        share_to_feed: 'true',
    });
    await waitForContainer(container.id);
    return graphPost(`${IG_USER_ID}/media_publish`, { creation_id: container.id });
}

async function publishCarousel(imageUrls, caption) {
    const urls = imageUrls.slice(0, 10); // Instagram carousels allow 2–10 items
    if (urls.length < 2) throw new Error('Instagram: a carousel needs at least 2 slides');
    // 1) one child container per image
    const children = [];
    for (const url of urls) {
        const child = await graphPost(`${IG_USER_ID}/media`, {
            image_url: url,
            is_carousel_item: 'true',
        });
        children.push(child.id);
    }
    // 2) the parent carousel container
    const parent = await graphPost(`${IG_USER_ID}/media`, {
        media_type: 'CAROUSEL',
        children: children.join(','),
        caption,
    });
    await waitForContainer(parent.id);
    // 3) publish
    return graphPost(`${IG_USER_ID}/media_publish`, { creation_id: parent.id });
}

// Resolve the permalink of a freshly published media object (best effort).
async function permalinkFor(mediaId) {
    try {
        const { permalink } = await graphGet(mediaId, 'permalink');
        return permalink || null;
    } catch {
        return null;
    }
}

function slideUrlsFrom(gen) {
    const raw = safeParse(gen.slide_urls) || [];
    return raw
        .map((s) => (typeof s === 'string' ? s : s?.url))
        .filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
}

// Publish a generation to Instagram. Returns { mediaId, permalink, type }.
export async function publishToInstagram(gen) {
    if (!isInstagramPublishConfigured) {
        throw new Error('Instagram publishing not configured (set IG_USER_ID and IG_ACCESS_TOKEN).');
    }
    const caption = buildCaption(gen);
    const isSlideshow = gen.output_type === 'slideshow';

    let result;
    let type;
    if (isSlideshow) {
        const slides = slideUrlsFrom(gen);
        if (slides.length >= 2) {
            type = 'carousel';
            result = await publishCarousel(slides, caption);
        } else if (gen.asset_url) {
            // No separate slides — fall back to the rendered slideshow reel.
            type = 'reel';
            result = await publishReel(gen.asset_url, caption);
        } else {
            throw new Error('Instagram: slideshow has no slides or rendered asset to post.');
        }
    } else {
        if (!gen.asset_url) throw new Error('Instagram: no rendered video (asset_url) to post.');
        type = 'reel';
        result = await publishReel(gen.asset_url, caption);
    }

    const mediaId = result.id;
    const permalink = await permalinkFor(mediaId);
    return { mediaId, permalink, type };
}

// Publish by generation id, then mark the generation posted + record the URL so
// the performance feedback loop can pick it up. Returns the publish result.
export async function publishGeneration(generationId) {
    const { rows } = await query('select * from generations where id = $1', [generationId]);
    const gen = rows[0];
    if (!gen) throw new Error('Generation not found');
    if (!['review', 'approved', 'posted'].includes(gen.status)) {
        throw new Error(`Generation is "${gen.status}" — finish rendering before publishing.`);
    }
    const out = await publishToInstagram(gen);
    await query(
        `update generations set status='posted', posted_at=now(),
                posted_url = coalesce($2, posted_url) where id=$1`,
        [generationId, out.permalink || null]
    );
    return out;
}
