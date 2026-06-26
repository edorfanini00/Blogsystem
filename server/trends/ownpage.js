// ═══════════════════════════════════════════════════════════════════
// Own-page awareness — understand our own Instagram presence.
//
// The engine scrapes our own Instagram profile to learn:
//   • What content formats/styles our audience responds to
//   • Which posts got the most engagement (views, likes, comments)
//   • Our posting cadence and visual style
//
// This data is cached in app_settings (no schema change needed) and
// injected into every autopilot pick and Director generation so the
// agent remakes content that fits OUR page, not just viral strangers.
//
// Set OWN_INSTAGRAM_HANDLE in .env to activate. Degrades cleanly when
// not configured or when Apify is unavailable.
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';
import { OWN_INSTAGRAM_HANDLE, OWN_INSTAGRAM_ACTOR, OWN_PAGE_POST_LIMIT } from './config.js';

const APIFY_TOKEN = process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN || null;
const BASE_URL = 'https://api.apify.com/v2';
const CACHE_KEY = 'own_page_cache';
const CACHE_TTL_HOURS = 6; // refresh at most every 6 hours

function safeParse(s) {
    if (!s || typeof s === 'object') return s;
    try { return JSON.parse(s); } catch { return null; }
}

function clip(s, n) {
    return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

// ─── Apify own-profile call ─────────────────────────────────────
async function runProfileActor(handle) {
    if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN not configured');
    const actorId = OWN_INSTAGRAM_ACTOR;
    const url = `${BASE_URL}/acts/${actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_TOKEN)}&clean=true&memory=2048`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                directUrls: [`https://www.instagram.com/${handle}/`],
                resultsType: 'posts',
                resultsLimit: OWN_PAGE_POST_LIMIT,
            }),
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`Apify own-page HTTP ${res.status}: ${body.slice(0, 200)}`);
        }
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') throw new Error('Own-page Apify call timed out');
        throw err;
    }
}

// ─── Normalize a raw Instagram post item ────────────────────────
function normalizePost(item) {
    const views = Number(item.videoViewCount || item.videoPlayCount || item.play_count || 0);
    const likes = Number(item.likesCount || item.like_count || item.likes || 0);
    const comments = Number(item.commentsCount || item.comment_count || item.comments || 0);
    const saves = Number(item.savesCount || item.save_count || 0);
    const engagement = views > 0
        ? Math.round(((likes + comments + saves) / views) * 100 * 100) / 100
        : likes > 0 ? Math.round(((likes + comments + saves) / Math.max(likes, 1)) * 100 * 100) / 100
        : 0;
    return {
        url: item.url || item.shortCode ? `https://www.instagram.com/p/${item.shortCode}/` : null,
        caption: clip(item.caption || item.alt || '', 300),
        type: item.type || item.productType || (views > 0 ? 'reel' : 'image'),
        views,
        likes,
        comments,
        saves,
        engagement,
        thumbnail: item.displayUrl || item.thumbnailUrl || item.thumbnail || null,
        postedAt: item.timestamp || item.takenAtTimestamp
            ? new Date(Number(item.takenAtTimestamp || 0) * 1000 || item.timestamp).toISOString()
            : null,
    };
}

// ─── Derive content-style insights from our own posts ───────────
function deriveInsights(posts) {
    if (!posts || !posts.length) return null;

    const byEngagement = [...posts].sort((a, b) => b.engagement - a.engagement);
    const byViews = [...posts].filter(p => p.views > 0).sort((a, b) => b.views - a.views);

    // Format breakdown
    const formatCounts = {};
    const formatViews = {};
    for (const p of posts) {
        const t = p.type || 'image';
        formatCounts[t] = (formatCounts[t] || 0) + 1;
        formatViews[t] = (formatViews[t] || 0) + p.views;
    }
    const topFormat = Object.entries(formatViews)
        .sort((a, b) => b[1] - a[1])
        .map(([fmt]) => fmt)[0] || 'reel';

    // Winning hooks from top posts
    const topByEng = byEngagement.slice(0, 5);
    const topByViews = byViews.slice(0, 5);

    // Average engagement on reels vs images
    const reels = posts.filter(p => p.type === 'reel' || p.type === 'video');
    const images = posts.filter(p => p.type === 'image' || p.type === 'carousel');
    const avgReelEng = reels.length ? reels.reduce((s, p) => s + p.engagement, 0) / reels.length : 0;
    const avgImgEng = images.length ? images.reduce((s, p) => s + p.engagement, 0) / images.length : 0;

    return {
        totalPosts: posts.length,
        topFormat,
        formatCounts,
        avgReelEngagement: Math.round(avgReelEng * 100) / 100,
        avgImageEngagement: Math.round(avgImgEng * 100) / 100,
        topPostsByEngagement: topByEng.map(p => ({ caption: p.caption, engagement: p.engagement, views: p.views, type: p.type, url: p.url })),
        topPostsByViews: topByViews.map(p => ({ caption: p.caption, views: p.views, engagement: p.engagement, type: p.type, url: p.url })),
        overallAvgEngagement: Math.round((posts.reduce((s, p) => s + p.engagement, 0) / posts.length) * 100) / 100,
    };
}

// ─── Cache helpers ───────────────────────────────────────────────
async function readCache() {
    try {
        const { rows } = await query('select value, updated_at from app_settings where key = $1', [CACHE_KEY]);
        if (!rows[0]) return null;
        const age = Date.now() - new Date(rows[0].updated_at).getTime();
        if (age > CACHE_TTL_HOURS * 3600 * 1000) return null; // stale
        return safeParse(rows[0].value);
    } catch { return null; }
}

