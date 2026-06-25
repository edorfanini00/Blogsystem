// ═══════════════════════════════════════════════════════════════════
// Trend Engine — Step 6: generation pipeline ("Recreate")
// Recreate turns a surfaced candidate into a draft video:
//   1. Claude writes a short-form script (hook, voiceover, on-screen text,
//      a visual prompt, and a posting caption) wrapped around the selected
//      solution and following the editorial rules.
//   2. The visual prompt is submitted to the fal.ai video queue (the same
//      engine the media studio already uses; Higgsfield/Veo/Kling are
//      swappable via TREND_VIDEO_MODEL).
//   3. A generations row is written and tracked through statuses:
//      script_only → rendering → review → approved → posted (or failed/killed).
// Rendering is async: /generations/:id/refresh polls fal until the asset
// is ready, which keeps each request well under the serverless time limit.
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';
import { getSolutionContext } from './solutions.js';
import { getCandidateMetrics } from './metrics.js';
import { claudeJSON, isLlmConfigured } from './llm.js';
import { MESSAGE_BANK, EDITORIAL_RULES } from './config.js';

const FAL_KEY = process.env.FAL_KEY;
const VIDEO_MODEL = process.env.TREND_VIDEO_MODEL || 'fal-ai/kling-video/v2/master/text-to-video';
const VIDEO_DURATION = process.env.TREND_VIDEO_DURATION || '5';

export const isVideoConfigured = !!FAL_KEY;
export const videoModel = VIDEO_MODEL;

// Feed the deep video analysis (real hook, transcript, on-screen text, format)
// into the script writer so the remake mirrors what actually made it work.
function analysisBlock(analysis) {
    const a = typeof analysis === 'string' ? safeParse(analysis) : analysis;
    if (!a) return '';
    const lines = ['', 'ORIGINAL VIDEO ANALYSIS (mirror its structure, swap in the CeleriTech angle):'];
    if (a.hook) lines.push(`Hook: ${a.hook}`);
    if (a.format) lines.push(`Format: ${a.format}`);
    if (a.pacing) lines.push(`Pacing: ${a.pacing}`);
    if (Array.isArray(a.onScreenText) && a.onScreenText.length) lines.push(`On-screen text: ${a.onScreenText.join(' | ').slice(0, 400)}`);
    if (a.transcript) lines.push(`Transcript: ${String(a.transcript).slice(0, 600)}`);
    if (Array.isArray(a.visualBreakdown) && a.visualBreakdown.length) lines.push(`Visual beats: ${a.visualBreakdown.join(' | ').slice(0, 500)}`);
    if (Array.isArray(a.whyItWorks) && a.whyItWorks.length) lines.push(`Why it works: ${a.whyItWorks.join('; ').slice(0, 400)}`);
    return lines.join('\n');
}

function safeParse(s) {
    try { return JSON.parse(s); } catch { return null; }
}

function solutionBlock(ctx) {
    if (ctx) {
        return [
            `Solution: ${ctx.name}`,
            ctx.description ? `What it is: ${ctx.description}` : '',
            ctx.buyer ? `Buyer: ${ctx.buyer}` : '',
            ctx.pains ? `Core pains: ${ctx.pains}` : '',
            ctx.hooks ? `Hooks: ${ctx.hooks}` : '',
            ctx.knowledge ? `Knowledge (excerpt):\n${String(ctx.knowledge).slice(0, 5000)}` : '',
        ].filter(Boolean).join('\n');
    }
    return [
        `Product: ${MESSAGE_BANK.product}`,
        `Buyer: ${MESSAGE_BANK.buyer}`,
        `Core pains: ${MESSAGE_BANK.corePains.join('; ')}`,
        `Hooks: ${MESSAGE_BANK.hooks.join('; ')}`,
        `Voice: ${MESSAGE_BANK.voice}`,
    ].join('\n');
}

const SYSTEM = `You write short-form video scripts for CeleriTech that recreate a trending video's FORMAT while carrying CeleriTech's message to a B2B buyer. Keep it 15–25 seconds. Mechanism first, plain and human.

Editorial rules (hard): ${EDITORIAL_RULES.join('; ')}.

Return ONLY JSON:
{
  "title": "<short internal title>",
  "hook": "<first 1-2 seconds spoken/text hook>",
  "voiceover": "<full voiceover narration, plain sentences>",
  "on_screen_text": ["<caption beat 1>", "<beat 2>", "..."],
  "visual_prompt": "<one vivid paragraph describing the video shots for a text-to-video model; concrete scenes, no on-screen text instructions>",
  "caption": "<posting caption>",
  "hashtags": ["<tag>", "..."]
}`;

async function writeScript(candidate, metrics, solutionContext) {
    if (!isLlmConfigured) throw new Error('ANTHROPIC_API_KEY not configured');
    const user = [
        'TRENDING VIDEO TO RECREATE',
        `Platform: ${candidate.platform}`,
        `Caption: ${candidate.caption || '(none)'}`,
        `Hashtags: ${(candidate.hashtags || []).join(', ') || '(none)'}`,
        `Plays: ${metrics.playCount ?? 'unknown'} (baseline ratio ${metrics.baselineRatio?.toFixed(1) ?? 'n/a'})`,
        analysisBlock(candidate.analysis),
        '',
        'CELERITECH CONTEXT',
        solutionBlock(solutionContext),
    ].filter(Boolean).join('\n');
    const script = await claudeJSON(SYSTEM, user, { maxTokens: 1400 });
    if (!script) throw new Error('Script generation returned no parsable JSON');
    return script;
}

