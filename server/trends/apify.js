// ═══════════════════════════════════════════════════════════════════
// Trend Engine — Apify multi-platform ingest provider
// One provider, one token, three platforms (TikTok, Instagram Reels,
// YouTube Shorts). Each platform maps to a dedicated Apify "actor" that
// accepts a hashtag list and returns posts with engagement metrics.
//
// We use the synchronous run-sync-get-dataset-items endpoint so a single
// HTTP call starts the actor, waits for it to finish, and returns the
// dataset items — no polling needed. Every actor is called once per
// cycle with the full hashtag list, then results are normalized into the
// shared candidate shape used by ingest.js.
//
// Graceful: when APIFY_TOKEN is absent, isApifyConfigured is false and
// ingest falls back to the EnsembleData provider.
// ═══════════════════════════════════════════════════════════════════
import { APIFY_ACTORS, APIFY_RESULTS_PER_HASHTAG, APIFY_TIKTOK_SORT } from './config.js';

const APIFY_TOKEN = process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN || null;
const BASE_URL = 'https://api.apify.com/v2';

// Wait up to ~4.5 min for an actor run (Vercel functions cap at 5 min;
// platforms run in parallel so the cycle stays under that budget).
const RUN_TIMEOUT_MS = 270000;

export const isApifyConfigured = !!APIFY_TOKEN;
export const SUPPORTED_PLATFORMS = Object.keys(APIFY_ACTORS);

// Normalize a hashtag: strip leading '#', whitespace, lowercase.
function cleanTag(tag) {
    return String(tag || '').replace(/^#/, '').trim().toLowerCase();
}

// Call an actor synchronously and return its dataset items (array).
async function runActor(actorId, input) {
    if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN not configured');

    const url = `${BASE_URL}/acts/${actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(
        APIFY_TOKEN
    )}&clean=true`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`Apify ${actorId} HTTP ${res.status}: ${body.slice(0, 200)}`);
        }
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') throw new Error(`Apify ${actorId} timed out`);
        throw err;
    }
}

// ─── Per-platform normalizers ───────────────────────────────────
// Each maps a raw actor item into the shared candidate shape. `url`
// is the upsert key, so items without one are dropped.

function normalizeTikTok(item) {
    const url = item.webVideoUrl || item.url || null;
    if (!url) return null;
    const author = item.authorMeta || {};
    const music = item.musicMeta || {};
    const hashtags = (item.hashtags || [])
        .map((h) => (typeof h === 'string' ? h : h?.name))
        .filter(Boolean);
    return {
        platform: 'tiktok',
        url,
        authorId: author.id || author.name || null,
        authorFollowers: author.fans ?? null,
        caption: item.text ?? '',
        audioId: music.musicId ? String(music.musicId) : null,
        hashtags,
        createdAt:
            item.createTimeISO ||
            (item.createTime ? new Date(Number(item.createTime) * 1000).toISOString() : null),
        stats: {
            playCount: item.playCount ?? null,
            likeCount: item.diggCount ?? null,
            commentCount: item.commentCount ?? null,
            shareCount: item.shareCount ?? null,
        },
    };
}

function normalizeInstagram(item) {
    const url = item.post_url || item.url || null;
    if (!url) return null;
    return {
        platform: 'instagram',
        url,
        authorId: item.author_username || null,
        authorFollowers: item.author_follower_count ?? null,
        caption: item.caption ?? '',
        audioId: item.audio_id ? String(item.audio_id) : null,
        hashtags: item.caption_hashtags || [],
        createdAt: item.posted_at || null,
        stats: {
            playCount: item.play_count ?? null,
            likeCount: item.like_count ?? null,
            commentCount: item.comment_count ?? null,
            shareCount: null,
        },
    };
}

function normalizeYouTube(item) {
    const url = item.url || null;
    if (!url) return null;
    return {
        platform: 'youtube',
        url,
        authorId: item.channel_id || null,
        authorFollowers: item.channel_subscribers ?? null,
        caption: item.title ?? '',
        audioId: item.audio_title ? String(item.audio_title) : null,
        hashtags: Array.isArray(item.hashtags) ? item.hashtags : [],
        createdAt: item.published_at || null,
        stats: {
            playCount: item.view_count ?? null,
            likeCount: item.like_count ?? null,
            commentCount: item.comment_count ?? null,
            shareCount: null,
        },
    };
}

// ─── Per-platform input builders ────────────────────────────────

function buildInput(platform, tags, resultsPerHashtag) {
    switch (platform) {
        case 'tiktok':
            return {
                hashtags: tags,
                resultsPerPage: resultsPerHashtag,
                sortBy: APIFY_TIKTOK_SORT,
            };
        case 'instagram':
            return {
                hashtags: tags,
                maxPostsPerHashtag: resultsPerHashtag,
            };
        case 'youtube':
            return {
                hashtagUrls: tags.map((t) => `https://www.youtube.com/hashtag/${t}/shorts`),
                maxResults: resultsPerHashtag,
            };
        default:
            throw new Error(`Unsupported platform: ${platform}`);
    }
}

const NORMALIZERS = {
    tiktok: normalizeTikTok,
    instagram: normalizeInstagram,
    youtube: normalizeYouTube,
};

// Ingest one platform across all hashtags in a single actor run.
// Returns an array of normalized candidates.
export async function ingestPlatform(platform, hashtags, { resultsPerHashtag } = {}) {
    const actorId = APIFY_ACTORS[platform];
    if (!actorId) throw new Error(`No Apify actor configured for platform: ${platform}`);

    const tags = (hashtags || []).map(cleanTag).filter(Boolean);
    if (!tags.length) return [];

    const limit = resultsPerHashtag || APIFY_RESULTS_PER_HASHTAG;
    const input = buildInput(platform, tags, limit);
    const items = await runActor(actorId, input);

    const normalize = NORMALIZERS[platform];
    return items.map((it) => normalize(it)).filter(Boolean);
}
