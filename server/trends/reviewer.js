// ═══════════════════════════════════════════════════════════════════
// Trend Engine — Reviewer actions (driven from the review email / page)
// Two actions a reviewer can take on a generation that's ready for review:
//   • approveAndPost      → publish it to Instagram now (or just approve if IG
//                           publishing isn't configured).
//   • regenerateWithFeedback → record the requested changes, spawn a fresh
//                           generation with those notes injected into the
//                           Director, and supersede the old one. When the new
//                           version finishes rendering the chain emails again.
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';
import { directVariants } from './director.js';
import { updateGenerationStatus } from './generate.js';
import { publishGeneration } from './publish.js';
import { isInstagramPublishConfigured } from './config.js';

export async function approveAndPost(generationId) {
    const { rows } = await query('select id, status, output_type, asset_url from generations where id = $1', [generationId]);
    const gen = rows[0];
    if (!gen) throw new Error('Generation not found');
    if (gen.status === 'posted') return { posted: true, already: true };
    if (!['review', 'approved'].includes(gen.status)) {
        throw new Error(`This version is "${gen.status}" — it can't be posted yet.`);
    }

    if (isInstagramPublishConfigured) {
        const out = await publishGeneration(generationId); // sets status='posted'
        return { posted: true, permalink: out.permalink || null, type: out.type };
    }
    // No IG credentials — approve it so it's flagged for manual posting.
    await updateGenerationStatus(generationId, 'approved', 'email');
    return { posted: false, approved: true };
}

export async function regenerateWithFeedback(generationId, feedback) {
    const notes = String(feedback || '').trim();
    if (!notes) throw new Error('Please describe what to change.');

    const { rows } = await query(
        `select id, candidate_id, solution_id, target_mode, custom_prompt,
                output_type, coalesce(regen_count, 0) as regen_count
           from generations where id = $1`,
        [generationId]
    );
    const old = rows[0];
    if (!old) throw new Error('Generation not found');

    // Record the feedback on the version being replaced (audit trail).
    await query('update generations set feedback = $2 where id = $1', [generationId, notes.slice(0, 4000)]).catch(() => {});

    // Spawn a fresh remake from the same source, same targeting, with the
    // reviewer's notes injected into the Director. variants:1 keeps cost down.
    const { primary } = await directVariants(old.candidate_id, {
        targetMode: old.target_mode || 'auto',
        productId: old.solution_id || null,
        customPrompt: old.custom_prompt || null,
        outputType: old.output_type || 'video',
        revisionNotes: notes,
        variants: 1,
    });
    const newId = primary?.generation?.id;
    if (!newId) throw new Error('Regeneration failed to start.');

    // Link the new version to its parent and carry the feedback + revision count.
    await query(
        `update generations
            set parent_generation_id = $2, feedback = $3, regen_count = $4
          where id = $1`,
        [newId, generationId, notes.slice(0, 4000), (old.regen_count || 0) + 1]
    ).catch(() => {});

    // Supersede the old version so it drops out of the review queue.
    await updateGenerationStatus(generationId, 'killed', 'email').catch(() => {});

    return { newGenerationId: newId, regenCount: (old.regen_count || 0) + 1 };
}