async function writeCache(data) {
    try {
        await query(
            `insert into app_settings (key, value, updated_at) values ($1,$2,now())
             on conflict (key) do update set value=$2, updated_at=now()`,
            [CACHE_KEY, JSON.stringify(data)]
        );
    } catch (err) {
        console.error('own-page cache write error:', err.message);
    }
}

// ─── Public: refresh own-page data (scrape + cache) ─────────────
export async function refreshOwnPage() {
    const handle = OWN_INSTAGRAM_HANDLE;
    if (!handle) return { skipped: 'OWN_INSTAGRAM_HANDLE not set' };
    if (!APIFY_TOKEN) return { skipped: 'APIFY_TOKEN not configured' };

    console.log(`📸 Scraping own Instagram page: @${handle}…`);
    const raw = await runProfileActor(handle);
    if (!raw.length) return { skipped: 'no posts returned', handle };

    const posts = raw.map(normalizePost).filter(p => p && p.url);
    const insights = deriveInsights(posts);
    const cache = { handle, scrapedAt: new Date().toISOString(), posts, insights };
    await writeCache(cache);
    console.log(`✅ Own-page refreshed: @${handle} — ${posts.length} posts, top format: ${insights?.topFormat}`);
    return { handle, postCount: posts.length, insights };
}

// ─── Public: get cached own-page data (non-scraping) ────────────
export async function getOwnPageCache() {
    return await readCache();
}

// ─── Build a text block for LLM grounding ───────────────────────
// Injected into Director and Copy so every generation understands our page.
export async function buildOwnPageBlock() {
    const handle = OWN_INSTAGRAM_HANDLE;
    if (!handle) return '';
    const cache = await readCache();
    if (!cache || !cache.insights) return '';

    const ins = cache.insights;
    const lines = [
        `OUR INSTAGRAM PAGE (@${handle}) — understand this before generating:`,
        `• Best-performing format: ${ins.topFormat} (avg engagement ${ins.avgReelEngagement}% for reels, ${ins.avgImageEngagement}% for images)`,
        `• Overall avg engagement: ${ins.overallAvgEngagement}% across ${ins.totalPosts} recent posts`,
    ];

    if (ins.topPostsByViews && ins.topPostsByViews.length) {
        lines.push('• Our top posts by views (mirror these angles and styles):');
        ins.topPostsByViews.slice(0, 3).forEach((p, i) => {
            lines.push(`  #${i + 1} [${p.type}] ${p.views.toLocaleString()} views, ${p.engagement}% eng — "${clip(p.caption, 120)}"`);
        });
    }

    if (ins.topPostsByEngagement && ins.topPostsByEngagement.length) {
        lines.push('• Our highest-engagement posts (these styles connect best with our audience):');
        ins.topPostsByEngagement.slice(0, 3).forEach((p, i) => {
            lines.push(`  #${i + 1} [${p.type}] ${p.engagement}% eng — "${clip(p.caption, 120)}"`);
        });
    }

    lines.push(`• Make every generation feel native to this page — match the energy, format, and content style our audience already responds to.`);
    return lines.join('\n');
}

// ─── Build a "what our page is about" target block ──────────────
// Used by the Director's AUTO target so viral FORMATS get applied to OUR
// subject matter (what we actually post about) — not the viral video's topic.
export async function buildOwnPageTargetBlock() {
    const handle = OWN_INSTAGRAM_HANDLE;
    if (!handle) return '';
    const cache = await readCache();
    if (!cache || !cache.posts || !cache.posts.length) return '';

    const ins = cache.insights || {};
    // Use our best-performing posts' captions as the canonical "what we post about".
    const topPosts = (ins.topPostsByEngagement || []).concat(ins.topPostsByViews || []);
    const seen = new Set();
    const themes = [];
    for (const p of topPosts) {
        const cap = clip(p.caption, 140);
        if (cap && !seen.has(cap)) { seen.add(cap); themes.push(cap); }
        if (themes.length >= 6) break;
    }
    if (!themes.length) return '';

    const lines = [
        `WHAT OUR PAGE (@${handle}) IS ABOUT — apply the viral format to THIS subject matter, not the source video's topic:`,
        ...themes.map((t, i) => `  • ${t}`),
        `Stay on-brand: the remake must be about what our page posts (above), styled with the source's format/hook/pacing.`,
    ];
    return lines.join('\n');
}

// ─── Return format/style performance data for autopilot weighting ─
// Returns an object mapping format name → avg engagement, so pickCandidates
// can boost candidates whose format matches our winners.
export async function getOwnPageFormatScores() {
    const cache = await readCache();
    if (!cache || !cache.posts || !cache.posts.length) return {};
    const byFormat = {};
    for (const p of cache.posts) {
        const f = (p.type || 'image').toLowerCase();
        if (!byFormat[f]) byFormat[f] = { totalEng: 0, totalViews: 0, count: 0 };
        byFormat[f].totalEng += p.engagement;
        byFormat[f].totalViews += p.views;
        byFormat[f].count++;
    }
    const scores = {};
    for (const [fmt, data] of Object.entries(byFormat)) {
        scores[fmt] = {
            avgEngagement: Math.round((data.totalEng / data.count) * 100) / 100,
            avgViews: Math.round(data.totalViews / data.count),
            count: data.count,
        };
    }
    return scores;
}