async function submitVideo(visualPrompt) {
    const res = await fetch(`https://queue.fal.run/${VIDEO_MODEL}`, {
        method: 'POST',
        headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: visualPrompt, duration: VIDEO_DURATION }),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`fal non-JSON: ${text.slice(0, 160)}`); }
    if (!res.ok) throw new Error(`fal submit ${res.status}: ${text.slice(0, 160)}`);
    return data; // { request_id, status_url, response_url }
}

// Create a generation for a candidate.
export async function createGeneration(candidateId, { solutionId = null } = {}) {
    const { rows } = await query('select * from candidates where id = $1', [candidateId]);
    const candidate = rows[0];
    if (!candidate) throw new Error('Candidate not found');

    // Don't spawn a second render while one is already in flight for this
    // candidate; hand back the in-progress one instead.
    const active = await query(
        `select * from generations where candidate_id = $1 and status = 'rendering'
         order by created_at desc limit 1`,
        [candidateId]
    );
    if (active.rows[0]) return active.rows[0];

    const metrics = await getCandidateMetrics(candidateId);
    const solutionContext = solutionId ? await getSolutionContext(solutionId) : null;
    const script = await writeScript(candidate, metrics, solutionContext);

    let fal = null;
    let status = 'script_only';
    let error = null;
    if (FAL_KEY && script.visual_prompt) {
        try {
            fal = await submitVideo(script.visual_prompt);
            status = 'rendering';
        } catch (err) {
            error = err.message;
            status = 'script_only';
        }
    } else if (!FAL_KEY) {
        error = 'FAL_KEY not configured — script generated, video skipped';
    }

    const ins = await query(
        `insert into generations
            (candidate_id, solution_id, script, script_json, video_prompt, caption,
             status, model, fal_request_id, status_url, response_url, error)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         returning *`,
        [
            candidateId,
            solutionId || null,
            script.voiceover || '',
            JSON.stringify(script),
            script.visual_prompt || '',
            script.caption || '',
            status,
            VIDEO_MODEL,
            fal?.request_id || null,
            fal?.status_url || null,
            fal?.response_url || null,
            error,
        ]
    );
    return ins.rows[0];
}

function pickVideoUrl(result) {
    return (
        result?.video?.url ||
        result?.video_url ||
        (Array.isArray(result?.videos) && result.videos[0]?.url) ||
        result?.output?.video?.url ||
        null
    );
}

// Poll fal for a rendering generation; promote to review when the asset is ready.
export async function refreshGeneration(id) {
    const { rows } = await query('select * from generations where id = $1', [id]);
    const g = rows[0];
    if (!g) throw new Error('Generation not found');
    if (g.status !== 'rendering' || !g.status_url || !FAL_KEY) return g;

    const sres = await fetch(g.status_url, { headers: { Authorization: `Key ${FAL_KEY}` } });
    if (!sres.ok) {
        // Transient status error — leave it rendering so the next poll retries.
        return g;
    }
    const sdata = await sres.json().catch(() => ({}));

    if (sdata.status === 'COMPLETED') {
        const rres = await fetch(g.response_url, { headers: { Authorization: `Key ${FAL_KEY}` } });
        if (!rres.ok) {
            const body = await rres.text().catch(() => '');
            const upd = await query(
                `update generations set status = 'failed', error = $2 where id = $1 returning *`,
                [id, `result fetch ${rres.status}: ${body.slice(0, 200)}`]
            );
            return upd.rows[0];
        }
        const rdata = await rres.json().catch(() => ({}));
        const url = pickVideoUrl(rdata);
        if (!url) {
            // Completed but no asset URL — treat as a failure rather than a
            // "ready" review item with nothing to show.
            const upd = await query(
                `update generations set status = 'failed', error = $2 where id = $1 returning *`,
                [id, 'render completed but no video URL in response']
            );
            return upd.rows[0];
        }
        const upd = await query(
            `update generations set status = 'review', asset_url = $2 where id = $1 returning *`,
            [id, url]
        );
        return { ...upd.rows[0], _justReady: true };
    }
    if (sdata.status === 'FAILED' || sdata.status === 'ERROR') {
        const upd = await query(
            `update generations set status = 'failed', error = $2 where id = $1 returning *`,
            [id, JSON.stringify(sdata).slice(0, 300)]
        );
        return upd.rows[0];
    }
    return g; // IN_QUEUE / IN_PROGRESS
}

export async function listGenerations({ status = null, limit = 50 } = {}) {
    const params = [];
    let where = '';
    if (status) {
        params.push(status);
        where = 'where g.status = $1';
    }
    params.push(limit);
    const r = await query(
        `select g.*, c.url as source_url, c.caption as source_caption, c.platform, c.author_id
         from generations g
         join candidates c on c.id = g.candidate_id
         ${where}
         order by g.created_at desc limit $${params.length}`,
        params
    );
    return r.rows;
}

const VALID_STATUSES = [
    'drafted', 'directed', 'imaging', 'qc', 'animating', 'rendering', 'assembling',
    'script_only', 'review', 'approved', 'posted', 'killed', 'failed',
];

export async function updateGenerationStatus(id, status, approvedBy = 'web', { postedUrl = null } = {}) {
    if (!VALID_STATUSES.includes(status)) throw new Error(`Invalid status: ${status}`);
    const sets = ['status = $2'];
    const params = [id, status];
    if (status === 'approved') {
        params.push(approvedBy);
        sets.push(`approved_by = $${params.length}`);
    }
    if (status === 'posted') sets.push('posted_at = now()');
    if (postedUrl) {
        params.push(String(postedUrl).slice(0, 500));
        sets.push(`posted_url = $${params.length}`);
    }
    const r = await query(
        `update generations set ${sets.join(', ')} where id = $1 returning *`,
        params
    );
    return r.rows[0] || null;
}

export async function getGeneration(id) {
    const r = await query('select * from generations where id = $1', [id]);
    return r.rows[0] || null;
}
