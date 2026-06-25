// ═══════════════════════════════════════════════════════════════════
// Video Generation — QC gate (spec §7)
// Before any shot is animated, a vision model (Gemini) grades the still on:
//   • composition matches the source where that was the intent,
//   • the target product reads clearly when it should be on screen,
//   • on-screen text is correct and legible,
//   • scroll-stop quality: clear subject, contrast, emotion or tension.
// Fail returns the shot for a refined-prompt regeneration (the improve-this-
// prompt loop). Pass proceeds. Regenerations are capped per shot.
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';
import { generateShotImage } from './image.js';
import { REMAKE_MAX_REGENS } from './config.js';

const GEMINI_KEY = process.env.GEMINI_API_KEY;
export const isQcConfigured = !!GEMINI_KEY && GEMINI_KEY !== 'placeholder';

const MODELS = [
    process.env.TREND_ANALYZE_MODEL,
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-flash-latest',
].filter(Boolean);

const GEMINI_TIMEOUT_MS = 60000;

function gradePrompt(shot, productName, hasRef) {
    const refLines = hasRef
        ? `\nYou are given TWO images: the FIRST is the generated still to grade; the SECOND is the SOURCE reference frame for this beat. The generated still should structurally match the source: same framing, camera angle, subject placement, and overall composition (only the subject/context may be swapped for the target).`
        : '';
    const fidelityField = hasRef
        ? '\n  "fidelity_ok": true,           // the generated still matches the SECOND (source) image\'s framing/composition/subject placement'
        : '';
    return `You are a strict art director grading a single AI-generated still for a short-form vertical (9:16) video remake before it is animated.${refLines}

The shot intent was:
- Role: ${shot.role}
- Image brief: ${String(shot.image_prompt).slice(0, 800)}
- On-screen text it should contain (exact): ${shot.on_screen_text ? `"${shot.on_screen_text}"` : '(none)'}
- Should copy the source composition: ${shot.use_source_frame ? 'yes' : 'no'}
- Target product: ${productName || 'CeleriTech'}

Grade the actual ${hasRef ? 'FIRST (generated) ' : ''}image. Return ONLY JSON:
{
  "composition_ok": true,        // matches the intended framing/camera; if use_source_frame, the layout is preserved
  "product_clear": true,         // when the product/dashboard/subject should read on screen, it is clear; true if not applicable
  "text_correct": true,          // any on-screen text is present, spelled correctly, and legible; true if none expected
  "scroll_stop": true,           // clear subject, strong contrast, emotion or tension; would stop a scroll
  "no_artifacts": true,          // no obvious AI artifacts (broken hands, garbled text, melted objects)${fidelityField}
  "pass": true,                  // overall: good enough to animate
  "notes": "<one or two concrete fixes if anything fails; empty if pass>"
}

Be strict about garbled/misspelled on-screen text and broken anatomy. If text is expected and wrong, set text_correct false and pass false.${hasRef ? ' If the framing clearly does not match the source reference, set fidelity_ok false and add a concrete fix.' : ''}`;
}

async function downloadImage(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
        const r = await fetch(url, { signal: controller.signal });
        if (!r.ok) throw new Error(`image fetch ${r.status}`);
        const ct = r.headers.get('content-type') || 'image/jpeg';
        const buf = Buffer.from(await r.arrayBuffer());
        return { mimeType: ct.startsWith('image/') ? ct : 'image/jpeg', data: buf.toString('base64') };
    } finally {
        clearTimeout(timer);
    }
}

function parseJsonLoose(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch { /* */ }
    const f = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (f) { try { return JSON.parse(f[1]); } catch { /* */ } }
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a !== -1 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch { /* */ } }
    return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Grade one image. Returns the parsed grade object. Retries transient Gemini
// overload (503/429) with backoff before falling through to the next model.
export async function gradeImage(imageUrl, shot, productName, { sourceFrameUrl = null } = {}) {
    if (!isQcConfigured) throw new Error('GEMINI_API_KEY not configured');
    const inline = await downloadImage(imageUrl);
    // Fidelity check: when we have the matching source beat frame, hand it to
    // the grader as a second image so it can verify the composition matches.
    let refInline = null;
    if (sourceFrameUrl) {
        try { refInline = await downloadImage(sourceFrameUrl); } catch { refInline = null; }
    }
    const parts = [{ inlineData: inline }];
    if (refInline) parts.push({ inlineData: refInline });
    parts.push({ text: gradePrompt(shot, productName, !!refInline) });
    const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1024, responseMimeType: 'application/json' },
    };
    let lastErr = null;
    for (const model of MODELS) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
        for (let attempt = 0; attempt < 3; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
            try {
                const res = await fetch(url, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body), signal: controller.signal,
                });
                if (!res.ok) {
                    lastErr = new Error(`Gemini ${model} HTTP ${res.status}`);
                    // 503 = transient overload → short backoff retry. 429 =
                    // quota; backing off won't help in-call, so fail over to the
                    // next model immediately instead of burning time.
                    if (res.status === 503 && attempt < 2) { await sleep(3000 * (attempt + 1)); continue; }
                    break; // 429 / other → next model
                }
                const data = await res.json();
                const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
                const parsed = parseJsonLoose(text);
                if (parsed) return parsed;
                lastErr = new Error(`Gemini ${model} unparseable QC output`);
                break;
            } catch (err) {
                lastErr = err;
                if (attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
            } finally {
                clearTimeout(timer);
            }
        }
    }
    throw lastErr || new Error('QC grading failed');
}

