// ═══════════════════════════════════════════════════════════════════
// Autopilot — the autonomous daily agent.
// While the manual "Recreate" flow lets you hand-pick a video, Autopilot runs
// on its own: every day it scans ALL scored candidates + what's actually
// performed for us, picks the top N to remake, and kicks off the generation
// chain (video and/or slideshow). The existing chain cron then finishes the
// renders. Every pick is logged with the REASON it was chosen, so the feed in
// the Autopilot tab is fully auditable and visibly improves from our data.
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';
import { AUTOPILOT_DEFAULTS } from './config.js';
import { directVariants } from './director.js';
import { ourTopPerformers } from './research.js';
import { getOwnPageFormatScores, refreshOwnPage } from './ownpage.js';

// ─── Two parallel agents ────────────────────────────────────────
// • default  → the original autopilot: scans viral candidates and fits them to a
//   product / brand (targetMode auto | exact, chosen in the UI).
// • ownpage  → the "Instagram autopilot": same scan + ranking, but it ALWAYS
//   retargets the viral concept to what WE actually post on our Instagram page
//   (targetMode is locked to 'ownpage'). It lifts the format and tells one of
//   our own stories instead of fitting a product.
const AGENTS = {
    default: { settingsKey: 'autopilot', forceTargetMode: null },
    ownpage: { settingsKey: 'autopilot_ownpage', forceTargetMode: 'ownpage' },
};
function agentCfg(agent) {
    return AGENTS[agent] ? agent : 'default';
}

function safeParse(s) {
    if (!s) return null;
    if (typeof s === 'object') return s;
    try { return JSON.parse(s); } catch { return null; }
}

// ─── Settings (DB-backed so the UI toggle works without a redeploy) ──
export async function getSettings(agent = 'default') {
    const a = agentCfg(agent);
    const { settingsKey, forceTargetMode } = AGENTS[a];
    try {
        const { rows } = await query('select value from app_settings where key = $1', [settingsKey]);
        const stored = safeParse(rows[0]?.value) || {};
        const merged = { ...AUTOPILOT_DEFAULTS, ...stored, agent: a };
        if (forceTargetMode) merged.targetMode = forceTargetMode;
        return merged;
    } catch {
        const merged = { ...AUTOPILOT_DEFAULTS, agent: a };
        if (forceTargetMode) merged.targetMode = forceTargetMode;
        return merged;
    }
}

export async function saveSettings(patch = {}, agent = 'default') {
    const a = agentCfg(agent);
    const { settingsKey, forceTargetMode } = AGENTS[a];
    const current = await getSettings(a);
    const next = {
        enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
        dailyCount: Math.min(Math.max(parseInt(patch.dailyCount ?? current.dailyCount, 10) || 1, 1), 10),
        outputType: ['video', 'slideshow', 'mix'].includes(patch.outputType) ? patch.outputType : current.outputType,
        targetMode: forceTargetMode
            ? forceTargetMode
            : (['auto', 'exact'].includes(patch.targetMode) ? patch.targetMode : current.targetMode),
        minScore: Math.max(Number(patch.minScore ?? current.minScore) || 0, 0),
        cooldownDays: Math.max(parseInt(patch.cooldownDays ?? current.cooldownDays, 10) || 0, 0),
        autoPublish: typeof patch.autoPublish === 'boolean' ? patch.autoPublish : !!current.autoPublish,
    };
    await query(
        `insert into app_settings (key, value, updated_at) values ($1,$2, now())
         on conflict (key) do update set value = $2, updated_at = now()`,
        [settingsKey, JSON.stringify(next)]
    );
    return { ...next, agent: a };
}

