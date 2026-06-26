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
import { analyzeCandidate, isAnalyzeConfigured } from './analyze.js';
import { buildResearchGrounding } from './research.js';
import { buildOwnPageTargetBlock } from './ownpage.js';
import { buildMemoryBlock } from './memory.js';
import { pickVoiceId } from './captions.js';
import { claudeJSON, isLlmConfigured } from './llm.js';
import {
    EDITORIAL_RULES, MESSAGE_BANK, REMAKE_VARIANTS,
    MATCH_SOURCE_LENGTH, REMAKE_MAX_SHOTS, REMAKE_SHOT_CEILING, VIDEO_CLIP_MIN, VIDEO_CLIP_MAX,
} from './config.js';

const MODEL_CHOICES = ['nano_banana_pro', 'seedream'];
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

// Classify how the source delivers speech so the remake can match it:
//   on_camera → a person speaks ON screen (talking head / dialogue) → generate
//               speaking shots with an audio-native model (Veo 3).
//   voiceover → off-screen narration → ElevenLabs VO overlay (default path).
//   none      → no speech (music/sfx only).
// Falls back to the voiceProfile / format when speechType is absent.
function deriveSpeechMode(analysis) {
    const a = typeof analysis === 'string' ? safeParse(analysis) : analysis;
    if (!a) return 'voiceover';
    const t = String(a.speechType || '').toLowerCase();
    if (t === 'on_camera' || t === 'voiceover' || t === 'none') return t;
    // Fallbacks: a talking-head format with a real voice ⇒ on-camera.
    const vp = a.voiceProfile || {};
    const fmt = String(a.format || '').toLowerCase();
    if (vp.hasVoiceover === false) return 'none';
    if (/talking head|interview|skit|dialogue|vlog|pov/.test(fmt)) return 'on_camera';
    return 'voiceover';
}

function round1(n) { return Math.round(n * 10) / 10; }

// Merge a clip list down to at most `max` contiguous groups, preserving order
// and total duration (adjacent cuts are combined, durations summed, the first
// description kept). Used when a source has more cuts than the shot cap.
function mergeClipsToMax(clips, max) {
    if (clips.length <= max) return clips;
    const out = [];
    const per = Math.ceil(clips.length / max);
    for (let i = 0; i < clips.length; i += per) {
        const group = clips.slice(i, i + per);
        out.push({
            durationSeconds: round1(group.reduce((n, c) => n + (Number(c.durationSeconds) || 0), 0)),
            description: group.map((c) => c.description).filter(Boolean).join('; '),
        });
    }
    return out;
}

// Split any clip longer than the per-clip cap into evenly-sized sub-shots so a
// long beat (e.g. a 15s segment) becomes multiple stitchable clips instead of
// being truncated to the cap. Total duration is preserved. This is what lets a
// 45s source become several clips that add back up to 45s.
function splitClipsToMax(clips, maxLen) {
    if (!(maxLen > 0)) return clips;
    const out = [];
    for (const c of clips) {
        const d = Number(c.durationSeconds) || 0;
        if (d <= maxLen) { out.push({ ...c }); continue; }
        const parts = Math.ceil(d / maxLen);
        const each = round1(d / parts);
        const desc = String(c.description || '').slice(0, 150);
        for (let i = 0; i < parts; i++) {
            out.push({
                durationSeconds: each,
                description: parts > 1 ? `${desc} (continued ${i + 1}/${parts})` : c.description,
            });
        }
    }
    return out;
}