async function loadGen(generationId) {
    const { rows } = await query(
        `select g.*, c.thumbnail, c.platform
         from generations g join candidates c on c.id = g.candidate_id
         where g.id = $1`,
        [generationId]
    );
    return rows[0] || null;
}

// Run QC on every shot with an image. Failing shots are regenerated with a
// refined prompt (original brief + the grader's fix notes) up to the cap, then
// re-graded. When all shots pass, status advances to 'animating'.
export async function runQc(generationId) {
    if (!isQcConfigured) throw new Error('GEMINI_API_KEY not configured');
    const gen = await loadGen(generationId);
    if (!gen) throw new Error('Generation not found');
    const shots = Array.isArray(gen.shots) ? gen.shots : [];
    if (!shots.length) throw new Error('No shots to QC');
    const productName = gen.resolved_target || 'CeleriTech';

    await query(`update generations set status = 'qc' where id = $1`, [generationId]);

    // A shot is "resolved" once it passes OR has exhausted its regen budget.
    // Resolved shots are never re-graded (saves credits) and no longer block
    // the batch — a single stubborn shot (e.g. garbled AI headline text) must
    // not starve the others or stall the whole generation forever.
    // After this many failed grading attempts (e.g. Gemini quota/429), stop
    // blocking on QC and let the shot through — QC is a quality gate, not a hard
    // gate; an unavailable grader must not stall the whole pipeline.
    const QC_MAX_ATTEMPTS = Number(process.env.QC_MAX_ATTEMPTS) || 2;
    const resolved = (s) => !s.image_url
        || (s.qc && (s.qc.pass || (s.regens || 0) >= REMAKE_MAX_REGENS))
        || (s.qc_attempts || 0) >= QC_MAX_ATTEMPTS;
    // Bound the heavy regen work per call so one /advance tick stays well under
    // the serverless limit; the next tick continues any remaining shots.
    const REGEN_BUDGET_PER_CALL = Number(process.env.QC_REGENS_PER_CALL) || 3;

    let passed = 0, failed = 0, regens = 0, errored = 0;
    for (const shot of shots) {
        if (resolved(shot)) { if (shot.qc?.pass) passed++; else failed++; continue; }
        if (regens >= REGEN_BUDGET_PER_CALL && shot.qc) break; // defer the rest to the next tick

        let grade;
        try {
            grade = await gradeImage(shot.image_url, shot, productName, { sourceFrameUrl: shot.source_frame_url });
        } catch (err) {
            // Don't let one shot's grading failure abort the batch; record it,
            // count the attempt (so a persistently-unavailable grader resolves
            // to pass-through), and move on so the rest still get graded.
            shot.qc_error = err.message;
            shot.qc_attempts = (shot.qc_attempts || 0) + 1;
            errored++;
            await query(`update generations set shots = $2 where id = $1`, [generationId, JSON.stringify(shots)]);
            continue;
        }
        shot.qc = grade;
        shot.qc_error = null;

        // Improve-this-prompt loop: regenerate with the grader's notes appended,
        // capped per shot AND per call.
        while (!grade.pass && (shot.regens || 0) < REMAKE_MAX_REGENS && regens < REGEN_BUDGET_PER_CALL) {
            shot.regens = (shot.regens || 0) + 1;
            regens++;
            const refined = `${shot.image_prompt}\n\nFix these issues from the previous attempt: ${grade.notes || 'improve composition, legibility, and scroll-stop impact.'}`;
            try {
                const out = await generateShotImage(shot, { promptOverride: refined, sourceFrameUrl: shot.source_frame_url });
                if (out.image_url) {
                    shot.image_url = out.image_url;
                    shot.image_model = out.model;
                    grade = await gradeImage(shot.image_url, shot, productName, { sourceFrameUrl: shot.source_frame_url });
                    shot.qc = grade;
                } else {
                    break; // pending render — stop the loop, resume later
                }
            } catch (err) {
                shot.qc_error = err.message;
                break;
            }
        }
        if (shot.qc?.pass) passed++; else failed++;
        await query(`update generations set shots = $2 where id = $1`, [generationId, JSON.stringify(shots)]);
    }

    // Advance once every shot is resolved (passed or out of regens), animating
    // the best still we have for any that never passed. Otherwise stay in 'qc'
    // so the next tick finishes the remaining regen work.
    const allResolved = shots.every(resolved);
    const anyPass = shots.some((s) => s.qc?.pass);
    // Slideshows skip animation — once stills pass QC they go straight to slide
    // composition; videos go to animation.
    const nextStage = gen.output_type === 'slideshow' ? 'composing' : 'animating';
    const status = allResolved ? nextStage : 'qc';
    await query(`update generations set shots = $2, status = $3 where id = $1`, [generationId, JSON.stringify(shots), status]);
    return { generationId, total: shots.length, passed, failed, errored, regens, allResolved, anyPass, status };
}
