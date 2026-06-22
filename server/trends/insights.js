// ═══════════════════════════════════════════════════════════════════
// Trend Engine — Weekly intelligence / trend-spotting analyst
//
// Reliability principle: the FACTS are computed from data, the LLM only
// synthesizes. Everything in `trending` and `rising` is measured directly
// from candidates / snapshots / topics (real view counts, real week-over-
// week deltas). The analyst LLM receives those numbers and must cite them;
// it never invents a trend. Forecasts are explainable extrapolations with a
// confidence label that reflects how much history we actually have — so the
// system is honest on day one and gets more accurate every weekly cycle.
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';
import { listCandidates } from './ingest.js';
import { listTopics } from './topics.js';
import { listClusters } from './cluster.js';
import { claudeJSON, isLlmConfigured, LLM_MODEL } from './llm.js';
import { MESSAGE_BANK, EDITORIAL_RULES } from './config.js';

const DAY = 86400000;
const CATEGORIES = ['companies', 'food', 'oil'];
const CATEGORY_LABEL = { companies: 'Companies going viral', food: 'Food industry', oil: 'Oil & gas' };
const PLATFORMS_LIST = ['tiktok', 'instagram', 'youtube'];
const PLATFORM_LABEL = { tiktok: 'TikTok', instagram: 'Instagram Reels', youtube: 'YouTube Shorts' };

function num(v) { const n = Number(v); return isNaN(n) ? 0 : n; }
function pct(now, prev) {
    if (prev <= 0) return now > 0 ? 1 : 0;
    return (now - prev) / prev;
}
function within(iso, fromDaysAgo, toDaysAgo = 0) {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    const now = Date.now();
    return t >= now - fromDaysAgo * DAY && t < now - toDaysAgo * DAY;
}

