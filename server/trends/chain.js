// ═══════════════════════════════════════════════════════════════════
// Video Generation — chain runner (server-side orchestration)
// The remake chain is several long-running, resumable stages. Driving it from
// the browser is fragile (close the tab → stalls). This module advances any
// generation that is mid-flight by ONE bounded step, and a cron endpoint sweeps
// all active generations on a schedule so renders finish on their own.
//
// Stage map:
//   directed  → render images        (Image agent, staged)
//   imaging   → render images         (resume gaps)
//   qc        → grade + improve loop  (QC gate)
//   animating → motion + animate      (Video agent, staged)
//   assembling→ stitch + VO + final   (Assembly agent)
// Each step is idempotent and resumable, so a missed/duplicated tick is safe.
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';
import { runImages, isImageConfigured } from './image.js';
import { runQc, isQcConfigured } from './qc.js';
import { runVideo, isVideoAgentConfigured } from './video.js';
import { runAssembly, isAssemblyConfigured } from './assembly.js';

const ACTIVE_STATUSES = ['directed', 'imaging', 'qc', 'animating', 'assembling'];

// Advance one generation by a single bounded step. Returns a small summary.
// Never throws: a stage error is recorded on the row and the status is left so
// the next tick (or a manual retry) can pick it up.
export async function advanceGeneration(id) {
    const { rows } = await query('select id, status from generations where id = $1', [id]);
    const g = rows[0];
    if (!g) return { id, skipped: 'not found' };
    if (!ACTIVE_STATUSES.includes(g.status)) return { id, status: g.status, skipped: 'not active' };

    try {
        if (g.status === 'directed' || g.status === 'imaging') {
            if (!isImageConfigured) return { id, status: g.status, skipped: 'image not configured' };
            const out = await runImages(id, { max: 3 });
            return { id, step: 'images', ...out };
        }
        if (g.status === 'qc') {
            if (!isQcConfigured) return { id, status: g.status, skipped: 'qc not configured' };
            const out = await runQc(id);
            return { id, step: 'qc', ...out };
        }
        if (g.status === 'animating') {
            if (!isVideoAgentConfigured) return { id, status: g.status, skipped: 'video not configured' };
            const out = await runVideo(id, { max: 2 });
            return { id, step: 'video', ...out };
        }
        if (g.status === 'assembling') {
            if (!isAssemblyConfigured) return { id, status: g.status, skipped: 'assembly not configured' };
            const out = await runAssembly(id);
            return { id, step: 'assemble', status: out.status, asset_url: out.asset_url };
        }
    } catch (err) {
        await query('update generations set error = $2 where id = $1', [id, String(err.message).slice(0, 400)]).catch(() => {});
        return { id, status: g.status, error: err.message };
    }
    return { id, status: g.status };
}

// Sweep all active generations, advancing each by one step, oldest first, until
// a wall-clock budget is hit (keeps us under the serverless maxDuration). Call
// repeatedly (cron) to push everything to 'review'.
export async function runChainSweep({ budgetMs = 240000, limit = 25 } = {}) {
    const { rows } = await query(
        `select id, status from generations
         where status = any($1)
         order by created_at asc
         limit $2`,
        [ACTIVE_STATUSES, limit]
    );
    const start = Date.now();
    const steps = [];
    for (const g of rows) {
        if (Date.now() - start > budgetMs) { steps.push({ id: g.id, skipped: 'time budget' }); break; }
        steps.push(await advanceGeneration(g.id));
    }
    return { active: rows.length, advanced: steps.length, steps };
}
