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
import {
    APIFY_ACTORS,
    APIFY_RESULTS_PER_HASHTAG,
    APIFY_TIKTOK_SORT,
    APIFY_SEARCH_ACTORS,
    APIFY_SEARCH_SORT,
    APIFY_SEARCH_DATE,
    APIFY_SEARCH_RESULTS,
    APIFY_SEARCH_MIN_VIEWS,
    APIFY_MEMORY_MB,
} from './config.js';

const APIFY_TOKEN = process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN || null;
const BASE_URL = 'https://api.apify.com/v2';

// Per-actor wall-clock cap. Kept under the Vercel 5-min function limit with
// buffer so one slow actor can't starve the whole cycle (others still return).
const RUN_TIMEOUT_MS = Number(process.env.APIFY_RUN_TIMEOUT_MS) || 210000;

export const isApifyConfigured = !!APIFY_TOKEN;
export const SUPPORTED_PLATFORMS = Object.keys(APIFY_ACTORS);

// Normalize a hashtag: strip leading '#', whitespace, lowercase.
function cleanTag(tag) {
    return String(tag || '').replace(/^#/, '').trim().toLowerCase();
}

// Call an actor synchronously and return its dataset items (array).
async function runActor(actorId, input) {
    if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN not configured');

    // Cap memory per run so several actors fit inside the account's total
    // concurrent-memory limit (free plan = 8192MB). Without this, parallel
    // runs trip "actor-memory-limit-exceeded" (HTTP 402).
    const url = `${BASE_URL}/acts/${actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(
        APIFY_TOKEN
    )}&clean=true&memory=${APIFY_MEMORY_MB}`;

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

// Search-net TikTok actor (sentry/tiktok-search-api) returns a flatter shape
// than the hashtag actor, so it needs its own normalizer.
function normalizeTikTokSearch(item) {
    const url = item.url || null;
    if (!url) return null;
    return {
        platform: 'tiktok',
        url,
        authorId: item.author || null,
        authorFollowers: item.followers ?? null,
        caption: item.desc ?? '',
        audioId: item.musicTitle ? String(item.musicTitle) : null,
        hashtags: Array.isArray(item.hashtags) ? item.hashtags : [],
        createdAt: item.createdAt || null,
        stats: {
            playCount: item.plays ?? null,
            likeCount: item.likes ?? null,
            commentCount: item.comments ?? null,
            shareCount: item.shares ?? null,
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

// ─── Performance-based discovery (search net) ───────────────────
// Search topic phrases and rank by actual views, so videos that go viral
// without using your hashtags still enter the candidate pool.

function buildSearchInput(platform, terms, results) {
    switch (platform) {
        case 'tiktok':
            return {
                keywords: terms,
                maxVideosPerKeyword: results,
                sortOrder: APIFY_SEARCH_SORT,
                datePosted: APIFY_SEARCH_DATE,
            };
        case 'youtube':
            return {
                searchQueries: terms,
                maxResults: results,
            };
        default:
            throw new Error(`Search not supported for platform: ${platform}`);
    }
}

const SEARCH_NORMALIZERS = {
    tiktok: normalizeTikTokSearch,
    youtube: normalizeYouTube,
};

// Search one platform across all terms in a single actor run. Applies the
// minimum-views floor so only real performers enter the pool.
export async function searchPlatform(platform, terms, { results } = {}) {
    const actorId = APIFY_SEARCH_ACTORS[platform];
    if (!actorId) throw new Error(`No Apify search actor configured for platform: ${platform}`);

    const cleanTerms = (terms || []).map((t) => String(t || '').trim()).filter(Boolean);
    if (!cleanTerms.length) return [];

    const limit = results || APIFY_SEARCH_RESULTS;
    const input = buildSearchInput(platform, cleanTerms, limit);
    const items = await runActor(actorId, input);

    const normalize = SEARCH_NORMALIZERS[platform];
    const minViews = APIFY_SEARCH_MIN_VIEWS;
    return items
        .map((it) => normalize(it))
        .filter((c) => c && (!minViews || (c.stats.playCount || 0) >= minViews));
}
