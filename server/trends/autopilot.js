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

const SETTINGS_KEY = 'autopilot';

function safeParse(s) {
    if (!s) return null;
    if (typeof s === 'object') return s;
    try { return JSON.parse(s); } catch { return null; }
}

// ─── Settings (DB-backed so the UI toggle works without a redeploy) ──
export async function getSettings() {
    try {
        const { rows } = await query('select value from app_settings where key = $1', [SETTINGS_KEY]);
        const stored = safeParse(rows[0]?.value) || {};
        return { ...AUTOPILOT_DEFAULTS, ...stored };
    } catch {
        return { ...AUTOPILOT_DEFAULTS };
    }
}

export async function saveSettings(patch = {}) {
    const current = await getSettings();
    const next = {
        enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
        dailyCount: Math.min(Math.max(parseInt(patch.dailyCount ?? current.dailyCount, 10) || 1, 1), 10),
        outputType: ['video', 'slideshow', 'mix'].includes(patch.outputType) ? patch.outputType : current.outputType,
        targetMode: ['auto', 'exact'].includes(patch.targetMode) ? patch.targetMode : current.targetMode,
        minScore: Math.max(Number(patch.minScore ?? current.minScore) || 0, 0),
        cooldownDays: Math.max(parseInt(patch.cooldownDays ?? current.cooldownDays, 10) || 0, 0),
    };
    await query(
        `insert into app_settings (key, value, updated_at) values ($1,$2, now())
         on conflict (key) do update set value = $2, updated_at = now()`,
        [SETTINGS_KEY, JSON.stringify(next)]
    );
    return next;
}

// ─── Candidate selection ────────────────────────────────────────
// Best-scoring candidates we haven't remade recently. Ranked by our composite
// score (the merged ranking), with views as a tiebreaker. Skips anything below
// minScore or inside the cooldown window.
export async function pickCandidates({ count, minScore, cooldownDays }) {
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
        [minScore || 0, String(cooldownDays || 0), count]
    );
    return rows || [];
}

function reasonFor(row, winningFormats) {
    const a = safeParse(row.analysis) || {};
    const bits = [];
    if (row.composite_score) bits.push(`composite score ${Number(row.composite_score).toFixed(1)}`);
    if (row.play_count) bits.push(`${Number(row.play_count).toLocaleString()} views`);
    if (row.author_followers && row.play_count && row.author_followers > 0) {
        const ratio = row.play_count / row.author_followers;
        if (ratio >= 5) bits.push(`${ratio.toFixed(0)}x views-to-followers breakout`);
    }
    if (a.format && winningFormats.has(String(a.format).toLowerCase())) bits.push(`format matches a past winner`);
    return bits.join(', ') || 'top of the current ranking';
}

// ─── The daily run ──────────────────────────────────────────────
export async function runAutopilot({ trigger = 'manual', force = false } = {}) {
    const settings = await getSettings();
    if (!settings.enabled && !force) {
        return { skipped: 'autopilot disabled', settings };
    }

    const run = await query(
        `insert into autopilot_runs (status, trigger) values ('running', $1) returning *`,
        [trigger]
    );
    const runId = run.rows[0].id;

    try {
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
            // mix → alternate video/slideshow; otherwise honor the setting.
            const outputType = settings.outputType === 'mix'
                ? (i % 2 === 0 ? 'video' : 'slideshow')
                : settings.outputType;
            const reason = reasonFor(c, winningFormats);
            try {
                const { primary } = await directVariants(c.id, {
                    targetMode: settings.targetMode,
                    outputType,
                    variants: 1,
                });
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
        const notes = made
            ? `Started ${made} remake${made > 1 ? 's' : ''} from the top-scoring candidates. The chain will render them to the Queue automatically.`
            : 'No eligible candidates today (all recent picks are in cooldown, or none cleared the score floor). Ingest/score more, or lower the score floor.';

        await query(
            `update autopilot_runs set status='done', picked=$2, notes=$3, finished_at=now() where id=$1`,
            [runId, JSON.stringify(picked), notes]
        );
        return { runId, trigger, made, picked, notes, settings };
    } catch (err) {
        await query(
            `update autopilot_runs set status='error', error=$2, finished_at=now() where id=$1`,
            [runId, String(err.message).slice(0, 400)]
        ).catch(() => {});
        throw err;
    }
}

export async function recentRuns({ limit = 20 } = {}) {
    const { rows } = await query(
        `select * from autopilot_runs order by started_at desc limit $1`,
        [limit]
    );
    return rows || [];
}