// ─── Candidate selection ────────────────────────────────────────
// Picks the best candidates to remake, combining:
//   1. composite_score (how viral/relevant the source video is)
//   2. Performance feedback: formats/styles that worked for US on Instagram
//      get a score boost; formats that flopped get a penalty.
//   3. Own-page format scores: if our Instagram page shows reels outperform
//      images, reel-style candidates get boosted.
// This closes the feedback loop — the agent learns from what we actually post.
export async function pickCandidates({ count, minScore, cooldownDays }) {
    // Pull a wider pool so we can re-rank with performance data.
    const poolSize = Math.max(count * 10, 50);
    const { rows } = await query(
        `select c.id, c.platform, c.author_id, c.caption, c.analysis,
                c.author_followers,
                coalesce(sc.composite_score, 0) as composite_score,
                coalesce(s.play_count, 0)      as play_count
           from candidates c
           left join lateral (select composite_score from scores where candidate_id=c.id order by scored_at desc limit 1) sc on true
           left join lateral (select play_count from snapshots where candidate_id=c.id order by captured_at desc limit 1) s on true
          where coalesce(sc.composite_score, 0) >= $1
            and not exists (
                select 1 from generations g
                 where g.candidate_id = c.id
                   and g.created_at > now() - ($2 || ' days')::interval
            )
          order by coalesce(sc.composite_score, 0) desc,
                   coalesce(s.play_count, 0) desc
          limit $3`,
        [minScore || 0, String(cooldownDays || 0), poolSize]
    );
    if (!rows || !rows.length) return [];

    // ── Performance feedback: what formats/styles worked for us? ──────────
    // Query our actual posted generation performance grouped by output_type/format.
    let perfByFormat = {}; // format → { avgViews, avgEng, count }
    try {
        const { rows: perfRows } = await query(
            `select g.output_type, g.director_json,
                    avg(p.views) as avg_views,
                    avg(p.engagement_pct) as avg_eng,
                    count(*) as count
               from generation_performance p
               join generations g on g.id = p.generation_id
              group by g.output_type, g.director_json`
        );
        for (const r of perfRows) {
            const fmt = (safeParse(r.director_json)?.format || r.output_type || 'video').toLowerCase();
            if (!perfByFormat[fmt]) perfByFormat[fmt] = { avgViews: 0, avgEng: 0, count: 0 };
            // Keep the best-performing entry per format
            if (Number(r.avg_views) > perfByFormat[fmt].avgViews) {
                perfByFormat[fmt] = { avgViews: Number(r.avg_views), avgEng: Number(r.avg_eng), count: Number(r.count) };
            }
        }
    } catch (e) {
        console.warn('autopilot: could not load perf feedback:', e.message);
    }

    // Own-page format scores (what our IG audience responds to)
    let ownPageScores = {};
    try {
        ownPageScores = await getOwnPageFormatScores();
    } catch { /* non-fatal */ }

    // Compute overall performance averages for normalization
    const allAvgViews = Object.values(perfByFormat).map(p => p.avgViews);
    const globalAvgViews = allAvgViews.length ? allAvgViews.reduce((s, v) => s + v, 0) / allAvgViews.length : 0;

    const ownPageAvgEng = Object.values(ownPageScores).map(s => s.avgEngagement);
    const globalOwnEng = ownPageAvgEng.length ? ownPageAvgEng.reduce((s, v) => s + v, 0) / ownPageAvgEng.length : 0;

    // ── Score each candidate with a weighted composite ──────────────────
    const scored = rows.map(row => {
        const analysis = safeParse(row.analysis) || {};
        const candidateFormat = String(analysis.format || row.platform || 'video').toLowerCase();
        let weight = 1.0;

        // Boost if this format performed well for us (> global avg views)
        const perf = perfByFormat[candidateFormat];
        if (perf && perf.count >= 2 && globalAvgViews > 0) {
            const relPerf = perf.avgViews / globalAvgViews;
            if (relPerf >= 1.5) weight *= 1.5;        // big winner: strong boost
            else if (relPerf >= 1.1) weight *= 1.2;   // modest winner: light boost
            else if (relPerf < 0.5) weight *= 0.6;    // underperformer: penalize
        }

        // Boost if our own IG page shows this format gets above-average engagement
        const ownFmt = ownPageScores[candidateFormat] || ownPageScores['reel'];
        if (ownFmt && globalOwnEng > 0) {
            const relEng = ownFmt.avgEngagement / globalOwnEng;
            if (relEng >= 1.3) weight *= 1.3;
            else if (relEng < 0.7) weight *= 0.8;
        }

        // Prefer Instagram candidates when we have own-page data (same platform context)
        if (Object.keys(ownPageScores).length > 0 && row.platform === 'instagram') {
            weight *= 1.15;
        }

        const weightedScore = Number(row.composite_score) * weight;
        return { ...row, weightedScore, weight };
    });

    // Re-rank by weighted score, take the top N.
    scored.sort((a, b) => b.weightedScore - a.weightedScore || b.play_count - a.play_count);
    return scored.slice(0, count);
}

// Detect whether a source candidate is a VIDEO (reel/short) or a PHOTO
// SLIDESHOW (carousel). A video has a duration and/or a list of cuts; a
// carousel has neither. We follow the source so "mix" doesn't turn a viral
// video into a slideshow (or vice-versa).
function sourceOutputType(row) {
    const a = safeParse(row.analysis) || {};
    const dur = Number(a.durationSeconds) || 0;
    const hasClips = Array.isArray(a.clips) && a.clips.length > 0;
    const fmt = String(a.format || '').toLowerCase();
    const looksSlideshow = /carousel|slideshow|photo|image|swipe/.test(fmt);
    if (dur > 0 || hasClips) return 'video';          // clear video signal
    if (looksSlideshow) return 'slideshow';            // carousel with no video
    return 'video';                                    // default: short-form video
}

function reasonFor(row, winningFormats) {
    const a = safeParse(row.analysis) || {};
    const bits = [];
    if (row.composite_score) bits.push(`composite score ${Number(row.composite_score).toFixed(1)}`);
    if (row.weightedScore && row.weight && row.weight !== 1) {
        bits.push(`performance weight ×${row.weight.toFixed(2)} → weighted score ${Number(row.weightedScore).toFixed(1)}`);
    }
    if (row.play_count) bits.push(`${Number(row.play_count).toLocaleString()} views`);
    if (row.author_followers && row.play_count && row.author_followers > 0) {
        const ratio = row.play_count / row.author_followers;
        if (ratio >= 5) bits.push(`${ratio.toFixed(0)}x views-to-followers breakout`);
    }
    if (a.format && winningFormats.has(String(a.format).toLowerCase())) bits.push(`format matches a past winner on our page`);
    return bits.join(', ') || 'top of the current ranking';
}

