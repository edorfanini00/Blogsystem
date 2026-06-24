// ═══════════════════════════════════════════════════════════════════
// Video Generation — Video agent (spec §9)
// Animates each QC-approved still into a short clip with Higgsfield DoP
// (image-to-video). The DoP endpoint wraps args in { params }, takes the still
// as an input image and the Motion agent's motion_prompt as the camera/subject
// brief. Generation is async and can outlast a single serverless request, so
// each shot is submitted, polled within a deadline, and—if still running—left
// resumable (request_id + status_url stored on the shot) for the next call.
// Failures are retried up to VIDEO_MAX_REGENS. When every shot has a clip the
// generation advances to 'assembling'.
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';
import {
    isHiggsfieldConfigured, subscribe, poll, pickVideoUrl,
} from './higgsfield.js';
import * as fal from './fal.js';
import { runMotion } from './motion.js';
import {
    HF_VIDEO_MODELS, HF_VIDEO_DOP_MODEL, VIDEO_MAX_REGENS, MAX_VIDEO_RENDERS,
    VIDEO_PROVIDER, FAL_VIDEO_MODEL, FAL_VIDEO_DURATION,
} from './config.js';

const USE_FAL_VIDEO = VIDEO_PROVIDER === 'fal';

// Total animation submissions consumed (clips + in-flight + regens) for the
// cost ceiling.
function videoRendersSpent(shots) {
    return (shots || []).reduce((n, s) => n + ((s.video_url || s.video_status_url || s.video_error) ? 1 : 0) + (s.video_regens || 0), 0);
}

export const isVideoAgentConfigured = USE_FAL_VIDEO ? fal.isFalConfigured : isHiggsfieldConfigured;

const DOP = HF_VIDEO_MODELS.default;
const DEFAULT_MOTION = 'Slow, smooth camera push-in that keeps the subject centered.';

// Build the DoP request body. The live endpoint requires the args under
// `params` (verified against the API; an empty body returns 422 body.params).
function dopArgs(imageUrl, motionPrompt) {
    return {
        params: {
            model: HF_VIDEO_DOP_MODEL,
            prompt: motionPrompt,
            input_images: [{ type: 'image_url', image_url: imageUrl }],
        },
    };
}

// Pick the clip length to REQUEST so the generated clip is long enough to be
// trimmed down to the shot's target_duration in assembly. Kling only offers
// "5"|"10"; Seedance takes an integer 3..12. Falls back to the configured
// default when no target is set.
function falVideoDuration(targetDuration) {
    const t = Number(targetDuration);
    if (!t || t <= 0) return FAL_VIDEO_DURATION;
    if (/seedance/i.test(FAL_VIDEO_MODEL)) {
        return String(Math.min(Math.max(Math.ceil(t), 3), 12));
    }
    // Kling (and unknown models): quantize up to the nearest supported option.
    return t <= 5 ? '5' : '10';
}

// Build the fal image-to-video input. Kling takes { prompt, image_url,
// duration }; Seedance additionally accepts resolution/aspect_ratio.
function falVideoInput(imageUrl, motionPrompt, targetDuration) {
    const input = { prompt: motionPrompt, image_url: imageUrl, duration: falVideoDuration(targetDuration) };
    if (/seedance/i.test(FAL_VIDEO_MODEL)) {
        input.resolution = '1080p';
        input.aspect_ratio = 'auto';
    }
    return input;
}

// Submit one still for animation. Returns
//   { video_url } | { pending, request_id, status_url, response_url }.
async function animateShot(shot, { deadlineMs = 110000 } = {}) {
    const motion = shot.motion_prompt || shot.motion_intent || DEFAULT_MOTION;
    if (USE_FAL_VIDEO) {
        const out = await fal.subscribe(FAL_VIDEO_MODEL, falVideoInput(shot.image_url, motion, shot.target_duration), { deadlineMs, pollMs: 4000 });
        if (out.pending) {
            return {
                pending: true, request_id: out.request_id,
                status_url: out.status_url, response_url: out.response_url,
            };
        }
        const url = fal.pickVideoUrl(out.result);
        if (!url) throw new Error(`${FAL_VIDEO_MODEL} completed but no video URL`);
        return { video_url: url, request_id: out.request_id };
    }
    const out = await subscribe(DOP, dopArgs(shot.image_url, motion), { deadlineMs, pollMs: 4000 });
    if (out.pending) {
        return { pending: true, request_id: out.request_id, status_url: out.status_url };
    }
    const url = pickVideoUrl(out.result);
    if (!url) throw new Error('DoP completed but no video URL');
    return { video_url: url, request_id: out.request_id };
}

async function loadGen(generationId) {
    const { rows } = await query(
        `select g.*, c.platform from generations g join candidates c on c.id = g.candidate_id where g.id = $1`,
        [generationId]
    );
    return rows[0] || null;
}

async function save(generationId, shots, status) {
    if (status) await query(`update generations set shots = $2, status = $3 where id = $1`, [generationId, JSON.stringify(shots), status]);
    else await query(`update generations set shots = $2 where id = $1`, [generationId, JSON.stringify(shots)]);
}

