// ═══════════════════════════════════════════════════════════════════
// Video Generation — Motion agent (spec §8)
// Each QC'd still is animated by Higgsfield DoP (image-to-video). DoP takes a
// free-text motion/camera prompt, so this agent translates the Director's
// per-shot motion_intent into a concrete, single-take camera + subject motion
// brief that reads well in 9:16 and matches the source video's energy. It
// writes one tight prompt per shot (batched in a single LLM call) and stores it
// on the shot as motion_prompt for the Video agent to consume.
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';
import { claudeJSON, isLlmConfigured } from './llm.js';

export const isMotionConfigured = isLlmConfigured;

const SYSTEM = `You are the motion director for a short-form vertical (9:16) video remake. Each shot is already a finished still image; you write the camera + subject motion that brings it to life for an image-to-video model (Higgsfield DoP).

Rules for every motion prompt:
- One continuous take, 3-5 seconds. No cuts, no scene changes, no new objects appearing.
- Describe only what MOVES: camera move (push in, slow pan, orbit, handheld drift, rack focus, tilt) and any subject/ambient motion (a glance, steam rising, a UI value ticking up, hair moving). Keep the framing and content of the still intact.
- Match the source video's energy and the shot's role: the hero/hook shot gets the strongest, scroll-stopping move; resolution shots are calmer.
- Plain, concrete, present-tense. No on-screen text instructions, no edits, no transitions, no audio. 1-2 sentences, under 40 words.

Return JSON only, one entry per shot in order:
{ "motions": [ { "index": 0, "motion_prompt": "..." } ] }`;

function shotLine(s) {
    return [
        `index ${s.index} — role ${s.role}`,
        s.motion_intent ? `intent: ${s.motion_intent}` : '',
        s.image_prompt ? `still: ${String(s.image_prompt).slice(0, 320)}` : '',
        s.on_screen_text ? `on-screen text present: "${String(s.on_screen_text).slice(0, 120)}"` : '',
    ].filter(Boolean).join(' | ');
}

async function loadGen(generationId) {
    const { rows } = await query(
        `select g.*, c.platform, c.caption as source_caption
         from generations g join candidates c on c.id = g.candidate_id
         where g.id = $1`,
        [generationId]
    );
    return rows[0] || null;
}

// Sensible fallback so a shot is never left without a motion prompt even if the
// LLM omits one (the Video agent must have something to send DoP).
function fallbackMotion(shot) {
    if (shot.motion_intent) return shot.motion_intent;
    if (shot.role === 'hero') return 'Slow, deliberate push-in on the subject with a subtle handheld drift; energy builds to stop the scroll.';
    if (shot.role === 'resolution') return 'Gentle, steady camera hold with a slight settle; calm and confident.';
    return 'Smooth, slow camera move that keeps the subject centered, with subtle ambient motion.';
}

// Write a motion_prompt for every shot. Idempotent: re-running refreshes any
// shots still missing a motion prompt (and fills all on first run). Leaves
// status unchanged; the Video agent advances state.
export async function runMotion(generationId) {
    if (!isMotionConfigured) throw new Error('ANTHROPIC_API_KEY not configured (needed for the Motion agent).');
    const gen = await loadGen(generationId);
    if (!gen) throw new Error('Generation not found');
    const shots = Array.isArray(gen.shots) ? gen.shots : [];
    if (!shots.length) throw new Error('No shots to animate (run the Director first)');

    const user = [
        `Platform: ${gen.platform}`,
        gen.source_caption ? `Source caption (energy reference): ${String(gen.source_caption).slice(0, 200)}` : '',
        `Target: ${gen.resolved_target || 'CeleriTech'}`,
        '',
        'SHOTS:',
        ...shots.map(shotLine),
    ].filter(Boolean).join('\n');

    let out = null;
    try {
        out = await claudeJSON(SYSTEM, user, { maxTokens: 1200 });
    } catch (err) {
        // Don't hard-fail the chain on an LLM hiccup; fall back per shot below.
        out = null;
    }

    const byIndex = new Map();
    if (out && Array.isArray(out.motions)) {
        for (const m of out.motions) {
            if (typeof m.index === 'number' && m.motion_prompt) {
                byIndex.set(m.index, String(m.motion_prompt).trim());
            }
        }
    }

    let written = 0, fellback = 0;
    shots.forEach((s, i) => {
        const idx = typeof s.index === 'number' ? s.index : i;
        const prompt = byIndex.get(idx);
        if (prompt) { s.motion_prompt = prompt; written++; }
        else if (!s.motion_prompt) { s.motion_prompt = fallbackMotion(s); fellback++; }
    });

    await query(`update generations set shots = $2 where id = $1`, [generationId, JSON.stringify(shots)]);
    return { generationId, total: shots.length, written, fellback };
}
