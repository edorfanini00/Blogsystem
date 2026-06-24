// ═══════════════════════════════════════════════════════════════════
// Video Generation — Director agent (spec §4)
// Turns a viral source video's analysis + a resolved target into a shot
// plan that REPRODUCES the source's format, hook, style and visuals while
// changing only the content so it sells the target. This agent carries most
// of the craft; every downstream agent (image → qc → motion → video →
// assembly → copy) reads from its output.
//
// Method is image-first: the Director writes 4-layer image prompts per shot
// and flags use_source_frame where the source composition should be copied.
// It never goes straight to a text-to-video prompt.
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';
import { getProductEntry, listProductsBrief } from './solutions.js';
import { claudeJSON, isLlmConfigured } from './llm.js';
import { EDITORIAL_RULES, MESSAGE_BANK, REMAKE_VARIANTS } from './config.js';

const MODEL_CHOICES = ['nano_banana_pro', 'seedream', 'grok'];
const SHOT_ROLES = ['hero', 'setup', 'action', 'resolution'];

// Map analyze.js output → the spec's deep_analysis contract (§1).
function mapDeepAnalysis(analysis) {
    const a = typeof analysis === 'string' ? safeParse(analysis) : analysis;
    if (!a) return null;
    return {
        hook: a.hook || '',
        on_screen_text: Array.isArray(a.onScreenText) ? a.onScreenText.join(' | ') : (a.on_screen_text || ''),
        transcript_paraphrase: a.transcript || a.transcript_paraphrase || '',
        visual_beats: Array.isArray(a.visualBreakdown) ? a.visualBreakdown : (a.visual_beats || []),
        format: a.format || '',
        pacing: a.pacing || '',
        why_it_works: Array.isArray(a.whyItWorks) ? a.whyItWorks.join('; ') : (a.why_it_works || ''),
    };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

// Build the human-readable analysis block fed to the Director.
function analysisBriefText(deep) {
    if (!deep) {
        return 'No deep analysis available. Infer the format from the caption and treat it as a generic short-form hook video; keep the structure simple (hero shot + one or two beats).';
    }
    const lines = ['SOURCE VIDEO ANALYSIS (mirror this exactly, swap only the content):'];
    if (deep.hook) lines.push(`Hook (first 3s): ${deep.hook}`);
    if (deep.format) lines.push(`Format: ${deep.format}`);
    if (deep.pacing) lines.push(`Pacing: ${deep.pacing}`);
    if (deep.on_screen_text) lines.push(`On-screen text: ${String(deep.on_screen_text).slice(0, 400)}`);
    if (deep.transcript_paraphrase) lines.push(`Transcript: ${String(deep.transcript_paraphrase).slice(0, 600)}`);
    if (Array.isArray(deep.visual_beats) && deep.visual_beats.length) {
        lines.push(`Visual beats: ${deep.visual_beats.join(' | ').slice(0, 600)}`);
    }
    if (deep.why_it_works) lines.push(`Why it works: ${String(deep.why_it_works).slice(0, 400)}`);
    return lines.join('\n');
}

// Render a product entry as a target block.
function productTargetText(p) {
    const ed = p.editorial || {};
    return [
        'TARGET: product remake. Sell this product, keep the source format.',
        `Product: ${p.name}`,
        p.one_liner ? `What it is: ${p.one_liner}` : '',
        p.buyer ? `Buyer: ${p.buyer}` : '',
        p.pains?.length ? `Pains it removes: ${p.pains.join('; ')}` : '',
        p.proof_points?.length ? `Proof points: ${p.proof_points.join('; ')}` : '',
        p.visual_cues?.length ? `Visual cues (what it looks like on screen): ${p.visual_cues.join('; ')}` : '',
        p.message_bank?.length ? `Approved angles/phrasings: ${p.message_bank.join(' | ')}` : '',
        ed.required_framing ? `Required framing: ${ed.required_framing}` : '',
        ed.banned_terms?.length ? `Banned terms (never use): ${ed.banned_terms.join(', ')}` : '',
        ed.notes ? `Editorial notes: ${ed.notes}` : '',
        p.knowledge ? `Knowledge excerpt:\n${String(p.knowledge).slice(0, 2500)}` : '',
    ].filter(Boolean).join('\n');
}

// Default brand block when no product is selected (auto with no products / fallback).
function defaultBrandText() {
    return [
        `Product: ${MESSAGE_BANK.product}`,
        `Buyer: ${MESSAGE_BANK.buyer}`,
        `Pains it removes: ${MESSAGE_BANK.corePains.join('; ')}`,
        `Angles: ${MESSAGE_BANK.hooks.join('; ')}`,
    ].join('\n');
}

// Resolve what this remake is about into a target block + a resolved label.
// product → load entry; custom → user prompt; auto → bridge line, optionally
// choosing the best-fit product (the Director makes the final pick).
async function resolveTarget({ targetMode, productId, customPrompt }, candidate, score) {
    const mode = targetMode || 'auto';
    if (mode === 'product') {
        if (!productId) throw new Error('target_mode=product requires product_id');
        const p = await getProductEntry(productId);
        if (!p) throw new Error('Product not found');
        return { mode, block: productTargetText(p), resolvedHint: p.name, productId: p.product_id };
    }
    if (mode === 'custom') {
        const text = (customPrompt || '').trim();
        if (!text) throw new Error('target_mode=custom requires a custom_prompt');
        return {
            mode,
            block: `TARGET: custom. Remake this video to be about the following, keeping the source format:\n"${text}"\n\nBrand context for tone:\n${defaultBrandText()}`,
            resolvedHint: 'custom',
            productId: null,
        };
    }
    // auto: prefer the trend engine's bridge line; offer the product catalog so
    // the Director can choose the best-fit entry itself.
    const bridge = score?.bridge_line || '';
    const products = await listProductsBrief().catch(() => []);
    const catalog = products.length
        ? 'Available products to choose from (pick the single best fit and name it in resolved_target):\n' +
          products.map((p) => `- ${p.name}: ${p.one_liner}${p.buyer ? ` (buyer: ${p.buyer})` : ''}`).join('\n')
        : '';
    return {
        mode,
        block: [
            'TARGET: auto. Decide what this remake should sell.',
            bridge ? `Trend-engine angle (preferred starting point): ${bridge}` : '',
            catalog,
            catalog ? '' : `If no product fits, use the brand context:\n${defaultBrandText()}`,
        ].filter(Boolean).join('\n'),
        resolvedHint: bridge ? 'auto (bridge line)' : 'auto',
        productId: null,
    };
}

const SYSTEM = `You are the director for a short-form video remake. You receive the analysis of a viral video (hook, format, beats, pacing, why it works) and a target that says what this remake should be about. The target is one of: a product entry from the knowledge base, a custom prompt written by the user, or auto (use the provided bridge line or choose the best-fit product yourself).

Your job: reproduce the source video's structure, hook, style, and visuals exactly, and change only the content so it sells the target. Same beats, same pacing, same shot progression, same camera language. Swap what the video is about, not how it is built. Faithful replication over invention.

For each shot, write an image prompt using the 4 Layers Method, in full sentences, like a director briefing a photographer:
- Scene: where it happens, matching the source's setting type but dressed for the target (use the target visual cues when relevant).
- Subject: who or what is in frame, matching the source's framing. Use ORIGINAL generated people only. Never real public figures or copyrighted characters.
- Atmosphere: lighting, mood, environmental effects, particles, matching the source.
- Camera: shot type, angle, lens, aperture, depth of field, style. Match the source's camera language.

Rules:
- Where the source composition should be copied closely, set use_source_frame true so the image agent passes the source frame as a structural reference and only swaps subject and context.
- The first shot (role "hero") must match the energy of the source hook and stop the scroll: clear subject, strong contrast, emotion or tension.
- If the source uses on-screen text, write the target equivalent. Keep it short.
- model_choice per shot: "nano_banana_pro" (default; precision, on-screen text, packaging, dashboards, branded headlines), "seedream" (multi-shot stories where the same generated subject must look identical across shots), "grok" (fast photographic meme/trendjack scroll-stoppers).
- Apply these editorial rules to ALL on-screen text and any copy, plus any product editorial overrides (banned terms, required framing): ${EDITORIAL_RULES.join('; ')}.

Return JSON only:
{
  "format": "single | story",
  "resolved_target": "product name | custom | auto-selected product",
  "shots": [
    {
      "role": "hero | setup | action | resolution",
      "image_prompt": "full 4-layer prompt in complete sentences",
      "use_source_frame": true,
      "on_screen_text": "",
      "model_choice": "nano_banana_pro | seedream | grok",
      "motion_intent": "what should move when this still is animated"
    }
  ]
}`;

function normalizeShots(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map((s, i) => ({
        index: i,
        role: SHOT_ROLES.includes(s.role) ? s.role : (i === 0 ? 'hero' : 'action'),
        image_prompt: String(s.image_prompt || '').trim(),
        use_source_frame: s.use_source_frame === true || s.use_source_frame === 'true',
        on_screen_text: String(s.on_screen_text || '').trim(),
        model_choice: MODEL_CHOICES.includes(s.model_choice) ? s.model_choice : 'nano_banana_pro',
        motion_intent: String(s.motion_intent || '').trim(),
    })).filter((s) => s.image_prompt);
}

// Load a candidate plus its latest score (bridge line + bucket).
async function loadCandidate(candidateId) {
    const { rows } = await query(
        `select c.*, s.bridge_line, s.bucket
         from candidates c
         left join lateral (
            select bridge_line, bucket from scores
            where candidate_id = c.id order by scored_at desc limit 1
         ) s on true
         where c.id = $1`,
        [candidateId]
    );
    return rows[0] || null;
}

// Run the Director. Returns the shot plan + the concept brief it consumed.
export async function runDirector(candidateId, { targetMode = 'auto', productId = null, customPrompt = null } = {}) {
    if (!isLlmConfigured) throw new Error('ANTHROPIC_API_KEY not configured');
    const candidate = await loadCandidate(candidateId);
    if (!candidate) throw new Error('Candidate not found');

    const deep = mapDeepAnalysis(candidate.analysis);
    const target = await resolveTarget({ targetMode, productId, customPrompt }, candidate, { bridge_line: candidate.bridge_line });

    const sourceMediaUrl = candidate.media_url || candidate.url || '';
    const user = [
        'CONCEPT BRIEF',
        `Platform: ${candidate.platform}`,
        `Bucket: ${candidate.bucket || 'unknown'}`,
        `Source video (structural + motion reference): ${sourceMediaUrl}`,
        candidate.caption ? `Source caption: ${candidate.caption}` : '',
        '',
        analysisBriefText(deep),
        '',
        target.block,
    ].filter(Boolean).join('\n');

    const plan = await claudeJSON(SYSTEM, user, { maxTokens: 2600 });
    if (!plan) throw new Error('Director returned no parsable JSON');

    const shots = normalizeShots(plan.shots);
    if (!shots.length) throw new Error('Director produced no usable shots');

    return {
        candidate_id: candidateId,
        platform: candidate.platform,
        source_media_url: sourceMediaUrl,
        target_mode: target.mode,
        product_id: target.productId,
        resolved_target: plan.resolved_target || target.resolvedHint,
        format: plan.format === 'story' ? 'story' : (shots.length > 1 ? 'story' : 'single'),
        has_deep_analysis: !!deep,
        shots,
    };
}

// Run the Director and persist it as a generation in status "directed" so the
// downstream chain (image → qc → motion → video → assembly) can pick it up.
// Per-shot pipeline state is seeded into the shots column.
export async function directAndSave(candidateId, opts = {}) {
    const plan = await runDirector(candidateId, opts);
    const shotState = plan.shots.map((s) => ({ ...s, image_url: null, video_url: null, qc: null, regens: 0 }));
    const ins = await query(
        `insert into generations
            (candidate_id, solution_id, status, target_mode, custom_prompt,
             resolved_target, director_json, shots)
         values ($1,$2,'directed',$3,$4,$5,$6,$7)
         returning *`,
        [
            candidateId,
            plan.product_id || opts.productId || null,
            plan.target_mode,
            opts.customPrompt || null,
            plan.resolved_target,
            JSON.stringify(plan),
            JSON.stringify(shotState),
        ]
    );
    return { generation: ins.rows[0], plan };
}

// Produce N remake variants for one candidate (the LLM's sampling gives each a
// different take on the same source). The chain cron then renders all of them,
// so the user picks the best in review. Returns the first generation (to drive
// the foreground flow) plus the full list.
export async function directVariants(candidateId, opts = {}) {
    const n = Math.min(Math.max(opts.variants || REMAKE_VARIANTS, 1), 3);
    const results = [];
    for (let i = 0; i < n; i++) {
        try {
            results.push(await directAndSave(candidateId, opts));
        } catch (err) {
            if (!results.length && i === n - 1) throw err; // surface if none succeeded
        }
    }
    return { primary: results[0], variants: results, count: results.length };
}
