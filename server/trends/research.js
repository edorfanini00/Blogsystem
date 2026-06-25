// ═══════════════════════════════════════════════════════════════════
// Research brain — "lift, don't invent"
// Instead of letting the LLM freestyle hooks and copy from its priors (which
// read generic/AI), we ground every generation in REAL winning material we
// already have: top-performing analyzed source videos (their hooks, on-screen
// text, captions) and — once we have a feedback loop — what actually performed
// for US. This mirrors the Viral-Bench principle: assemble and adapt proven
// copy, don't write fresh copy.
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';

function safeParse(s) {
    if (!s) return null;
    if (typeof s === 'object') return s;
    try { return JSON.parse(s); } catch { return null; }
}

function clip(s, n) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n); }

// Pull real winning examples from our own analyzed corpus, ranked by latest
// play_count, biased toward the same platform/format. Returns structured
// examples + a ready-to-inject text block.
export async function researchExamples({ platform, format, limit = 6 } = {}) {
    let rows = [];
    try {
        const r = await query(
            `select c.platform, c.caption, c.analysis,
                    coalesce(s.play_count, 0) as play_count
               from candidates c
               left join lateral (
                    select play_count from snapshots
                    where candidate_id = c.id order by captured_at desc limit 1
               ) s on true
              where c.analysis is not null
              order by coalesce(s.play_count, 0) desc
              limit 60`,
            []
        );
        rows = r.rows || [];
    } catch {
        return { examples: [], block: '' };
    }
    if (!rows.length) return { examples: [], block: '' };

    const scored = rows.map((row) => {
        const a = safeParse(row.analysis) || {};
        let score = Number(row.play_count) || 0;
        if (platform && row.platform === platform) score *= 1.4;
        if (format && a.format && String(a.format).toLowerCase().includes(String(format).toLowerCase())) score *= 1.5;
        const onScreen = Array.isArray(a.onScreenText) ? a.onScreenText : [];
        return {
            score,
            platform: row.platform,
            views: Number(row.play_count) || 0,
            hook: clip(a.hook, 200),
            onScreenText: onScreen.map((t) => clip(t, 120)).filter(Boolean).slice(0, 6),
            caption: clip(row.caption, 200),
            format: clip(a.format, 60),
            whyItWorks: Array.isArray(a.whyItWorks) ? clip(a.whyItWorks.join('; '), 240) : clip(a.whyItWorks, 240),
        };
    })
        // Need at least a hook or on-screen text to be useful as a copy example.
        .filter((e) => e.hook || e.onScreenText.length)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    if (!scored.length) return { examples: [], block: '' };

    const lines = ['REAL WINNING EXAMPLES from our own scraped data — lift and adapt this wording/structure; do NOT invent generic copy:'];
    scored.forEach((e, i) => {
        const parts = [`#${i + 1} (${e.platform}${e.views ? `, ${e.views.toLocaleString()} views` : ''}${e.format ? `, ${e.format}` : ''})`];
        if (e.hook) parts.push(`hook: "${e.hook}"`);
        if (e.onScreenText.length) parts.push(`on-screen text: ${e.onScreenText.map((t) => `"${t}"`).join(' / ')}`);
        if (e.caption) parts.push(`caption: "${e.caption}"`);
        if (e.whyItWorks) parts.push(`why it works: ${e.whyItWorks}`);
        lines.push(parts.join(' | '));
    });
    return { examples: scored, block: lines.join('\n') };
}

// What actually performed for US (closed feedback loop). Top posted generations
// by recorded views, with the angle/format we used. Empty until we post + scrape.
export async function ourTopPerformers({ outputType = null, limit = 5 } = {}) {
    let rows = [];
    try {
        const r = await query(
            `select g.resolved_target, g.target_mode, g.output_type, g.director_json,
                    p.views, p.likes, p.comments, p.shares, p.saves, p.engagement_pct, p.platform
               from generation_performance p
               join generations g on g.id = p.generation_id
               join lateral (
                    select max(captured_at) as latest from generation_performance
                    where generation_id = p.generation_id
               ) m on m.latest = p.captured_at
              ${outputType ? 'where g.output_type = $1' : ''}
              order by p.views desc nulls last
              limit ${outputType ? '$2' : '$1'}`,
            outputType ? [outputType, limit] : [limit]
        );
        rows = r.rows || [];
    } catch {
        return { performers: [], block: '' };
    }
    if (!rows.length) return { performers: [], block: '' };

    const lines = ['WHAT HAS WORKED FOR US (real metrics on what we posted — lean into these angles/formats):'];
    rows.forEach((row, i) => {
        const fmt = safeParse(row.director_json)?.format || '';
        lines.push(`#${i + 1} ${row.output_type || 'video'}${fmt ? `/${fmt}` : ''} — target "${clip(row.resolved_target, 80)}" — ${Number(row.views || 0).toLocaleString()} views, ${row.engagement_pct ?? 0}% eng.`);
    });
    return { performers: rows, block: lines.join('\n') };
}

// Combined grounding block for the Director/Copy. Best-effort: returns '' when
// we have no data yet (cold start), so prompts degrade cleanly.
export async function buildResearchGrounding({ platform, format, outputType = null } = {}) {
    const [winners, ours] = await Promise.all([
        researchExamples({ platform, format }).catch(() => ({ block: '' })),
        ourTopPerformers({ outputType }).catch(() => ({ block: '' })),
    ]);
    return [ours.block, winners.block].filter(Boolean).join('\n\n');
}