// Derive the shot-timing plan from the analysis: an ordered list of
// { durationSeconds, description } (one per intended shot) plus the total
// target length and whether it was measured (vs. the model's estimate).
//
// Long sources are covered by MULTIPLE clips: we split beats that exceed the
// per-clip cap, then allow as many shots as needed to span the full runtime
// (ceil(total / VIDEO_CLIP_MAX)), bounded by REMAKE_SHOT_CEILING for cost.
function buildShotTiming(analysis) {
    const a = typeof analysis === 'string' ? safeParse(analysis) : analysis;
    let clips = Array.isArray(a?.clips)
        ? a.clips.filter((c) => c && Number(c.durationSeconds) > 0)
        : [];
    const totalFromClips = clips.reduce((n, c) => n + (Number(c.durationSeconds) || 0), 0);
    const total = Number(a?.durationSeconds) || totalFromClips || null;

    // 1. Split long beats so no single beat exceeds the per-clip cap.
    clips = splitClipsToMax(clips, VIDEO_CLIP_MAX);

    // 2. Allow enough shots to actually cover the runtime, bounded by the ceiling.
    const needed = total && VIDEO_CLIP_MAX > 0 ? Math.ceil(total / VIDEO_CLIP_MAX) : clips.length;
    const cap = Math.min(Math.max(REMAKE_MAX_SHOTS, needed), REMAKE_SHOT_CEILING);

    // 3. Only merge when we genuinely have more cuts than the cap; re-split any
    //    merged group that ends up over the per-clip cap, then enforce the ceiling.
    if (clips.length > cap) {
        clips = mergeClipsToMax(clips, cap);
        clips = splitClipsToMax(clips, VIDEO_CLIP_MAX).slice(0, REMAKE_SHOT_CEILING);
    }

    return { clips, total, measured: !!a?.durationMeasured };
}

// Slide-count instruction for slideshow mode (carousels have a slide count, not
// a runtime). Uses the source's distinct beats as the slide count proxy.
function slideCountBriefText(timing) {
    const n = timing.clips?.length;
    if (!n) return 'SLIDE COUNT: aim for 6-8 slides unless the source clearly uses a different count.';
    return `SLIDE COUNT: the source has about ${n} distinct slides/beats — produce ${n} slides in the same order, one per beat.`;
}

// Human-readable timing instruction block for the Director.
function timingBriefText(timing) {
    if (!MATCH_SOURCE_LENGTH || !timing.total) return '';
    const lines = [
        'LENGTH (match the source exactly):',
        `Total target length: ${round1(timing.total)}s${timing.measured ? ' (measured)' : ' (estimated)'}.`,
    ];
    if (timing.clips.length) {
        lines.push(`Produce EXACTLY ${timing.clips.length} shots, in this order, each lasting about:`);
        timing.clips.forEach((c, i) => {
            lines.push(`  ${i + 1}. ~${round1(c.durationSeconds)}s — ${String(c.description || '').slice(0, 160)}`);
        });
        lines.push('Set "target_duration" (seconds) on each shot to the value shown. Clips are trimmed to these lengths so the final cut equals the source length.');
    } else {
        lines.push('Pace the shots so their target_duration values sum to the total target length.');
    }
    return lines.join('\n');
}

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
    if (mode === 'exact') {
        return {
            mode,
            block: [
                'TARGET: exact recreation — there is NO product and NO brand.',
                'Reproduce the source video faithfully: same structure, hook, beats, pacing, framing, camera language, subject matter, and on-screen text. Do not introduce, sell, or mention any product, company, or new message. Recreate the original content itself, with original generated people (no real public figures or copyrighted characters).',
            ].join('\n'),
            resolvedHint: 'exact recreation',
            productId: null,
        };
    }
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
    // ownpage: ALWAYS retarget to what we actually post on Instagram — no
    // product pitch, no brand catalog. Lifts the source's FORMAT and applies it
    // to our page's recurring subjects. This is the "Instagram autopilot" agent.
    if (mode === 'ownpage') {
        const ownPageTarget = await buildOwnPageTargetBlock().catch(() => '');
        if (ownPageTarget) {
            return {
                mode,
                block: [
                    "TARGET: OUR Instagram page. This remake MUST be about OUR page's own content/topics — NOT the source video's topic, and NOT a product pitch.",
                    'Lift ONLY the mechanics from the source (format, hook structure, how the person delivers it, pacing, shot progression, camera language, length) and apply them to one of OUR page\'s recurring subjects below. Keep how it is built; tell one of OUR stories.',
                    ownPageTarget,
                ].join('\n'),
                resolvedHint: 'own Instagram page',
                productId: null,
            };
        }
        // No own-page data yet (handle not set / not scraped) → brand fallback.
        return {
            mode,
            block: [
                "TARGET: our page/brand. Apply ONLY the source's FORMAT to our own content — do not pitch a specific product.",
                defaultBrandText(),
            ].join('\n'),
            resolvedHint: 'own page (brand fallback — connect Instagram for page-specific topics)',
            productId: null,
        };
    }
    // auto: prefer our own page's subject matter, then the trend engine's bridge
    // line + product catalog. The source video supplies the FORMAT only — never
    // its topic. So a viral video about hiring becomes one of OUR topics, using
    // that video's hook/pacing/delivery/length.
    const bridge = score?.bridge_line || '';
    const [products, ownPageTarget] = await Promise.all([
        listProductsBrief().catch(() => []),
        buildOwnPageTargetBlock().catch(() => ''),
    ]);
    const catalog = products.length
        ? 'Available products/topics to choose from (pick the single best fit and name it in resolved_target):\n' +
          products.map((p) => `- ${p.name}: ${p.one_liner}${p.buyer ? ` (buyer: ${p.buyer})` : ''}`).join('\n')
        : '';
    return {
        mode,
        block: [
            'TARGET: auto. This remake must be about OUR page\'s content — NOT the source video\'s topic.',
            'Lift ONLY the mechanics from the source: its format, hook structure, the way the person speaks/delivers it, the pacing, the shot progression, and the length. Then tell one of OUR stories instead. If the source is about (e.g.) hiring, do NOT make a hiring video — apply its format to what our page is about.',
            ownPageTarget,
            bridge ? `Trend-engine angle (a starting point, keep it on-brand): ${bridge}` : '',
            catalog,
            (!ownPageTarget && !catalog) ? `Use the brand context:\n${defaultBrandText()}` : '',
        ].filter(Boolean).join('\n'),
        resolvedHint: ownPageTarget ? 'auto (own-page subject)' : (bridge ? 'auto (bridge line)' : 'auto'),
        productId: null,
    };
}

