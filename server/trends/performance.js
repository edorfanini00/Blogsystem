// ═══════════════════════════════════════════════════════════════════
// Performance feedback loop — close the loop on what we post.
// Once a generation is marked posted with its public URL, we scrape the live
// metrics (views/likes/comments/shares/saves) and store a time series. The
// research brain then surfaces our real winners back into the next Director +
// Copy run, so the engine learns from outcomes instead of guessing.
//
// TikTok stats come from the same no-key resolver we already use (tikwm).
// Instagram/YouTube are best-effort and may return nothing until a scraper is
// wired; the loop degrades cleanly.
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const APIFY_TOKEN = process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN || null;
const BASE_URL = 'https://api.apify.com/v2';

function engagementPct({ views, likes, comments, shares }) {
    return views > 0 ? Number((((likes + comments + shares) / views) * 100).toFixed(2)) : 0;
}

// Live TikTok stats via tikwm (no key). Returns normalized metrics or null.
async function tiktokStats(url) {
    const api = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
        const res = await fetch(api, { headers: { 'User-Agent': UA }, signal: controller.signal });
        const j = await res.json();
        const d = j?.data;
        if (!d) return null;
        return {
            views: Number(d.play_count) || 0,
            likes: Number(d.digg_count) || 0,
            comments: Number(d.comment_count) || 0,
            shares: Number(d.share_count) || 0,
            saves: Number(d.collect_count) || 0,
        };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Live Instagram post stats via Apify (apify/instagram-scraper).
// Pulls the specific post URL and extracts engagement metrics.
async function instagramStats(url) {
    if (!APIFY_TOKEN) return null;
    const actorId = 'apify/instagram-scraper';
    const endpoint = `${BASE_URL}/acts/${actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_TOKEN)}&clean=true&memory=2048`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ directUrls: [url], resultsType: 'posts', resultsLimit: 1 }),
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) return null;
        const items = await res.json();
        const item = Array.isArray(items) ? items[0] : null;
        if (!item) return null;
        const views = Number(item.videoViewCount || item.videoPlayCount || item.play_count || 0);
        const likes = Number(item.likesCount || item.like_count || item.likes || 0);
        const comments = Number(item.commentsCount || item.comment_count || item.comments || 0);
        const saves = Number(item.savesCount || item.save_count || 0);
        return { views, likes, comments, shares: 0, saves };
    } catch {
        clearTimeout(timer);
        return null;
    }
}

// Fetch live stats for a posted URL by platform. Best-effort.
export async function fetchPostStats(url, platform) {
    if (!url) return null;
    if (platform === 'tiktok' || url.includes('tiktok.com')) return tiktokStats(url);
    if (platform === 'instagram' || url.includes('instagram.com')) return instagramStats(url);
    return null; // YouTube: wire a scraper later
}

// Scrape + record one performance snapshot for a generation. Returns the row or
// null when stats are unavailable. Reads posted_url from the generation if no
// url is passed.
export async function recordPerformance(generationId, { url = null } = {}) {
    const { rows } = await query(
        `select g.id, g.candidate_id, g.posted_url, c.platform
         from generations g join candidates c on c.id = g.candidate_id where g.id = $1`,
        [generationId]
    );
    const g = rows[0];
    if (!g) throw new Error('Generation not found');
    const target = url || g.posted_url;
    if (!target) throw new Error('No posted URL on this generation (mark it posted with its public link first).');

    const stats = await fetchPostStats(target, g.platform);
    if (!stats) return { generationId, recorded: false, reason: 'stats unavailable for this platform/url' };

    const eng = engagementPct(stats);
    const ins = await query(
        `insert into generation_performance
            (generation_id, candidate_id, public_url, platform, views, likes, comments, shares, saves, engagement_pct)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [generationId, g.candidate_id, target, g.platform, stats.views, stats.likes, stats.comments, stats.shares, stats.saves, eng]
    );
    return { generationId, recorded: true, stats: { ...stats, engagement_pct: eng }, row: ins.rows[0] };
}

// Refresh stats for every posted generation (cron). Bounded so it stays under
// the serverless limit.
export async function sweepPerformance({ limit = 30 } = {}) {
    const { rows } = await query(
        `select id from generations where posted_url is not null order by posted_at desc nulls last limit $1`,
        [limit]
    );
    const results = [];
    for (const r of rows) {
        try { results.push(await recordPerformance(r.id)); }
        catch (e) { results.push({ generationId: r.id, recorded: false, error: e.message }); }
    }
    return { checked: rows.length, results };
}
