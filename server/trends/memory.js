// ═══════════════════════════════════════════════════════════════════
// Strategy memory — run-over-run learning
// A compounding log of short reflections ("what we made and why, what we
// observed"). Loaded back into the Director/Copy so the engine builds on prior
// runs instead of starting cold. Mirrors Viral-Bench's per-run notes.
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';

// Store a note. scope = 'global' or an industry/format tag; outputType optional.
export async function addNote({ note, scope = 'global', outputType = null } = {}) {
    const text = String(note || '').trim().slice(0, 2000);
    if (!text) return null;
    try {
        const { rows } = await query(
            `insert into strategy_notes (scope, output_type, note) values ($1,$2,$3) returning *`,
            [scope, outputType, text]
        );
        return rows[0];
    } catch {
        return null;
    }
}

// Recent notes, newest first. Filters to the output type (or untyped/global).
export async function recentNotes({ outputType = null, limit = 8 } = {}) {
    try {
        const { rows } = await query(
            `select note, output_type, created_at from strategy_notes
              where ($1::text is null or output_type is null or output_type = $1)
              order by created_at desc limit $2`,
            [outputType, limit]
        );
        return rows || [];
    } catch {
        return [];
    }
}

// Ready-to-inject memory block, or '' when empty (cold start).
export async function buildMemoryBlock({ outputType = null, limit = 8 } = {}) {
    const notes = await recentNotes({ outputType, limit });
    if (!notes.length) return '';
    const lines = ['STRATEGY MEMORY (notes from prior runs, newest first — use to steer direction, not as hard rules):'];
    notes.forEach((n, i) => lines.push(`[${i + 1}] ${n.note}`));
    return lines.join('\n');
}