// Editorial rules per mode. Exact recreation must NOT inherit the CeleriTech
// brand rules (e.g. "the product is always called EZ solutions") — it has no
// product. It keeps only universal, content-agnostic quality rules.
function editorialFor(mode) {
    if (mode === 'exact') {
        return [
            'use only original generated people; never real public figures or copyrighted characters',
            'keep any on-screen text faithful to the source (same words where legible), short and legible',
            'do not add logos, watermarks, or branding that is not in the source',
        ];
    }
    return EDITORIAL_RULES;
}

// Slideshow Director prompt: a PHOTO CAROUSEL instead of a video. Each slide is
// a still with one bold on-screen text line; the words ARE the content. Mirrors
// the source carousel's slide-by-slide structure. Reuses the same shots[] shape
// (image_prompt + on_screen_text + model_choice) so image/qc are unchanged.
function buildSlideSystem(mode) {
    const exact = mode === 'exact';
    const intro = exact
        ? `You are the director for a FAITHFUL RECREATION of a viral short-form PHOTO SLIDESHOW (carousel). You receive the analysis of the source. Reproduce it slide-by-slide: same structure, same hook, same on-screen text (reproduce the original words), same number of slides, same flow. There is NO product and NO brand: do not introduce, sell, or mention anything new. Recreate the original carousel itself.`
        : `You are the director for a viral short-form PHOTO SLIDESHOW (carousel) remake. You receive the analysis of a viral post and a target that says what this remake should be about. Reproduce the source carousel's STRUCTURE and FLOW slide-by-slide, and change only the content so it fits the target. Same number of slides, same kind of hook, same pacing of reveals. Swap what it's about, not how it's built.

The WORDS are the product. Do not freestyle generic copy — lift and adapt the phrasing/structure of proven winners. Slide 1 must be a scroll-stopping hook. Each subsequent slide advances one beat and earns the next swipe; the last slide pays off (save/share/comment bait).`;

    return `${intro}

For EACH slide, write:
- image_prompt: a full, detailed background image in complete sentences (4 layers: scene, subject, atmosphere, camera). Shoot for a real, native, candid look (amateur iPhone photo, natural light, slight grain) — NOT a glossy AI render. Keep an area calm/uncluttered where the text sits. Do NOT ask the image to render the on-screen words (image text garbles); the text is overlaid separately.
- on_screen_text: the EXACT line that goes on this slide (this is the content). Short, punchy, readable. Slide 1 = the hook.
- text_position: "top" | "middle" | "bottom" — where the text box sits on this slide.
- model_choice per slide — match each engine (platform playbook): "nano_banana_pro" (DEFAULT — logical-precision engine; people, products, precise scenes, and legible text/branded layouts; prompt as a full "Director's Brief"), "seedream" (3D brand-consistency engine; keep the SAME person/scene identical across slides and hold a brand aesthetic).
- use_source_frame: true where the slide should copy the source slide's composition.

Rules:
- 4-8 slides unless the source clearly uses a different count; match the source's slide count when known.
- People must look real — prefer use_source_frame off a real reference.
- Apply these editorial rules to ALL on-screen text: ${editorialFor(mode).join('; ')}.

Return JSON only:
{
  "format": "slideshow",
  "resolved_target": "${exact ? 'exact recreation' : 'product name | custom | auto-selected product'}",
  "shots": [
    {
      "role": "hero | setup | action | resolution",
      "image_prompt": "full 4-layer background prompt in complete sentences",
      "on_screen_text": "the exact slide line",
      "text_position": "top | middle | bottom",
      "use_source_frame": true,
      "model_choice": "nano_banana_pro | seedream | grok"
    }
  ]
}`;
}

