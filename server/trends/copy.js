// ═══════════════════════════════════════════════════════════════════
// Video Generation — Copy agent (spec §10)
// Writes the words that ship with the cut:
//   • voiceover — a single narration timed to the 15-25s window, mechanism
//     first, in the brand voice, that Assembly hands to ElevenLabs;
//   • captions — one posting caption per platform (TikTok / Instagram /
//     YouTube Shorts), tuned to each platform's norms;
//   • hashtags — a small, relevant set.
// It reads the Director's shot plan (so the VO tracks the on-screen beats) and
// the resolved target, and obeys the editorial rules + any product overrides.
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';
import { claudeJSON, isLlmConfigured } from './llm.js';
import { getProductEntry } from './solutions.js';
import {
    EDITORIAL_RULES, MESSAGE_BANK, PUBLISH_PLATFORMS,
    VIDEO_TARGET_MIN, VIDEO_TARGET_MAX,
} from './config.js';

export const isCopyConfigured = isLlmConfigured;

const SYSTEM = `You write the voiceover and posting copy for a finished short-form vertical video (a remake of a viral video, retargeted to a product). You are given the shot-by-shot plan (what is on screen, including any on-screen text) and the target.

Write:
- voiceover: ONE continuous narration that tracks the shots in order and fits a ${VIDEO_TARGET_MIN}-${VIDEO_TARGET_MAX} second read (roughly ${Math.round(VIDEO_TARGET_MIN * 2.6)}-${Math.round(VIDEO_TARGET_MAX * 2.6)} words). Mechanism first, plain and human, in the brand voice. It must NOT just repeat the on-screen text; it complements it. Open with the hook in the first line.
- captions: one posting caption per requested platform. TikTok = punchy, native, lowercase-ok, hook-led. Instagram = a touch more polished, can use line breaks. YouTube = a clear, search-friendly first line. No hashtags inside the caption text.
- hashtags: 4-8 relevant, mostly the buyer's world (not consumer spam).

Hard editorial rules (apply to ALL text): ${EDITORIAL_RULES.join('; ')}.

Return JSON only:
{
  "voiceover": "<full narration, plain sentences>",
  "captions": { "tiktok": "...", "instagram": "...", "youtube": "..." },
  "hashtags": ["...", "..."]
}`;

function shotsBlock(shots) {
    return shots.map((s, i) => {
        const idx = typeof s.index === 'number' ? s.index : i;
        return [
            `Shot ${idx} (${s.role}): ${String(s.image_prompt || '').slice(0, 220)}`,
            s.on_screen_text ? `   on-screen text: "${s.on_screen_text}"` : '',
        ].filter(Boolean).join('\n');
    }).join('\n');
}

function targetBlock(product, resolvedTarget, customPrompt) {
    if (product) {
        const ed = product.editorial || {};
        return [
            `Product: ${product.name}`,
            product.one_liner ? `What it is: ${product.one_liner}` : '',
            product.buyer ? `Buyer: ${product.buyer}` : '',
            product.pains?.length ? `Pains: ${product.pains.join('; ')}` : '',
            product.proof_points?.length ? `Proof points: ${product.proof_points.join('; ')}` : '',
            product.message_bank?.length ? `Approved angles: ${product.message_bank.join(' | ')}` : '',
            ed.banned_terms?.length ? `Banned terms (never use): ${ed.banned_terms.join(', ')}` : '',
            ed.required_framing ? `Required framing: ${ed.required_framing}` : '',
        ].filter(Boolean).join('\n');
    }
    if (customPrompt) {
        return [
            `Custom target: ${customPrompt}`,
            `Brand voice: ${MESSAGE_BANK.voice}`,
            `Buyer: ${MESSAGE_BANK.buyer}`,
        ].join('\n');
    }
    return [
        `Product: ${resolvedTarget || MESSAGE_BANK.product}`,
        `Buyer: ${MESSAGE_BANK.buyer}`,
        `Core pains: ${MESSAGE_BANK.corePains.join('; ')}`,
        `Voice: ${MESSAGE_BANK.voice}`,
    ].join('\n');
}

async function loadGen(generationId) {
    const { rows } = await query(
        `select g.*, c.platform, c.caption as source_caption, c.analysis as source_analysis
         from generations g join candidates c on c.id = g.candidate_id
         where g.id = $1`,
        [generationId]
    );
    return rows[0] || null;
}