// Resume a still-running DoP job for one shot. Returns true if it resolved a
// video_url (or terminal failure), false if it is still pending.
async function resumePending(shot) {
    try {
        const r = USE_FAL_VIDEO
            ? await fal.poll(shot.video_status_url, shot.video_response_url, { deadlineMs: 100000, pollMs: 4000 })
            : await poll(shot.video_status_url, { deadlineMs: 100000, pollMs: 4000 });
        if (r.pending) return false;
        const url = USE_FAL_VIDEO ? fal.pickVideoUrl(r.result) : pickVideoUrl(r.result);
        if (url) {
            shot.video_url = url;
            shot.video_status_url = null;
            shot.video_response_url = null;
            shot.video_request_id = null;
            return true;
        }
        shot.video_error = 'completed but no video URL';
        return true;
    } catch (err) {
        shot.video_error = err.message;
        shot.video_status_url = null;
        shot.video_response_url = null;
        return true;
    }
}

// Animate every QC-approved still that has no clip yet. `max` caps how many
// shots are processed this call so the request stays under the serverless
// limit; re-call to continue. Idempotent: only fills gaps. Advances status to
// 'assembling' once all shots have a clip, otherwise stays 'animating'.
export async function runVideo(generationId, { max = 2 } = {}) {
    if (!isVideoAgentConfigured) {
        throw new Error(USE_FAL_VIDEO
            ? 'fal not configured. Set FAL_KEY.'
            : 'Higgsfield not configured. Set HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET.');
    }
    const gen = await loadGen(generationId);
    if (!gen) throw new Error('Generation not found');
    const shots = Array.isArray(gen.shots) ? gen.shots : [];
    if (!shots.length) throw new Error('No shots to animate (run the Director first)');

    // Ensure every shot has a motion prompt before animating.
    if (shots.some((s) => !s.motion_prompt)) {
        try { await runMotion(generationId); } catch { /* fall back to motion_intent per shot */ }
        const re = await loadGen(generationId);
        if (re && Array.isArray(re.shots)) shots.splice(0, shots.length, ...re.shots);
    }

    // Self-heal: infra errors (submit-shape bug, concurrency cap, rate limits)
    // are retryable and must not consume a shot's regen budget. Reset those so
    // they animate cleanly; genuine rejections (nsfw/failed) keep their count.
    for (const s of shots) {
        if (!s.video_url && !s.video_status_url && s.video_error
            && /missing ids|concurrent|429|\b400\b|rate limit|timed out/i.test(s.video_error)) {
            s.video_regens = 0;
            s.video_error = null;
        }
    }

    await query(`update generations set status = 'animating' where id = $1`, [generationId]);

    let made = 0, pending = 0, failed = 0, processed = 0, capped = false;
    for (const shot of shots) {
        if (shot.video_url) continue;
        if (!shot.image_url) { failed++; continue; }       // nothing to animate
        if (shot.qc && shot.qc.pass === false) { /* still animate best effort */ }
        if (processed >= max) break;
        // Cost ceiling: only blocks brand-new submissions, not resuming a job
        // already in flight on this shot.
        if (MAX_VIDEO_RENDERS && !shot.video_status_url && videoRendersSpent(shots) >= MAX_VIDEO_RENDERS) { capped = true; break; }
        processed++;

        // Resume an in-flight job from a previous call first.
        if (shot.video_status_url) {
            const resolved = await resumePending(shot);
            if (!resolved) { pending++; await save(generationId, shots); continue; }
            if (shot.video_url) { made++; await save(generationId, shots); continue; }
            // else fell through to retry below
        }

        let attempt = shot.video_regens || 0;
        let ok = false, concurrencyHit = false;
        while (attempt <= VIDEO_MAX_REGENS && !ok) {
            try {
                const out = await animateShot(shot);
                if (out.pending) {
                    shot.video_request_id = out.request_id;
                    shot.video_status_url = out.status_url;
                    shot.video_response_url = out.response_url || null;
                    shot.video_error = null;
                    pending++;
                    ok = true; // submitted; resume next call
                } else {
                    shot.video_url = out.video_url;
                    shot.video_request_id = out.request_id;
                    shot.video_error = null;
                    made++;
                    ok = true;
                }
            } catch (err) {
                // Concurrency cap / rate limit: stop submitting this tick and
                // resume next tick when jobs free up — do NOT spend the regen
                // budget on an infra throttle.
                if (/concurrent|429|rate limit/i.test(err.message)) {
                    shot.video_error = err.message;
                    concurrencyHit = true;
                    break;
                }
                attempt++;
                shot.video_regens = attempt;
                shot.video_error = err.message;
                if (attempt > VIDEO_MAX_REGENS) { failed++; break; }
            }
        }
        await save(generationId, shots);
        if (concurrencyHit) break; // back off; the next tick continues
    }

    const allDone = shots.every((s) => s.video_url);
    const anyPending = shots.some((s) => !s.video_url && s.video_status_url);
    const status = allDone ? 'assembling' : 'animating';
    await save(generationId, shots, status);
    return { generationId, total: shots.length, made, pending, failed, anyPending, capped, status };
}