// The Director system prompt, specialized by target mode. In exact mode the
// goal is a faithful recreation (no product, keep the original content and
// on-screen text); otherwise it retargets the source to sell the target.
function buildSystem(mode, outputType = 'video', speechMode = 'voiceover') {
    if (outputType === 'slideshow') return buildSlideSystem(mode);
    const exact = mode === 'exact';
    const onCamera = speechMode === 'on_camera';
    const intro = exact
        ? `You are the director for a short-form video remake whose goal is a FAITHFUL RECREATION of a viral source video. You receive the analysis of the source (hook, format, beats, pacing, why it works). Reproduce it as closely as possible — same structure, hook, style, visuals, beats, pacing, framing, camera language, AND the same subject matter and on-screen text. There is NO product and NO brand: do not introduce, sell, or mention any product, company, or new message. Recreate the original content itself.`
        : `You are the director for a short-form video remake. You receive the analysis of a viral video (hook, format, beats, pacing, why it works) and a target that says what this remake should be about. The target is one of: a product entry from the knowledge base, a custom prompt written by the user, or auto (apply it to OUR page's subject matter).

Your job: lift the viral MECHANICS from the source — its format, hook structure, how the person delivers/speaks the lines, pacing, shot progression, camera language, and length — and apply them to the TARGET's subject. You are NOT remaking the source's topic. If the source video is about hiring (or anything off-brand), you do NOT make a video about hiring; you take HOW it works and tell the target's story that way instead. Keep how it is built; completely replace what it is about. Faithful replication of the FORMAT, fresh on-brand CONTENT.`;
    const sceneLine = exact
        ? '- Scene: where it happens, matching the source setting as closely as possible.'
        : "- Scene: where it happens, matching the source's setting type but dressed for the target (use the target visual cues when relevant).";
    const subjectLine = exact
        ? '- Subject: who or what is in frame, matching the source as closely as possible. Use ORIGINAL generated people only (likenesses inspired by, not copies of, any real person). Never real public figures or copyrighted characters.'
        : "- Subject: who or what is in frame. Match the source's TYPE of subject and framing (e.g. a single person talking to camera), but the person MUST be a brand-new, clearly DIFFERENT individual from the source — different face, age, ethnicity, hair, body type, and wardrobe. Never reproduce the source's actual person. Describe this new person concretely in the prompt. Use original generated people only; never real public figures or copyrighted characters.";
    const refRule = exact
        ? '- Where the source composition should be copied closely, set use_source_frame true so the image agent passes the source frame as a structural reference and recreates it faithfully.'
        : "- Set use_source_frame true ONLY to copy the source's COMPOSITION/framing/layout — never to copy the person. When a shot contains a person, the still must show a DIFFERENT individual than the source. If a shot is mostly a single person's face/identity and there is no strong compositional reason to mirror it, prefer use_source_frame false and generate the new person from scratch.";
    const textRule = exact
        ? '- Keep on-screen text the same as the source where legible (reproduce the original words).'
        : '- If the source uses on-screen text, write the target equivalent. Keep it short.';
    const editorialNote = exact
        ? `- Apply these editorial rules to ALL on-screen text: ${editorialFor(mode).join('; ')}.`
        : `- Apply these editorial rules to ALL on-screen text and any copy, plus any product editorial overrides (banned terms, required framing): ${editorialFor(mode).join('; ')}.`;

    const speechRule = onCamera
        ? `- SPEECH: the source is a person SPEAKING ON CAMERA. For every shot where a person is visibly talking, write a "dialogue" field with the EXACT words that on-screen person says in that shot (in the target's content/voice), and set "speaking": true. The dialogue is generated as real lip-synced speech in the clip, so it MUST be tight: about 2 words per second of the shot's target_duration (e.g. a 4s shot ≈ 8 words). Keep it natural, spoken, first-person. Shots with no speaker (pure b-roll/cutaways) get "dialogue": "" and "speaking": false. Do NOT also put the spoken line in on_screen_text unless the source burns captions.`
        : `- SPEECH: the source uses OFF-SCREEN narration (voiceover). Do NOT write per-shot dialogue; leave "dialogue": "" and "speaking": false. The narration is voiced separately over the visuals.`;
    const dialogueField = onCamera
        ? '\n      "dialogue": "exact spoken line for this shot (on-camera), or empty",\n      "speaking": true,'
        : '';
    // dialogueField is inserted BEFORE target_duration so the last field never
    // carries a trailing comma (strict JSON.parse rejects trailing commas).

    return `${intro}

For each shot, write an image prompt using the 4 Layers Method, in full sentences, like a director briefing a photographer:
${sceneLine}
${subjectLine}
- Atmosphere: lighting, mood, environmental effects, particles, matching the source.
- Camera: shot type, angle, lens, aperture, depth of field, style. Match the source's camera language.

Rules:
${refRule}
- The first shot (role "hero") must match the energy of the source hook and stop the scroll: clear subject, strong contrast, emotion or tension.
${textRule}
- model_choice per shot — match each engine to the shot (platform playbook):
    • "nano_banana_pro" (DEFAULT): the logical-precision "thinking" engine. Best for reasoning-based composition, precise pose/identity consistency, structured scene control, high-detail cinematic realism, and legible on-screen TEXT (signs, packaging, headlines, UI, branded visuals). Write its image prompt as a full "Director's Brief": complete sentences covering camera lens, aperture, lighting, material textures, depth of field and photography style.
    • "seedream": the 3D brand-consistency engine. Best when the SAME character/subject must stay identical across multiple shots, or for brand-aligned, recurring, campaign-style visuals. Prompt it cleanly with material finishes, an explicit 3D perspective/angle, and a clear brand aesthetic.
- target_duration: seconds this shot stays on screen. When a LENGTH plan is given, follow it exactly (one shot per listed beat, with the listed seconds). The clip lengths must add up to the source length.
${speechRule}
${editorialNote}

Return JSON only:
{
  "format": "single | story",
  "resolved_target": "${exact ? 'exact recreation' : 'product name | custom | auto-selected product'}",
  "shots": [
    {
      "role": "hero | setup | action | resolution",
      "image_prompt": "full 4-layer prompt in complete sentences",
      "use_source_frame": true,
      "on_screen_text": "",
      "model_choice": "nano_banana_pro | seedream",
      "motion_intent": "what should move when this still is animated",${dialogueField}
      "target_duration": 0
    }
  ]
}`;
}

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
        target_duration: Number(s.target_duration) > 0 ? round1(Number(s.target_duration)) : null,
        text_position: ['top', 'middle', 'bottom'].includes(s.text_position) ? s.text_position : 'bottom',
        // On-camera dialogue: the exact words the on-screen person says in this
        // shot. Drives audio-native (Veo 3) generation. Empty for non-speaking shots.
        dialogue: String(s.dialogue || '').trim(),
        speaking: s.speaking === true || s.speaking === 'true' || !!String(s.dialogue || '').trim(),
    })).filter((s) => s.image_prompt);
}