// ─── Deterministic signal computation (the facts) ───────────────
export async function computeSignals({ days = 7 } = {}) {
    const cands = await listCandidates({ limit: 600 });

    const thisWeek = cands.filter((c) => within(c.first_seen_at, days, 0));
    const prevWeek = cands.filter((c) => within(c.first_seen_at, days * 2, days));

    // Per-category momentum: volume + reach this week vs last week.
    const categories = CATEGORIES.map((cat) => {
        const tw = thisWeek.filter((c) => (c.category || 'companies') === cat);
        const pw = prevWeek.filter((c) => (c.category || 'companies') === cat);
        const twViews = tw.reduce((a, c) => a + num(c.play_count), 0);
        const pwViews = pw.reduce((a, c) => a + num(c.play_count), 0);
        const top = [...tw]
            .sort((a, b) => num(b.play_count) - num(a.play_count))
            .slice(0, 5)
            .map((c) => ({
                caption: (c.caption || '').slice(0, 140),
                url: c.url,
                platform: c.platform,
                views: num(c.play_count),
                likes: num(c.like_count),
                author: c.author_id,
            }));
        return {
            category: cat,
            label: CATEGORY_LABEL[cat],
            videos: tw.length,
            videosPrev: pw.length,
            videoGrowth: Number(pct(tw.length, pw.length).toFixed(3)),
            totalViews: twViews,
            totalViewsPrev: pwViews,
            viewGrowth: Number(pct(twViews, pwViews).toFixed(3)),
            avgViews: tw.length ? Math.round(twViews / tw.length) : 0,
            topVideos: top,
        };
    });

    // Per-platform momentum + each platform's own top videos.
    const platforms = PLATFORMS_LIST.map((p) => {
        const tw = thisWeek.filter((c) => c.platform === p);
        const pw = prevWeek.filter((c) => c.platform === p);
        const twViews = tw.reduce((a, c) => a + num(c.play_count), 0);
        const pwViews = pw.reduce((a, c) => a + num(c.play_count), 0);
        const top = [...tw]
            .sort((a, b) => num(b.play_count) - num(a.play_count))
            .slice(0, 5)
            .map((c) => ({
                caption: (c.caption || '').slice(0, 140),
                url: c.url,
                category: c.category || 'companies',
                views: num(c.play_count),
                likes: num(c.like_count),
                author: c.author_id,
            }));
        return {
            platform: p,
            label: PLATFORM_LABEL[p],
            videos: tw.length,
            videosPrev: pw.length,
            totalViews: twViews,
            totalViewsPrev: pwViews,
            viewGrowth: Number(pct(twViews, pwViews).toFixed(3)),
            avgViews: tw.length ? Math.round(twViews / tw.length) : 0,
            topVideos: top,
        };
    });

    // Hottest individual videos this week (the actual viral hits).
    const topVideos = [...thisWeek]
        .sort((a, b) => num(b.play_count) - num(a.play_count))
        .slice(0, 12)
        .map((c) => ({
            caption: (c.caption || '').slice(0, 160),
            url: c.url,
            platform: c.platform,
            category: c.category || 'companies',
            views: num(c.play_count),
            likes: num(c.like_count),
            comments: num(c.comment_count),
            author: c.author_id,
            velocity: c.velocity != null ? Math.round(num(c.velocity)) : null,
        }));

    // Fastest-accelerating videos (slope, not size) — needs 2+ snapshots.
    const accelerating = cands
        .filter((c) => c.velocity != null && num(c.velocity) > 0)
        .sort((a, b) => num(b.velocity) - num(a.velocity))
        .slice(0, 8)
        .map((c) => ({
            caption: (c.caption || '').slice(0, 140),
            url: c.url,
            category: c.category || 'companies',
            views: num(c.play_count),
            velocityPerHour: Math.round(num(c.velocity)),
        }));

    // Topic momentum with a simple, explainable forecast.
    let topics = [];
    try {
        const r = await query(`
            with kw as (select distinct keyword from topics),
            nowv as (
                select distinct on (keyword) keyword, mention_volume, captured_at
                from topics order by keyword, captured_at desc
            ),
            prevv as (
                select distinct on (keyword) keyword, mention_volume
                from topics where captured_at <= now() - interval '7 days'
                order by keyword, captured_at desc
            ),
            cnt as (
                select keyword, count(*)::int n from topics
                where captured_at >= now() - interval '21 days' group by keyword
            )
            select k.keyword,
                   coalesce(nowv.mention_volume, 0) as now_vol,
                   coalesce(prevv.mention_volume, 0) as prev_vol,
                   coalesce(cnt.n, 0) as points
            from kw k
            left join nowv on nowv.keyword = k.keyword
            left join prevv on prevv.keyword = k.keyword
            left join cnt on cnt.keyword = k.keyword
        `);
        topics = r.rows.map((t) => {
            const now_vol = num(t.now_vol);
            const prev_vol = num(t.prev_vol);
            const growth = pct(now_vol, prev_vol);
            const projectedNext = Math.max(0, Math.round(now_vol * (1 + growth)));
            const points = num(t.points);
            let confidence;
            if (prev_vol === 0 && points < 2) confidence = 'building';
            else if (points >= 5) confidence = 'high';
            else if (points >= 2) confidence = 'medium';
            else confidence = 'low';
            let direction = 'flat';
            if (growth > 0.15) direction = 'rising';
            else if (growth < -0.15) direction = 'fading';
            return {
                keyword: t.keyword,
                mentions: now_vol,
                mentionsPrev: prev_vol,
                growth: Number(growth.toFixed(3)),
                projectedNext,
                direction,
                confidence,
                points,
            };
        }).sort((a, b) => b.growth - a.growth || b.mentions - a.mentions);
    } catch (err) {
        topics = [];
    }

    // Formats/clusters that represent real repeated trends.
    let clusters = [];
    try {
        clusters = (await listClusters({ limit: 8 })).map((c) => ({
            label: c.label, members: num(c.member_count),
        }));
    } catch { clusters = []; }

    // How much history do we have? Drives the overall confidence label.
    let priorReports = 0;
    try {
        const r = await query('select count(*)::int n from trend_reports');
        priorReports = num(r.rows[0]?.n);
    } catch { priorReports = 0; }

    const hasPrevWeek = prevWeek.length > 0 || topics.some((t) => t.mentionsPrev > 0);
    let overallConfidence = 'building';
    if (priorReports >= 3 && hasPrevWeek) overallConfidence = 'high';
    else if (hasPrevWeek) overallConfidence = 'medium';
    else if (thisWeek.length >= 20) overallConfidence = 'low';

    return {
        periodDays: days,
        generatedAt: new Date().toISOString(),
        totals: {
            candidatesThisWeek: thisWeek.length,
            candidatesPrevWeek: prevWeek.length,
            totalViewsThisWeek: thisWeek.reduce((a, c) => a + num(c.play_count), 0),
            priorReports,
        },
        categories,
        platforms,
        topVideos,
        accelerating,
        topics,
        clusters,
        overallConfidence,
    };
}

// ─── The analyst LLM (synthesis only, evidence-constrained) ──────
const SYSTEM = `You are CeleriTech's social media trend analyst. You are given REAL measured data from this week's social scrape across THREE platforms (TikTok, Instagram Reels, YouTube Shorts): per-category and per-platform view counts and week-over-week growth, the hottest individual videos, fast-accelerating videos, and buyer-topic mention momentum with simple forecasts.

Your job:
1. Write a short, plain "summary" (3-5 sentences) of what is actually trending and what is gaining momentum this week. Cover the three industry lanes (companies going viral, food, oil & gas) AND note which platform is strongest for which content.
2. Propose specific content CeleriTech should make next week, and say which platform each idea fits best.

Hard rules:
- Use ONLY the numbers in the data. Every claim must cite a real figure (views, growth %, mentions, velocity). Never invent a trend or a statistic.
- If the data is thin or week-over-week history is missing, say so plainly and lower the confidence — do not overstate.
- CeleriTech sells "EZ solutions": ${MESSAGE_BANK.product}
  Buyer: ${MESSAGE_BANK.buyer}
- Tie each recommendation to a real signal in the data and to a buyer pain.
- Editorial rules for any copy: ${EDITORIAL_RULES.join('; ')}.

Return ONLY JSON:
{
  "summary": "<3-5 sentences citing real numbers>",
  "recommendations": [
    {
      "title": "<the content idea>",
      "format": "<short-form video format to use>",
      "category": "<companies|food|oil>",
      "platform": "<tiktok|instagram|youtube — best fit>",
      "angle": "<the CeleriTech / EZ solutions angle>",
      "why_now": "<why this is timely, cite the evidence number>",
      "evidence": "<the exact metric you are relying on, e.g. 'food views +180% WoW' or '195M-view noodle factory'>",
      "confidence": "<low|medium|high>"
    }
  ]
}
Give 4-6 recommendations, ordered by opportunity.`;