// Build a faithful-recreation brief from the source analysis: the original
// hook, on-screen text, and spoken transcript so the VO reproduces the source.
function sourceScriptBlock(analysisRaw, caption) {
    let a = analysisRaw;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
    const lines = [];
    if (a?.hook) lines.push(`Source hook: ${a.hook}`);
    const ost = Array.isArray(a?.onScreenText) ? a.onScreenText.join(' | ') : (a?.on_screen_text || '');
    if (ost) lines.push(`Source on-screen text: ${String(ost).slice(0, 400)}`);
    const tr = a?.transcript || a?.transcript_paraphrase || '';
    if (tr) lines.push(`Source spoken script/transcript: ${String(tr).slice(0, 1400)}`);
    if (caption) lines.push(`Source caption: ${String(caption).slice(0, 200)}`);
    return lines.length
        ? lines.join('\n')
        : '(No source script captured. If the source had no spoken narration, return an empty voiceover.)';
}

const SYSTEM_EXACT = `You write the voiceover and posting copy for a FAITHFUL RECREATION of a viral short-form vertical video. You are given the source video's analysis (hook, on-screen text, spoken transcript), its caption, and the recreated shot plan. Your job is to reproduce the source, NOT to sell anything.

Write:
- voiceover: reproduce the source's spoken script as closely as possible — same words, same order, same tone — adjusted only enough to read cleanly over the recreated shots. If the source had NO spoken narration (e.g. text-on-screen or music only), return an empty string "".
- captions: one posting caption per requested platform, mirroring the source caption's style and intent. Do not turn it into a sales pitch and do not mention any product or company.
- hashtags: 4-8 relevant to the source's actual topic.

Do NOT introduce, sell, or mention any product, company, or new message. No brand voice. Keep it faithful to the original.

Return JSON only:
{
  "voiceover": "<faithful narration, or empty string if the source had none>",
  "captions": { "tiktok": "...", "instagram": "...", "youtube": "..." },
  "hashtags": ["...", "..."]
}`;

// Generate VO + per-platform captions + hashtags and persist them. Stores
// copy_json and sets the primary caption (platform that matches the source, or
// the first requested platform). Does not change pipeline status.
export async function runCopy(generationId) {
    if (!isCopyConfigured) throw new Error('ANTHROPIC_API_KEY not configured (needed for the Copy agent).');
    const gen = await loadGen(generationId);
    if (!gen) throw new Error('Generation not found');
    const shots = Array.isArray(gen.shots) ? gen.shots : [];
    if (!shots.length) throw new Error('No shots — run the Director first');

    const platforms = PUBLISH_PLATFORMS.length ? PUBLISH_PLATFORMS : ['tiktok', 'instagram', 'youtube'];
    const exact = gen.target_mode === 'exact';

    let system, user;
    if (exact) {
        // Faithful recreation: reproduce the source's own script/captions, no product.
        system = SYSTEM_EXACT;
        user = [
            `Requested platforms: ${platforms.join(', ')}`,
            `Source platform: ${gen.platform}`,
            '',
            'SOURCE (reproduce this faithfully):',
            sourceScriptBlock(gen.source_analysis, gen.source_caption),
            '',
            'RECREATED SHOT PLAN (the VO should track these in order):',
            shotsBlock(shots),
        ].filter(Boolean).join('\n');
    } else {
        const product = gen.solution_id ? await getProductEntry(gen.solution_id).catch(() => null) : null;
        system = SYSTEM;
        user = [
            `Requested platforms: ${platforms.join(', ')}`,
            `Source platform: ${gen.platform}`,
            gen.source_caption ? `Source caption (format reference): ${String(gen.source_caption).slice(0, 200)}` : '',
            '',
            'TARGET',
            targetBlock(product, gen.resolved_target, gen.custom_prompt),
            '',
            'SHOT PLAN (the VO should track these in order):',
            shotsBlock(shots),
        ].filter(Boolean).join('\n');
    }

    const out = await claudeJSON(system, user, { maxTokens: 1500 });
    if (!out) throw new Error('Copy agent returned no parsable JSON');

    const captions = out.captions && typeof out.captions === 'object' ? out.captions : {};
    const hashtags = Array.isArray(out.hashtags) ? out.hashtags.map((h) => String(h).replace(/^#/, '').trim()).filter(Boolean) : [];
    const voiceover = String(out.voiceover || '').trim();

    // Primary caption: prefer the source platform, else the first requested.
    const primary = captions[gen.platform] || captions[platforms[0]] || Object.values(captions)[0] || '';

    const copyJson = { voiceover, captions, hashtags };
    await query(
        `update generations set copy_json = $2, caption = $3, script = $4 where id = $1`,
        [generationId, JSON.stringify(copyJson), primary, voiceover]
    );

    return { generationId, platforms, hasVoiceover: !!voiceover, hashtags: hashtags.length, captions: Object.keys(captions) };
}