// Force the shot durations to reproduce the source length. When the shot count
// matches the timing plan we copy each beat's duration; otherwise we distribute
// the total across the shots. Clamps each clip to the model-supported window and
// fixes rounding drift on the last shot so the sum equals the target exactly.
function applyTiming(shots, timing) {
    if (!MATCH_SOURCE_LENGTH || !timing.total || !shots.length) return shots;
    const clamp = (n) => Math.min(Math.max(round1(n), VIDEO_CLIP_MIN), VIDEO_CLIP_MAX);
    let durations;
    if (timing.clips.length === shots.length) {
        durations = timing.clips.map((c) => clamp(c.durationSeconds));
    } else {
        const even = timing.total / shots.length;
        durations = shots.map(() => clamp(even));
    }
    // Distribute any leftover drift across EVERY shot that still has headroom (not
    // just the last one), so the realized total matches the source length even
    // when the remake spans many clips. Without this, a long source would lose
    // time whenever the per-clip cap truncated the tail.
    let drift = round1(timing.total - durations.reduce((n, d) => n + d, 0));
    let guard = 0;
    while (Math.abs(drift) >= 0.1 && guard++ < 200) {
        let changed = false;
        for (let i = durations.length - 1; i >= 0 && Math.abs(drift) >= 0.1; i--) {
            if (drift > 0) {
                const room = round1(VIDEO_CLIP_MAX - durations[i]);
                if (room > 0) { const add = Math.min(room, drift); durations[i] = round1(durations[i] + add); drift = round1(drift - add); changed = true; }
            } else {
                const room = round1(durations[i] - VIDEO_CLIP_MIN);
                if (room > 0) { const sub = Math.min(room, -drift); durations[i] = round1(durations[i] - sub); drift = round1(drift + sub); changed = true; }
            }
        }
        if (!changed) break; // every shot is maxed/minned — can't absorb more
    }
    return shots.map((s, i) => ({ ...s, target_duration: durations[i] }));
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
export async function runDirector(candidateId, { targetMode = 'auto', productId = null, customPrompt = null, outputType = 'video' } = {}) {
    if (!isLlmConfigured) throw new Error('ANTHROPIC_API_KEY not configured');
    const isSlideshow = outputType === 'slideshow';
    let candidate = await loadCandidate(candidateId);
    if (!candidate) throw new Error('Candidate not found');

    // Auto-analyze when the source has never been analyzed (or the analysis is
    // pre-timing, i.e. has no clip plan): the Director needs the deep analysis
    // AND the per-clip timing to mirror structure and length. Best-effort —
    // degrade to a generic plan if analysis is unavailable (e.g. video too large).
    const needsAnalysis = !candidate.analysis
        || !Array.isArray(candidate.analysis?.clips)
        || candidate.analysis?.clips?.length === 0;
    if (needsAnalysis && isAnalyzeConfigured) {
        try {
            await analyzeCandidate(candidateId);
            candidate = await loadCandidate(candidateId);
        } catch (err) {
            console.error(`director auto-analyze [${candidateId}]: ${err.message}`);
        }
    }

    const deep = mapDeepAnalysis(candidate.analysis);
    const timing = buildShotTiming(candidate.analysis);
    // Slideshows have no spoken audio; only video remakes carry a speech mode.
    const speechMode = isSlideshow ? 'none' : deriveSpeechMode(candidate.analysis);
    const target = await resolveTarget({ targetMode, productId, customPrompt }, candidate, { bridge_line: candidate.bridge_line });

    // Ground in real winning copy + prior-run memory ("lift, don't invent").
    const [grounding, memoryBlock] = await Promise.all([
        buildResearchGrounding({ platform: candidate.platform, format: deep?.format, outputType, sourceCandidateId: candidateId }).catch(() => ''),
        buildMemoryBlock({ outputType }).catch(() => ''),
    ]);

    const sourceMediaUrl = candidate.media_url || candidate.url || '';
    const user = [
        'CONCEPT BRIEF',
        `Platform: ${candidate.platform}`,
        `Output: ${isSlideshow ? 'PHOTO SLIDESHOW (carousel)' : 'VIDEO'}`,
        `Bucket: ${candidate.bucket || 'unknown'}`,
        `Source (structural reference): ${sourceMediaUrl}`,
        candidate.caption ? `Source caption: ${candidate.caption}` : '',
        '',
        analysisBriefText(deep),
        '',
        isSlideshow ? slideCountBriefText(timing) : timingBriefText(timing),
        '',
        (!isSlideshow && speechMode === 'on_camera')
            ? 'DELIVERY: this is an ON-CAMERA talking video. Write a tight per-shot "dialogue" line (the words the on-screen person says) for every speaking shot — it becomes real lip-synced speech. Keep each line within ~2 words per second of that shot.'
            : (!isSlideshow && speechMode === 'voiceover')
                ? 'DELIVERY: this is a VOICEOVER (off-screen narration) video. Do not write per-shot dialogue; the narration is voiced separately.'
                : null,
        (!isSlideshow && speechMode !== 'none') ? '' : null,
        memoryBlock,
        memoryBlock ? '' : null,
        grounding,
        grounding ? '' : null,
        target.block,
    ].filter((x) => x != null && x !== '').join('\n');

    // Retry once on transient/no-JSON (Claude occasionally returns prose or
    // trips a content filter on the first pass).
    let plan = null;
    for (let attempt = 0; attempt < 2 && !plan; attempt++) {
        try {
            plan = await claudeJSON(buildSystem(target.mode, outputType, speechMode), user, { maxTokens: 6000 });
        } catch (err) {
            if (attempt === 1) throw err;
        }
        if (!plan && attempt === 1) throw new Error('Director returned no parsable JSON');
    }

    let shots = normalizeShots(plan.shots);
    if (!shots.length) throw new Error('Director produced no usable shots');
    // Video matches the source length; slideshow has no per-clip timing.
    if (!isSlideshow) shots = applyTiming(shots, timing);

    // Match the voiceover voice to the source's delivery (gender/age/energy).
    const voiceProfile = candidate.analysis?.voiceProfile || null;
    const voiceId = pickVoiceId(voiceProfile);

    return {
        candidate_id: candidateId,
        platform: candidate.platform,
        source_media_url: sourceMediaUrl,
        output_type: isSlideshow ? 'slideshow' : 'video',
        speech_mode: speechMode,
        voice_id: voiceId,
        voice_profile: voiceProfile,
        target_mode: target.mode,
        product_id: target.productId,
        resolved_target: plan.resolved_target || target.resolvedHint,
        format: isSlideshow ? 'slideshow' : (plan.format === 'story' ? 'story' : (shots.length > 1 ? 'story' : 'single')),
        has_deep_analysis: !!deep,
        target_duration_total: (!isSlideshow && MATCH_SOURCE_LENGTH) ? timing.total : null,
        duration_measured: timing.measured,
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
             resolved_target, director_json, shots, output_type)
         values ($1,$2,'directed',$3,$4,$5,$6,$7,$8)
         returning *`,
        [
            candidateId,
            plan.product_id || opts.productId || null,
            plan.target_mode,
            opts.customPrompt || null,
            plan.resolved_target,
            JSON.stringify(plan),
            JSON.stringify(shotState),
            plan.output_type || 'video',
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
