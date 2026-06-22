// ═══════════════════════════════════════════════════════════════════
// Trend Engine — Step 4: the scorer (the core piece)
// For each candidate, an LLM rates how well CeleriTech's message can ride
// the trend (0–10), writes the one-line bridge, and buckets it. We combine
// that judgement with the hard signals from step 2 (baseline ratio,
// acceleration) and step 8 (topic wave) into a single composite score that
// decides what surfaces. Weights live in config.js.
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';
import { getCandidateMetrics, squash } from './metrics.js';
import { getSolutionContext } from './solutions.js';
import { listTopics, bestTopicMatch } from './topics.js';
import { claudeJSON, isLlmConfigured } from './llm.js';
import { SCORE_WEIGHTS, MESSAGE_BANK, EDITORIAL_RULES } from './config.js';

const VALID_BUCKETS = ['trendjack', 'clone_format', 'discard'];

// Caps used to normalise the hard signals into 0..1 before weighting.
const BASELINE_CAP = 50;      // 50x a creator's follower base = clearly viral
const ACCEL_CAP = 100000;     // plays/hour^2; tune from real data

// When a candidate has been deep-analyzed (frames/text/audio), give the scorer
// the real content instead of just the caption — it can judge the actual hook.
function analysisBlock(analysis) {
    const a = typeof analysis === 'string' ? safeParse(analysis) : analysis;
    if (!a) return '';
    const lines = ['', 'VIDEO ANALYSIS (from watching the actual video):'];
    if (a.hook) lines.push(`Hook: ${a.hook}`);
    if (a.format) lines.push(`Format: ${a.format}`);
    if (Array.isArray(a.onScreenText) && a.onScreenText.length) lines.push(`On-screen text: ${a.onScreenText.join(' | ').slice(0, 400)}`);
    if (a.transcript) lines.push(`Transcript: ${String(a.transcript).slice(0, 600)}`);
    if (a.sound) lines.push(`Sound: ${a.sound}`);
    if (Array.isArray(a.whyItWorks) && a.whyItWorks.length) lines.push(`Why it works: ${a.whyItWorks.join('; ').slice(0, 400)}`);
    return lines.join('\n');
}

function safeParse(s) {
    try { return JSON.parse(s); } catch { return null; }
}

function solutionBlock(ctx) {
    if (ctx) {
        const lines = [
            `Solution: ${ctx.name}`,
            ctx.description ? `What it is: ${ctx.description}` : '',
            ctx.buyer ? `Buyer: ${ctx.buyer}` : '',
            ctx.pains ? `Core pains: ${ctx.pains}` : '',
            ctx.hooks ? `Hooks: ${ctx.hooks}` : '',
        ].filter(Boolean);
        if (ctx.knowledge) {
            lines.push(`Knowledge (excerpt):\n${String(ctx.knowledge).slice(0, 4000)}`);
        }
        return lines.join('\n');
    }
    // Fall back to the global message bank.
    return [
        `Product: ${MESSAGE_BANK.product}`,
        `Buyer: ${MESSAGE_BANK.buyer}`,
        `Core pains: ${MESSAGE_BANK.corePains.join('; ')}`,
        `Hooks: ${MESSAGE_BANK.hooks.join('; ')}`,
    ].join('\n');
}

const SYSTEM = `You are the CeleriTech trend scorer. You judge whether a trending short-form video can be recreated to carry CeleriTech's message to its B2B buyer without feeling forced.

Rate the bridge from 0 to 10:
- 10 = the format maps almost perfectly onto a real buyer pain
- 5  = workable with a clever angle
- 0  = no honest connection; forcing it would look desperate

Bucket the candidate:
- "trendjack"    = ride this specific trend now; it is timely and the bridge is strong
- "clone_format" = the bridge is good but the format is evergreen, clone it anytime
- "discard"      = weak bridge, skip it

Write a "bridge_line": one plain sentence stating the CeleriTech angle for this video. Follow these editorial rules: ${EDITORIAL_RULES.join('; ')}.

Return ONLY JSON: {"bridge_score": <number 0-10>, "bucket": "<trendjack|clone_format|discard>", "bridge_line": "<one sentence>", "reason": "<short>"}`;

