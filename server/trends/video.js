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
    TALKING_AUDIO_NATIVE, FAL_TALKING_MODEL,
} from './config.js';

const USE_FAL_VIDEO = VIDEO_PROVIDER === 'fal';
// On-camera dialogue is generated with an audio-native model on fal (Kling
// 2.6/3.0 by default, optionally Veo 3), available whenever FAL_KEY is set —
// independent of the base video provider.
const TALKING_AVAILABLE = TALKING_AUDIO_NATIVE && fal.isFalConfigured;

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

// Kling 2.6 / 3.0 / o3 use a different image-to-video schema than the older
// Kling 2.x / 2.5-turbo: { start_image_url } (not image_url), a 3..15s duration
// window, and native audio via generate_audio. Detect them so we send the right
// fields (and can render lip-synced on-camera speech).
function isKlingAudioGen(model) {
    return /kling-video\/(v2\.6|v3|o3)/i.test(model || '');
}

// Pick the clip length to REQUEST (string, per fal's enum) so the generated clip
// is long enough to trim down to the shot's target_duration in assembly. Window
// depends on the model: Kling 2.6/3.0 = 3..15, Seedance = 3..12, older Kling =
// "5"|"10". Falls back to the configured default when no target is set.
function falDurationFor(model, targetDuration) {
    const t = Number(targetDuration);
    if (isKlingAudioGen(model)) {
        const n = (!t || t <= 0) ? (Number(FAL_VIDEO_DURATION) || 5) : t;
        return String(Math.min(Math.max(Math.ceil(n), 3), 15));
    }
    if (/seedance/i.test(model)) {
        if (!t || t <= 0) return FAL_VIDEO_DURATION;
        return String(Math.min(Math.max(Math.ceil(t), 3), 12));
    }
    if (!t || t <= 0) return FAL_VIDEO_DURATION;
    return t <= 5 ? '5' : '10';
}

// Build a fal image-to-video input for any supported model. Handles the schema
// split between Kling 2.6/3.0 (start_image_url, generate_audio, 3..15s) and the
// older image_url models, plus Seedance extras. When `dialogue` is given (and
// the model is audio-capable Kling), the line is embedded in the prompt and
// generate_audio is set so the character speaks it lip-synced.
function falVideoInput(model, { imageUrl, motionPrompt, targetDuration, audio = false, dialogue = '' }) {
    const duration = falDurationFor(model, targetDuration);
    if (isKlingAudioGen(model)) {
        const spoken = (audio && dialogue)
            ? ` The person looks at the camera and says, clearly and naturally: "${dialogue}". Their lips are precisely synced to these words.`
            : '';
        const input = {
            prompt: `${motionPrompt}${spoken}`.trim(),
            start_image_url: imageUrl,
            duration,
        };
        if (audio) input.generate_audio = true;
        return input;
    }
    if (/seedance/i.test(model)) {
        return { prompt: motionPrompt, image_url: imageUrl, duration, resolution: '1080p', aspect_ratio: 'auto' };
    }
    return { prompt: motionPrompt, image_url: imageUrl, duration };
}

// Submit one still for animation. Returns
//   { video_url } | { pending, request_id, status_url, response_url }, tagged
// with provider ('fal'|'hf') and has_audio so resume/assembly handle it right.
async function animateShot(shot, { deadlineMs = 110000, talking = false } = {}) {
    const motion = shot.motion_prompt || shot.motion_intent || DEFAULT_MOTION;
    if (talking) {
        // On-camera dialogue → audio-native Kling (2.6/3.0): same engine the
        // playbook recommends, with the spoken line baked into the clip.
        const input = falVideoInput(FAL_TALKING_MODEL, {
            imageUrl: shot.image_url, motionPrompt: motion,
            targetDuration: shot.target_duration, audio: true, dialogue: shot.dialogue,
        });
        const out = await fal.subscribe(FAL_TALKING_MODEL, input, { deadlineMs, pollMs: 4000 });
        if (out.pending) {
            return {
                pending: true, request_id: out.request_id,
                status_url: out.status_url, response_url: out.response_url,
                provider: 'fal', has_audio: true,
            };
        }
        const url = fal.pickVideoUrl(out.result);
        if (!url) throw new Error(`${FAL_TALKING_MODEL} completed but no video URL`);
        return { video_url: url, request_id: out.request_id, provider: 'fal', has_audio: true };
    }
    if (USE_FAL_VIDEO) {
        const input = falVideoInput(FAL_VIDEO_MODEL, {
            imageUrl: shot.image_url, motionPrompt: motion, targetDuration: shot.target_duration,
        });
        const out = await fal.subscribe(FAL_VIDEO_MODEL, input, { deadlineMs, pollMs: 4000 });
        if (out.pending) {
            return {
                pending: true, request_id: out.request_id,
                status_url: out.status_url, response_url: out.response_url,
                provider: 'fal',
            };
        }
        const url = fal.pickVideoUrl(out.result);
        if (!url) throw new Error(`${FAL_VIDEO_MODEL} completed but no video URL`);
        return { video_url: url, request_id: out.request_id, provider: 'fal' };
    }
    const out = await subscribe(DOP, dopArgs(shot.image_url, motion), { deadlineMs, pollMs: 4000 });
    if (out.pending) {
        return { pending: true, request_id: out.request_id, status_url: out.status_url, provider: 'hf' };
    }
    const url = pickVideoUrl(out.result);
    if (!url) throw new Error('DoP completed but no video URL');
    return { video_url: url, request_id: out.request_id, provider: 'hf' };
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
    // The talking (Veo 3) path runs on fal even when the base provider is
    // Higgsfield, so resume by the provider recorded on the shot at submit time.
    const useFal = shot.video_provider ? shot.video_provider === 'fal' : USE_FAL_VIDEO;
    try {
        const r = useFal
            ? await fal.poll(shot.video_status_url, shot.video_response_url, { deadlineMs: 100000, pollMs: 4000 })
            : await poll(shot.video_status_url, { deadlineMs: 100000, pollMs: 4000 });
        if (r.pending) return false;
        const url = useFal ? fal.pickVideoUrl(r.result) : pickVideoUrl(r.result);
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

    // On-camera dialogue sources render their speaking shots with an audio-native
    // model (Veo 3) so the character actually talks; everything else stays on the
    // normal silent-clip path. Requires fal (Veo 3 host).
    const onCamera = gen.director_json?.speech_mode === 'on_camera';

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

        const talking = onCamera && shot.speaking === true && TALKING_AVAILABLE;
        let attempt = shot.video_regens || 0;
        let ok = false, concurrencyHit = false;
        while (attempt <= VIDEO_MAX_REGENS && !ok) {
            try {
                const out = await animateShot(shot, { talking });
                if (out.pending) {
                    shot.video_request_id = out.request_id;
                    shot.video_status_url = out.status_url;
                    shot.video_response_url = out.response_url || null;
                    shot.video_provider = out.provider || null;
                    shot.has_audio = out.has_audio === true;
                    shot.video_error = null;
                    pending++;
                    ok = true; // submitted; resume next call
                } else {
                    shot.video_url = out.video_url;
                    shot.video_request_id = out.request_id;
                    shot.video_provider = out.provider || null;
                    shot.has_audio = out.has_audio === true;
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