// ─── The daily run ──────────────────────────────────────────────
export async function runAutopilot({ trigger = 'manual', force = false, agent = 'default' } = {}) {
    const a = agentCfg(agent);
    const settings = await getSettings(a);
    if (!settings.enabled && !force) {
        return { skipped: 'autopilot disabled', settings, agent: a };
    }

    let run;
    try {
        run = await query(
            `insert into autopilot_runs (status, trigger, agent) values ('running', $1, $2) returning *`,
            [trigger, a]
        );
    } catch (err) {
        // Pre-migration fallback: insert without the agent column.
        if (isMissingAgentColumn(err)) {
            run = await query(
                `insert into autopilot_runs (status, trigger) values ('running', $1) returning *`,
                [trigger]
            );
        } else {
            throw err;
        }
    }
    const runId = run.rows[0].id;

    try {
        // Refresh own-page data in the background (non-blocking — if it fails we continue).
        // This keeps the own-page cache fresh so format weights stay current.
        refreshOwnPage().catch(e => console.warn('own-page refresh error (non-fatal):', e.message));

        // What angles/formats have worked for us → bias selection + reasons.
        const perf = await ourTopPerformers({ limit: 5 }).catch(() => ({ performers: [] }));
        const winningFormats = new Set(
            (perf.performers || [])
                .map((p) => safeParse(p.director_json)?.format)
                .filter(Boolean)
                .map((f) => String(f).toLowerCase())
        );

        const candidates = await pickCandidates({
            count: settings.dailyCount,
            minScore: settings.minScore,
            cooldownDays: settings.cooldownDays,
        });

        const picked = [];
        for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];
            // mix → FOLLOW THE SOURCE: a viral video becomes a video, a viral
            // carousel becomes a slideshow. video/slideshow → honor the setting.
            const outputType = settings.outputType === 'mix'
                ? sourceOutputType(c)
                : settings.outputType;
            const reason = reasonFor(c, winningFormats);
            try {
                const { primary } = await directVariants(c.id, {
                    targetMode: settings.targetMode,
                    outputType,
                    variants: 1,
                });
                // If this agent auto-publishes, flag the generation so the chain
                // posts it to Instagram the moment it finishes rendering.
                if (settings.autoPublish && primary?.generation?.id) {
                    await query('update generations set auto_publish = true where id = $1', [primary.generation.id])
                        .catch((e) => console.warn('autopilot: could not flag auto_publish:', e.message));
                }
                picked.push({
                    candidate_id: c.id,
                    title: (safeParse(c.analysis)?.hook || c.caption || c.author_id || 'Remake').slice(0, 120),
                    reason,
                    score: Number(c.composite_score) || 0,
                    output_type: outputType,
                    generation_id: primary.generation.id,
                });
            } catch (err) {
                picked.push({ candidate_id: c.id, reason, output_type: outputType, error: String(err.message).slice(0, 200) });
            }
        }

        const made = picked.filter((p) => p.generation_id).length;
        const target = a === 'ownpage' ? ' (retargeted to our Instagram content)' : '';
        const notes = made
            ? `Started ${made} remake${made > 1 ? 's' : ''} from the top-scoring candidates${target}. The chain will render them to the Queue automatically.`
            : 'No eligible candidates today (all recent picks are in cooldown, or none cleared the score floor). Ingest/score more, or lower the score floor.';

        await query(
            `update autopilot_runs set status='done', picked=$2, notes=$3, finished_at=now() where id=$1`,
            [runId, JSON.stringify(picked), notes]
        );
        return { runId, trigger, agent: a, made, picked, notes, settings };
    } catch (err) {
        await query(
            `update autopilot_runs set status='error', error=$2, finished_at=now() where id=$1`,
            [runId, String(err.message).slice(0, 400)]
        ).catch(() => {});
        throw err;
    }
}

function isMissingAgentColumn(err) {
    return /column .*agent.* does not exist/i.test(err?.message || '');
}

export async function recentRuns({ limit = 20, agent = 'default' } = {}) {
    const a = agentCfg(agent);
    try {
        const { rows } = await query(
            `select * from autopilot_runs where coalesce(agent, 'default') = $1 order by started_at desc limit $2`,
            [a, limit]
        );
        return rows || [];
    } catch (err) {
        // Pre-migration: the agent column may not exist yet. Fall back so the
        // UI still loads. The ownpage agent simply has no history until migrated.
        if (isMissingAgentColumn(err)) {
            if (a !== 'default') return [];
            const { rows } = await query(
                `select * from autopilot_runs order by started_at desc limit $1`,
                [limit]
            );
            return rows || [];
        }
        throw err;
    }
}
