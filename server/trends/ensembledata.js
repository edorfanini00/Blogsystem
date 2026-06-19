// ═══════════════════════════════════════════════════════════════════
// Trend Engine — EnsembleData API client (velocity layer ingest)
// Scaffolded against the documented TikTok hashtag endpoints. Plug in
// ENSEMBLEDATA_API_KEY to go live. Graceful when the key is absent.
//
// Docs: https://ensembledata.com/apis/docs  (TikTok > Hashtag)
//   GET /apis/tt/hashtag/recent-posts ?name= &days= &token=
//   GET /apis/tt/hashtag/posts        ?name= &cursor= &token=
// ═══════════════════════════════════════════════════════════════════

const BASE_URL = 'https://ensembledata.com/apis';
const API_KEY = process.env.ENSEMBLEDATA_API_KEY || process.env.ENSEMBLE_DATA_TOKEN;

export const isEnsembleConfigured = !!API_KEY;

const TIMEOUT_MS = 30000;

async function edFetch(path, params) {
    if (!API_KEY) throw new Error('ENSEMBLEDATA_API_KEY not configured');

    const url = new URL(`${BASE_URL}${path}`);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    url.searchParams.set('token', API_KEY);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`EnsembleData ${path} HTTP ${res.status}: ${body.slice(0, 200)}`);
        }
        return res.json();
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') throw new Error(`EnsembleData ${path} timed out`);
        throw err;
    }
}

// Normalize a raw TikTok aweme object into our candidate shape.
// Defensive: every platform field has a fallback so a schema drift on
// EnsembleData's side does not crash ingest.
export function normalizePost(post, platform = 'tiktok') {
    if (!post) return null;

    const stats = post.statistics || post.stats || {};
    const author = post.author || {};
    const music = post.music || {};

    const awemeId = post.aweme_id || post.id || post.video_id;
    const authorHandle = author.unique_id || author.uniqueId || author.uid;

    const url =
        post.share_url ||
        post.url ||
        (authorHandle && awemeId
            ? `https://www.tiktok.com/@${authorHandle}/video/${awemeId}`
            : null);

    if (!url) return null; // url is our upsert key; skip if we cannot build one

    // Hashtags can arrive as text_extra[].hashtag_name or cha_list[].cha_name.
    const hashtags = [];
    for (const t of post.text_extra || []) {
        if (t?.hashtag_name) hashtags.push(t.hashtag_name);
    }
    for (const c of post.cha_list || []) {
        if (c?.cha_name) hashtags.push(c.cha_name);
    }

    const createUnix = post.create_time || post.createTime;
    const createdAt = createUnix ? new Date(Number(createUnix) * 1000).toISOString() : null;

    return {
        platform,
        url,
        authorId: author.uid || author.id || authorHandle || null,
        authorFollowers:
            author.follower_count ?? author.followerCount ?? author.fans ?? null,
        caption: post.desc ?? post.title ?? '',
        audioId: music.id ? String(music.id) : (music.mid || null),
        hashtags,
        createdAt,
        stats: {
            playCount: stats.play_count ?? stats.playCount ?? null,
            likeCount: stats.digg_count ?? stats.diggCount ?? stats.like_count ?? null,
            commentCount: stats.comment_count ?? stats.commentCount ?? null,
            shareCount: stats.share_count ?? stats.shareCount ?? null,
        },
    };
}

// Pull recent posts for a hashtag, bounded to the last `days`.
// Returns an array of normalized candidates.
export async function getHashtagRecentPosts(name, days = 7) {
    const json = await edFetch('/tt/hashtag/recent-posts', { name, days });
    const posts = json?.data?.data || json?.data || [];
    return posts.map((p) => normalizePost(p)).filter(Boolean);
}
