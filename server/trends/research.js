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

function exampleFromRow(row) {
    const a = safeParse(row.analysis) || {};
    const onScreen = Array.isArray(a.onScreenText) ? a.onScreenText : [];
    return {
        platform: row.platform,
        views: Number(row.play_count) || 0,
        composite: row.composite_score != null ? Number(row.composite_score) : null,
        hook: clip(a.hook, 200),
        onScreenText: onScreen.map((t) => clip(t, 120)).filter(Boolean).slice(0, 6),
        caption: clip(row.caption, 200),
        format: clip(a.format, 60),
        whyItWorks: Array.isArray(a.whyItWorks) ? clip(a.whyItWorks.join('; '), 240) : clip(a.whyItWorks, 240),
    };
}

// Pull real winning examples from our own corpus, ranked by our composite SCORE
// (the merged ranking — best-scoring videos win), biased toward the same
// platform/format, with play_count as the tiebreaker/fallback. Returns
// structured examples + a ready-to-inject text block.
export async function researchExamples({ platform, format, limit = 6 } = {}) {
    let rows = [];
    try {
        const r = await query(
            `select c.platform, c.caption, c.analysis,
                    coalesce(sc.composite_score, 0) as composite_score,
                    coalesce(s.play_count, 0) as play_count
               from candidates c
               left join lateral (
                    select play_count from snapshots
                    where candidate_id = c.id order by captured_at desc limit 1
               ) s on true
               left join lateral (
                    select composite_score from scores
                    where candidate_id = c.id order by scored_at desc limit 1
               ) sc on true
              where c.analysis is not null
              order by coalesce(sc.composite_score, 0) desc,
                       coalesce(s.play_count, 0) desc
              limit 60`,
            []
        );
        rows = r.rows || [];
    } catch {
        return { examples: [], block: '' };
    }
    if (!rows.length) return { examples: [], block: '' };

    const scored = rows.map((row) => {
        const e = exampleFromRow(row);
        // Rank primarily on our composite score; bias toward same platform/format.
        let rank = (e.composite || 0) * 1000 + (e.views || 0) / 1e6;
        if (platform && row.platform === platform) rank *= 1.4;
        if (format && e.format && e.format.toLowerCase().includes(String(format).toLowerCase())) rank *= 1.5;
        return { ...e, rank };
    })
        .filter((e) => e.hook || e.onScreenText.length)
        .sort((a, b) => b.rank - a.rank)
        .slice(0, limit);

    if (!scored.length) return { examples: [], block: '' };

    const lines = ['TOP-SCORING WINNERS from our own scraped data (ranked by our composite score) — lift and adapt this wording/structure; do NOT invent generic copy:'];
    scored.forEach((e, i) => {
        const sc = e.composite != null ? `, score ${e.composite.toFixed(1)}` : '';
        const parts = [`#${i + 1} (${e.platform}${e.views ? `, ${e.views.toLocaleString()} views` : ''}${sc}${e.format ? `, ${e.format}` : ''})`];
        if (e.hook) parts.push(`hook: "${e.hook}"`);
        if (e.onScreenText.length) parts.push(`on-screen text: ${e.onScreenText.map((t) => `"${t}"`).join(' / ')}`);
        if (e.caption) parts.push(`caption: "${e.caption}"`);
        if (e.whyItWorks) parts.push(`why it works: ${e.whyItWorks}`);
        lines.push(parts.join(' | '));
    });
    return { examples: scored, block: lines.join('\n') };
}

// The specific source we're recreating — its OWN hook/on-screen text/structure
// is the primary reference the new hook should be built from.
export async function sourceGrounding(candidateId) {
    if (!candidateId) return '';
    let row = null;
    try {
        const r = await query(
            `select c.platform, c.caption, c.analysis,
                    coalesce(s.play_count, 0) as play_count,
                    coalesce(sc.composite_score, 0) as composite_score
               from candidates c
               left join lateral (select play_count from snapshots where candidate_id=c.id order by captured_at desc limit 1) s on true
               left join lateral (select composite_score from scores where candidate_id=c.id order by scored_at desc limit 1) sc on true
              where c.id = $1`,
            [candidateId]
        );
        row = r.rows[0] || null;
    } catch {
        return '';
    }
    if (!row) return '';
    const e = exampleFromRow(row);
    if (!e.hook && !e.onScreenText.length) return '';
    const lines = ['THIS SOURCE VIDEO (build the new hook DIRECTLY off this — same hook mechanism, structure, and pacing; only swap the subject for the target):'];
    if (e.hook) lines.push(`- source hook: "${e.hook}"`);
    if (e.onScreenText.length) lines.push(`- source on-screen text: ${e.onScreenText.map((t) => `"${t}"`).join(' / ')}`);
    if (e.caption) lines.push(`- source caption: "${e.caption}"`);
    if (e.whyItWorks) lines.push(`- why it works: ${e.whyItWorks}`);
    return lines.join('\n');
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
// we have no data yet (cold start), so prompts degrade cleanly. When a
// sourceCandidateId is given, that video's own hook leads the block.
export async function buildResearchGrounding({ platform, format, outputType = null, sourceCandidateId = null } = {}) {
    const [src, winners, ours] = await Promise.all([
        sourceGrounding(sourceCandidateId).catch(() => ''),
        researchExamples({ platform, format }).catch(() => ({ block: '' })),
        ourTopPerformers({ outputType }).catch(() => ({ block: '' })),
    ]);
    return [src, ours.block, winners.block].filter(Boolean).join('\n\n');
}