export async function generateReport({ days = 7 } = {}) {
    const signals = await computeSignals({ days });

    let summary = '';
    let recommendations = [];
    if (isLlmConfigured) {
        // Compact the signals so the prompt stays tight and cheap.
        const brief = {
            categories: signals.categories.map((c) => ({
                category: c.category,
                videos: c.videos,
                videoGrowthPct: Math.round(c.videoGrowth * 100),
                totalViews: c.totalViews,
                viewGrowthPct: Math.round(c.viewGrowth * 100),
                avgViews: c.avgViews,
                topVideos: c.topVideos.slice(0, 3).map((v) => ({ caption: v.caption, views: v.views })),
            })),
            platforms: signals.platforms.map((p) => ({
                platform: p.platform,
                videos: p.videos,
                totalViews: p.totalViews,
                avgViews: p.avgViews,
                viewGrowthPct: Math.round(p.viewGrowth * 100),
                topVideo: p.topVideos[0] ? { caption: p.topVideos[0].caption, views: p.topVideos[0].views } : null,
            })),
            hottestVideos: signals.topVideos.slice(0, 8).map((v) => ({ caption: v.caption, views: v.views, category: v.category })),
            accelerating: signals.accelerating.slice(0, 5).map((v) => ({ caption: v.caption, velocityPerHour: v.velocityPerHour })),
            risingTopics: signals.topics.filter((t) => t.direction === 'rising').slice(0, 8)
                .map((t) => ({ keyword: t.keyword, mentions: t.mentions, growthPct: Math.round(t.growth * 100), projectedNext: t.projectedNext, confidence: t.confidence })),
            allTopics: signals.topics.slice(0, 10).map((t) => ({ keyword: t.keyword, mentions: t.mentions, growthPct: Math.round(t.growth * 100) })),
            dataConfidence: signals.overallConfidence,
            note: signals.totals.candidatesPrevWeek === 0
                ? 'No previous-week data yet; this is the baseline run. Predictions are provisional.'
                : `Comparing ${signals.totals.candidatesThisWeek} videos this week vs ${signals.totals.candidatesPrevWeek} last week.`,
        };
        try {
            const parsed = await claudeJSON(SYSTEM, JSON.stringify(brief, null, 2), { maxTokens: 3000 });
            if (parsed) {
                summary = String(parsed.summary || '').trim();
                recommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations.slice(0, 8) : [];
            }
            if (!summary && !recommendations.length) {
                summary = 'The analyst could not produce a written brief this run, but the measured signals below (per-platform views, category momentum, top videos, rising topics) are accurate. Try regenerating.';
            }
        } catch (err) {
            summary = `Analyst LLM error: ${err.message}. The measured signals below are still accurate.`;
        }
    } else {
        summary = 'LLM not configured — showing measured signals only. Add ANTHROPIC_API_KEY for written recommendations.';
    }

    // Build the deterministic "trending" + "rising" views the UI renders.
    const trending = {
        categories: signals.categories,
        platforms: signals.platforms,
        topVideos: signals.topVideos,
        clusters: signals.clusters,
    };
    const rising = {
        topics: signals.topics,
        accelerating: signals.accelerating,
    };

    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - days * DAY);

    const r = await query(
        `insert into trend_reports
            (period_start, period_end, model, confidence, signals, trending, rising, summary, recommendations, status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'complete')
         returning *`,
        [
            periodStart.toISOString(),
            periodEnd.toISOString(),
            isLlmConfigured ? LLM_MODEL : null,
            signals.overallConfidence,
            JSON.stringify(signals),
            JSON.stringify(trending),
            JSON.stringify(rising),
            summary,
            JSON.stringify(recommendations),
        ]
    );
    return r.rows[0];
}

export async function getLatestReport() {
    const r = await query('select * from trend_reports order by generated_at desc limit 1');
    return r.rows[0] || null;
}

export async function listReports({ limit = 12 } = {}) {
    const r = await query(
        'select id, period_start, period_end, generated_at, confidence, summary from trend_reports order by generated_at desc limit $1',
        [limit]
    );
    return r.rows;
}

export async function getReport(id) {
    const r = await query('select * from trend_reports where id = $1', [id]);
    return r.rows[0] || null;
}