export async function scoreCandidate(candidate, { solutionContext = null, topics = null } = {}) {
    const metrics = await getCandidateMetrics(candidate.id);

    let llm = { bridge_score: 0, bucket: 'discard', bridge_line: '', reason: 'LLM not configured' };
    if (isLlmConfigured) {
        const user = [
            'TRENDING VIDEO',
            `Platform: ${candidate.platform}`,
            `Caption: ${candidate.caption || '(none)'}`,
            `Hashtags: ${(candidate.hashtags || []).join(', ') || '(none)'}`,
            `Creator followers: ${candidate.author_followers ?? 'unknown'}`,
            `Plays: ${metrics.playCount ?? 'unknown'}, baseline ratio: ${metrics.baselineRatio?.toFixed(1) ?? 'n/a'}, velocity/hr: ${metrics.velocity?.toFixed(0) ?? 'n/a'}`,
            analysisBlock(candidate.analysis),
            '',
            'CELERITECH CONTEXT',
            solutionBlock(solutionContext),
        ].filter(Boolean).join('\n');
        try {
            const parsed = await claudeJSON(SYSTEM, user, { maxTokens: 500 });
            if (parsed) llm = parsed;
            else llm = { bridge_score: 0, bucket: 'discard', bridge_line: '', reason: 'parse_failed' };
        } catch (err) {
            llm = { bridge_score: 0, bucket: 'discard', bridge_line: '', reason: `scorer_error: ${err.message}` };
        }
    }

    // Topics are loaded once per batch; fall back to a fresh read if not passed.
    const topicList = topics || (await listTopics().catch(() => []));
    const { wave: topicWave, topicId } = bestTopicMatch(candidate.caption, candidate.hashtags, topicList);

    const bridge10 = Math.max(0, Math.min(10, Number(llm.bridge_score) || 0));
    const bridgeN = bridge10 / 10;
    const baselineN = squash(metrics.baselineRatio, BASELINE_CAP);
    const accelN = metrics.acceleration > 0 ? squash(metrics.acceleration, ACCEL_CAP) : 0;

    const w = SCORE_WEIGHTS;
    const composite =
        w.bridge * bridgeN +
        w.baselineRatio * baselineN +
        w.acceleration * accelN +
        w.topicWave * topicWave;

    // Default unrecognised buckets to discard (fail safe, not surface).
    let bucket = VALID_BUCKETS.includes(llm.bucket) ? llm.bucket : 'discard';
    if (bridge10 < 3) bucket = 'discard';

    await query(
        `insert into scores (candidate_id, bucket, bridge_score, bridge_line, composite_score, topic_id)
         values ($1,$2,$3,$4,$5,$6)`,
        [candidate.id, bucket, bridge10, (llm.bridge_line || '').trim(), Number(composite.toFixed(4)), topicId]
    );

    return {
        id: candidate.id,
        bucket,
        bridgeScore: bridge10,
        bridgeLine: (llm.bridge_line || '').trim(),
        composite: Number(composite.toFixed(4)),
        topicWave,
        reason: llm.reason,
        ...metrics,
    };
}

// Score a batch. By default only candidates that have never been scored;
// pass rescore=true to re-rate everything (e.g. after changing the solution).
export async function scoreBatch({ limit = 20, rescore = false, solutionId = null } = {}) {
    const solutionContext = solutionId ? await getSolutionContext(solutionId) : null;
    // Load topic waves once for the whole batch (avoids an N+1 read per candidate).
    const topics = await listTopics().catch(() => []);

    const sql = rescore
        ? 'select * from candidates order by first_seen_at desc limit $1'
        : `select c.* from candidates c
           where not exists (select 1 from scores s where s.candidate_id = c.id)
           order by c.first_seen_at desc limit $1`;
    const { rows } = await query(sql, [limit]);

    const results = [];
    for (const c of rows) {
        try {
            results.push(await scoreCandidate(c, { solutionContext, topics }));
        } catch (err) {
            results.push({ id: c.id, error: err.message });
        }
    }
    return {
        requested: rows.length,
        scored: results.filter((r) => !r.error).length,
        errors: results.filter((r) => r.error).length,
        usedSolution: solutionContext ? solutionContext.name : null,
        results,
    };
}
