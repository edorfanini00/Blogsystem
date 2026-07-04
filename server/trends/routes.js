// ═══════════════════════════════════════════════════════════════════
// Trend Engine — Express routes (step 1)
// Mounted under /api/trends. Every route degrades gracefully when the
// database or EnsembleData key is not configured, so the rest of the app
// is never affected.
// ═══════════════════════════════════════════════════════════════════
import express from 'express';
import multer from 'multer';
import { isDbConfigured, dbSource, migrate, pingDb, query } from './db.js';
import { isEnsembleConfigured } from './ensembledata.js';
import { isApifyConfigured } from './apify.js';
import { runIngestCycle, listCandidates, getCandidateSnapshots } from './ingest.js';
import {
    createSolution, listSolutions, getSolution, updateSolution, deleteSolution,
    addFile, deleteFile, extractText,
} from './solutions.js';
import { scoreBatch } from './scorer.js';
import { runClustering, listClusters } from './cluster.js';
import { runTopicCycle, listTopics } from './topics.js';
import { generateReport, getLatestReport, listReports, getReport } from './insights.js';
import { isLlmConfigured } from './llm.js';
import {
    createGeneration, refreshGeneration, listGenerations,
    updateGenerationStatus, getGeneration, isVideoConfigured, videoModel,
} from './generate.js';
import { notify, isNotifyConfigured, notifyChannels } from './notify.js';
import { analyzeCandidate, isAnalyzeConfigured } from './analyze.js';
import { runDirector, directAndSave, directVariants } from './director.js';
import { runImages, isImageConfigured, isSourceFrameSupported } from './image.js';
import { runQc, isQcConfigured } from './qc.js';
import { runMotion, isMotionConfigured } from './motion.js';
import { runVideo, isVideoAgentConfigured } from './video.js';
import { runCopy, isCopyConfigured } from './copy.js';
import { runAssembly, isAssemblyConfigured, isVoiceoverConfigured } from './assembly.js';
import { runSlides, isSlidesConfigured } from './slides.js';
import { recordPerformance, sweepPerformance } from './performance.js';
import { addNote, recentNotes } from './memory.js';
import { getSettings as getAutopilotSettings, saveSettings as saveAutopilotSettings, runAutopilot, recentRuns as autopilotRuns } from './autopilot.js';
import { refreshOwnPage, getOwnPageCache } from './ownpage.js';
import { advanceGeneration, runChainSweep } from './chain.js';
import { isCaptionsConfigured } from './captions.js';
import { publishGeneration } from './publish.js';
import {
    notifyReviewReady, verifyReviewToken, isEmailConfigured, reviewEmailTo,
} from './email.js';
import { approveAndPost, regenerateWithFeedback } from './reviewer.js';
import {
    SEED_HASHTAGS,
    SURFACE_THRESHOLD,
    SCORE_WEIGHTS,
    MESSAGE_BANK,
    TOPIC_KEYWORDS,
    PLATFORMS,
    TREND_DISCOVERY,
    SEARCH_TERMS,
    TREND_LANG,
    HF_IMAGE_MODELS,
    IMAGE_PROVIDER,
    FAL_IMAGE_MODELS,
    HF_VIDEO_MODELS,
    VIDEO_PROVIDER,
    FAL_VIDEO_MODEL,
    MUSIC_URL,
    MATCH_SOURCE_LENGTH,
    REMAKE_MAX_SHOTS,
    isInstagramPublishConfigured,
} from './config.js';
import { isKeyframesSupported } from './keyframes.js';

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;

const router = express.Router();

// In-memory upload (text gets extracted then discarded; max 15MB/file).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function requireDb(res) {
    if (!isDbConfigured) {
        res.status(503).json({
            error: 'DATABASE_URL not configured. Set the Supabase Postgres connection string to enable the trend engine.',
        });
        return false;
    }
    return true;
}

// ─── GET /api/trends/thumb ──────────────────────────────────────
// Image proxy for video thumbnails. Instagram (cdninstagram/fbcdn) and
// TikTok CDNs block hotlinking with a 403 unless the request carries the
// platform's own Referer — which a browser can't send cross-origin. We fetch
// server-side with the right headers and stream the bytes back. Whitelisted
// hosts only, so it can't be used as an open proxy.
const THUMB_HOSTS = [
    'cdninstagram.com', 'fbcdn.net',
    'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokv.com', 'ttwstatic.com',
    'muscdn.com', 'ibyteimg.com', 'byteimg.com',
    'ytimg.com', 'ggpht.com',
];
function thumbReferer(host) {
    if (/instagram|fbcdn/.test(host)) return 'https://www.instagram.com/';
    if (/tiktok|muscdn|ibyteimg|byteimg|ttwstatic/.test(host)) return 'https://www.tiktok.com/';
    if (/ytimg|ggpht/.test(host)) return 'https://www.youtube.com/';
    return undefined;
}
router.get('/thumb', async (req, res) => {
    const u = req.query.u;
    if (!u || typeof u !== 'string') return res.status(400).end();
    let parsed;
    try { parsed = new URL(u); } catch { return res.status(400).end(); }
    if (parsed.protocol !== 'https:') return res.status(400).end();
    const host = parsed.hostname.toLowerCase();
    if (!THUMB_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
        return res.status(403).end();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
            Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
        };
        const ref = thumbReferer(host);
        if (ref) headers.Referer = ref;
        const r = await fetch(u, { headers, signal: controller.signal });
        if (!r.ok) return res.status(502).end();
        const ct = r.headers.get('content-type') || 'image/jpeg';
        if (!ct.startsWith('image/')) return res.status(415).end();
        const buf = Buffer.from(await r.arrayBuffer());
        res.set('Content-Type', ct);
        res.set('Cache-Control', 'public, max-age=86400, s-maxage=604800, immutable');
        return res.send(buf);
    } catch {
        return res.status(502).end();
    } finally {
        clearTimeout(timer);
    }
});

// ─── GET /api/trends/health ─────────────────────────────────────
router.get('/health', async (req, res) => {
    const out = {
        db: { configured: isDbConfigured, ok: false, source: dbSource },
        ingest: {
            provider: isApifyConfigured ? 'apify' : (isEnsembleConfigured ? 'ensembledata' : null),
            platforms: isApifyConfigured ? PLATFORMS : (isEnsembleConfigured ? ['tiktok'] : []),
            discovery: isApifyConfigured ? TREND_DISCOVERY : 'hashtag',
            searchTerms: isApifyConfigured ? SEARCH_TERMS.length : 0,
            lang: TREND_LANG || 'any',
        },
        apify: { configured: isApifyConfigured },
        ensembleData: { configured: isEnsembleConfigured },
        llm: { configured: isLlmConfigured },
        video: { configured: isVideoConfigured, model: videoModel },
        voiceover: { configured: !!ELEVENLABS_KEY },
        analyze: { configured: isAnalyzeConfigured },
        director: { configured: isLlmConfigured },
        lengthMatch: {
            enabled: MATCH_SOURCE_LENGTH,
            maxShots: REMAKE_MAX_SHOTS,
            keyframes: isKeyframesSupported,
        },
        image: {
            configured: isImageConfigured,
            provider: IMAGE_PROVIDER,
            sourceFrame: isSourceFrameSupported,
            models: IMAGE_PROVIDER === 'fal' ? FAL_IMAGE_MODELS : HF_IMAGE_MODELS,
            // Non-secret diagnostic: which credential env vars are present.
            env: {
                FAL_KEY: !!process.env.FAL_KEY,
                BLOB_READ_WRITE_TOKEN: !!process.env.BLOB_READ_WRITE_TOKEN,
                HIGGSFIELD_API_KEY: !!process.env.HIGGSFIELD_API_KEY,
                HIGGSFIELD_API_SECRET: !!process.env.HIGGSFIELD_API_SECRET,
                HIGGSFIELD_KEY: !!process.env.HIGGSFIELD_KEY,
                HF_KEY: !!process.env.HF_KEY,
            },
        },
        qc: { configured: isQcConfigured },
        motion: { configured: isMotionConfigured },
        videoAgent: {
            configured: isVideoAgentConfigured,
            provider: VIDEO_PROVIDER,
            model: VIDEO_PROVIDER === 'fal' ? FAL_VIDEO_MODEL : HF_VIDEO_MODELS.default,
        },
        copy: { configured: isCopyConfigured },
        assembly: {
            configured: isAssemblyConfigured,
            voiceover: isVoiceoverConfigured,
            captions: isCaptionsConfigured,
            music: !!MUSIC_URL,
        },
        slideshow: { configured: isSlidesConfigured },
        instagramPublish: { configured: isInstagramPublishConfigured },
        notify: { configured: isNotifyConfigured, channels: notifyChannels },
        reviewEmail: { configured: isEmailConfigured, to: reviewEmailTo },
        seedHashtags: SEED_HASHTAGS,
        topicKeywords: TOPIC_KEYWORDS,
        surfaceThreshold: SURFACE_THRESHOLD,
        weights: SCORE_WEIGHTS,
    };
    if (isDbConfigured) {
        try {
            out.db.now = await pingDb();
            out.db.ok = true;
        } catch (err) {
            out.db.error = err.message;
        }
    }
    res.json(out);
});

// ─── POST /api/trends/migrate ───────────────────────────────────
// Idempotent: creates the schema if it does not exist.
router.post('/migrate', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        await migrate();
        res.json({ ok: true, message: 'Schema applied.' });
    } catch (err) {
        console.error('❌ Trend migrate error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/trends/ingest ────────────────────────────────────
// Run one ingest cycle. Body: { hashtags?: string[], days?: number }.
router.post('/ingest', async (req, res) => {
    if (!requireDb(res)) return;
    if (!isApifyConfigured && !isEnsembleConfigured) {
        return res.status(503).json({
            error: 'No ingest provider configured. Set APIFY_TOKEN (multi-platform) or ENSEMBLEDATA_API_KEY (TikTok).',
        });
    }
    try {
        const { hashtags, days, platforms } = req.body || {};
        const summary = await runIngestCycle({ hashtags, days, platforms });
        res.json(summary);
    } catch (err) {
        console.error('❌ Trend ingest error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/trends/candidates ─────────────────────────────────
router.get('/candidates', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
        const rows = await listCandidates({ limit });
        res.json(rows);
    } catch (err) {
        console.error('❌ Trend candidates error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/trends/candidates/:id/snapshots ───────────────────
router.get('/candidates/:id/snapshots', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        const rows = await getCandidateSnapshots(req.params.id);
        res.json(rows);
    } catch (err) {
        console.error('❌ Trend snapshots error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/trends/candidates/:id/analyze ────────────────────
// Deep video analysis: feed the actual video (frames + on-screen text +
// audio) to a multimodal model and store the structured breakdown.
router.post('/candidates/:id/analyze', async (req, res) => {
    if (!requireDb(res)) return;
    if (!isAnalyzeConfigured) {
        return res.status(503).json({
            error: 'GEMINI_API_KEY not configured. Add it to enable video analysis.',
        });
    }
    try {
        const row = await analyzeCandidate(req.params.id);
        res.json({ ok: true, id: row.id, analysis: row.analysis, analyzed_at: row.analyzed_at });
    } catch (err) {
        console.error('❌ Trend analyze error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/trends/message-bank ───────────────────────────────
router.get('/message-bank', (req, res) => {
    res.json(MESSAGE_BANK);
});

// ═══════════════════════════════════════════════════════════════
// ─── Step 4: scoring ───────────────────────────────────────────
// POST /api/trends/score  { limit?, rescore?, solutionId? }
router.post('/score', async (req, res) => {
    if (!requireDb(res)) return;
    if (!isLlmConfigured) {
        return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured. Add it to enable scoring.' });
    }
    try {
        const { limit, rescore, solutionId } = req.body || {};
        const summary = await scoreBatch({
            limit: Math.min(parseInt(limit) || 20, 50),
            rescore: !!rescore,
            solutionId: solutionId || null,
        });
        res.json(summary);
    } catch (err) {
        console.error('❌ Trend score error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// ─── Step 3: clustering ────────────────────────────────────────
// POST /api/trends/cluster  → rebuild clusters
router.post('/cluster', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        res.json(await runClustering({ limit: Math.min(parseInt(req.body?.limit) || 300, 1000) }));
    } catch (err) {
        console.error('❌ Trend cluster error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trends/clusters  → real trends (2+ members)
router.get('/clusters', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        res.json(await listClusters({ limit: Math.min(parseInt(req.query.limit) || 50, 200) }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// ─── Step 8: listening layer (topics) ──────────────────────────
// POST /api/trends/topics/ingest → snapshot topic mention volumes
router.post('/topics/ingest', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        res.json(await runTopicCycle());
    } catch (err) {
        console.error('❌ Topic ingest error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trends/topics → latest per keyword, hottest first
router.get('/topics', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        res.json(await listTopics());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// ─── Video Generation chain — Director agent (spec §4) ─────────
// POST /api/trends/candidates/:id/direct
//   { target_mode: "product"|"custom"|"auto", product_id?, custom_prompt?, dryRun? }
// Image-first remake: produces the shot plan that mirrors the source format and
// retargets it. dryRun returns the plan without persisting (for confirmation).
router.post('/candidates/:id/direct', async (req, res) => {
    if (!requireDb(res)) return;
    if (!isLlmConfigured) {
        return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured. Add it to run the Director.' });
    }
    try {
        const { target_mode, product_id, custom_prompt, dryRun, variants, output_type } = req.body || {};
        const opts = {
            targetMode: target_mode || 'auto',
            productId: product_id || null,
            customPrompt: custom_prompt || null,
            outputType: output_type === 'slideshow' ? 'slideshow' : 'video',
            variants: variants ? parseInt(variants) : undefined,
        };
        if (dryRun) {
            const plan = await runDirector(req.params.id, opts);
            return res.json({ ok: true, dryRun: true, plan });
        }
        const { primary, variants: all, count } = await directVariants(req.params.id, opts);
        res.json({
            ok: true,
            generationId: primary.generation.id,
            status: primary.generation.status,
            plan: primary.plan,
            variants: count,
            variantIds: all.map((v) => v.generation.id),
        });
    } catch (err) {
        console.error('❌ Director error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Image agent (spec §6): render the shot plan into stills ────
// POST /api/trends/generations/:id/images  → render every shot (idempotent)
router.post('/generations/:id/images', async (req, res) => {
    if (!requireDb(res)) return;
    if (!isImageConfigured) {
        return res.status(503).json({ error: 'Higgsfield not configured. Set HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET.' });
    }
    try {
        const max = req.body?.max ?? req.query?.max;
        res.json(await runImages(req.params.id, { max: max ? parseInt(max) : Infinity }));
    } catch (err) {
        console.error('❌ Image agent error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── QC gate (spec §7): grade stills, regenerate failures ──────
// POST /api/trends/generations/:id/qc  → grade + improve-loop each shot
router.post('/generations/:id/qc', async (req, res) => {
    if (!requireDb(res)) return;
    if (!isQcConfigured) {
        return res.status(503).json({ error: 'GEMINI_API_KEY not configured (needed for QC grading).' });
    }
    try {
        res.json(await runQc(req.params.id));
    } catch (err) {
        console.error('❌ QC gate error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Motion agent (spec §8): write per-shot DoP motion prompts ─
// POST /api/trends/generations/:id/motion
router.post('/generations/:id/motion', async (req, res) => {
    if (!requireDb(res)) return;
    if (!isMotionConfigured) {
        return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured (needed for the Motion agent).' });
    }
    try {
        res.json(await runMotion(req.params.id));
    } catch (err) {
        console.error('❌ Motion agent error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Video agent (spec §9): animate stills into clips (DoP) ────
// POST /api/trends/generations/:id/video  { max? }  → staged + resumable
router.post('/generations/:id/video', async (req, res) => {
    if (!requireDb(res)) return;
    if (!isVideoAgentConfigured) {
        return res.status(503).json({ error: 'Higgsfield not configured. Set HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET.' });
    }
    try {
        const max = req.body?.max ?? req.query?.max;
        res.json(await runVideo(req.params.id, { max: max ? parseInt(max) : 2 }));
    } catch (err) {
        console.error('❌ Video agent error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Copy agent (spec §10): voiceover + per-platform captions ──
// POST /api/trends/generations/:id/copy
router.post('/generations/:id/copy', async (req, res) => {
    if (!requireDb(res)) return;
    if (!isCopyConfigured) {
        return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured (needed for the Copy agent).' });
    }
    try {
        res.json(await runCopy(req.params.id));
    } catch (err) {
        console.error('❌ Copy agent error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Assembly agent (spec §11): stitch clips + VO → final cut ──
// POST /api/trends/generations/:id/assemble  → asset_url, status 'review'
router.post('/generations/:id/assemble', async (req, res) => {
    if (!requireDb(res)) return;
    if (!isAssemblyConfigured) {
        return res.status(503).json({ error: 'Assembly not available (needs Higgsfield credentials + ffmpeg runtime).' });
    }
    try {
        const out = await runAssembly(req.params.id);
        if (out?.asset_url) {
            await notify(`🎬 CeleriTech remake assembled and ready for review.\nTarget: ${out.generation?.resolved_target || ''}\nReview it in Trend Analysis → Queue.`).catch(() => {});
            if (out.status === 'review') await notifyReviewReady(req.params.id, { req }).catch(() => {});
        }
        res.json(out);
    } catch (err) {
        console.error('❌ Assembly agent error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Slides agent: compose a photo slideshow/carousel from the stills ──
// POST /api/trends/generations/:id/slides → slide_urls + reel asset_url, 'review'
router.post('/generations/:id/slides', async (req, res) => {
    if (!requireDb(res)) return;
    if (!isSlidesConfigured) {
        return res.status(503).json({ error: 'Slideshow assembly not available (needs BLOB_READ_WRITE_TOKEN + ffmpeg runtime).' });
    }
    try {
        const out = await runSlides(req.params.id);
        if (out?.asset_url) {
            await notify(`🖼️ CeleriTech slideshow composed and ready for review (Queue tab).`).catch(() => {});
            if (out.status === 'review') await notifyReviewReady(req.params.id, { req }).catch(() => {});
        }
        res.json(out);
    } catch (err) {
        console.error('❌ Slides agent error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Chain runner: advance a generation one step (manual resume) ──
// POST /api/trends/generations/:id/advance
router.post('/generations/:id/advance', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        res.json(await advanceGeneration(req.params.id));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Chain cron: sweep all in-flight generations to completion ────
// GET/POST /api/trends/chain/cron  (Vercel Cron + manual). Advances each
// active generation one bounded step; call on a schedule to finish renders
// without depending on the browser staying open.
async function runChainCronHandler(req, res) {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
        const auth = req.headers.authorization || '';
        const token = auth.replace(/^Bearer\s+/i, '');
        if (token !== cronSecret && req.query.secret !== cronSecret) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }
    if (!requireDb(res)) return;
    try {
        const out = await runChainSweep({});
        // Notify on anything that just reached review this sweep.
        const justReady = (out.steps || []).filter((s) => s.step === 'assemble' && s.status === 'review' && s.asset_url);
        for (const s of justReady) {
            await notify(`🎬 CeleriTech remake assembled and ready for review (Queue tab).`).catch(() => {});
        }
        res.json(out);
    } catch (err) {
        console.error('❌ Chain cron error:', err.message);
        res.status(500).json({ error: err.message });
    }
}
router.get('/chain/cron', runChainCronHandler);
router.post('/chain/cron', runChainCronHandler);

// ═══════════════════════════════════════════════════════════════
// ─── Review by email: watch → approve & post OR request changes ─
// A generation that reaches 'review' triggers an email (see email.js) linking
// here. These endpoints are guarded by an HMAC token (no login needed) so the
// reviewer can act straight from their inbox.
// ═══════════════════════════════════════════════════════════════
function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function reviewPageHtml(gen, token) {
    const title = escHtml(gen.resolved_target || gen.caption || 'Remake');
    const isSlideshow = gen.output_type === 'slideshow';
    let slides = [];
    if (isSlideshow) {
        try {
            const raw = typeof gen.slide_urls === 'string' ? JSON.parse(gen.slide_urls) : (gen.slide_urls || []);
            slides = (raw || []).map((s) => (typeof s === 'string' ? s : s?.url)).filter(Boolean);
        } catch { slides = []; }
    }
    const posted = gen.status === 'posted';
    const media = isSlideshow && slides.length
        ? `<div class="slides">${slides.map((u) => `<img src="${escHtml(u)}" alt="slide">`).join('')}</div>`
        : (gen.asset_url
            ? `<video src="${escHtml(gen.asset_url)}" controls playsinline style="width:100%;border-radius:12px;background:#000;"></video>`
            : `<p class="muted">No preview available yet.</p>`);
    const caption = gen.caption
        ? `<div class="card"><div class="label">Caption</div><div>${escHtml(gen.caption)}</div></div>` : '';
    const revLine = gen.regen_count > 0 ? `<div class="pill">Revision #${gen.regen_count}</div>` : '';

    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review — ${title}</title>
<style>
  :root{--indigo:#6366f1;--ink:#111827;--muted:#6b7280;}
  *{box-sizing:border-box;}
  body{margin:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:var(--ink);padding:20px;}
  .wrap{max-width:640px;margin:0 auto;}
  .head{display:flex;align-items:center;gap:10px;margin-bottom:16px;}
  .brand{font-size:12px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--indigo);}
  .pill{display:inline-block;font-size:12px;font-weight:600;color:#7c3aed;background:#ede9fe;padding:3px 10px;border-radius:999px;}
  h1{font-size:20px;margin:6px 0 16px;}
  .panel{background:#fff;border-radius:16px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08);}
  .card{margin-top:14px;padding:12px 14px;background:#f9fafb;border-radius:10px;font-size:14px;line-height:1.5;}
  .label{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;}
  .slides{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;}
  .slides img{width:100%;border-radius:8px;display:block;}
  .muted{color:var(--muted);}
  .actions{margin-top:20px;display:flex;flex-direction:column;gap:12px;}
  button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:14px 18px;cursor:pointer;}
  .primary{background:var(--indigo);color:#fff;font-size:16px;}
  .primary:disabled{opacity:.5;cursor:default;}
  .ghost{background:#fff;border:1.5px solid #e5e7eb;color:var(--ink);}
  textarea{width:100%;min-height:96px;border:1.5px solid #e5e7eb;border-radius:10px;padding:12px;font:inherit;resize:vertical;}
  .divider{margin:22px 0 6px;border-top:1px solid #eef0f3;}
  .sub{font-size:13px;color:var(--muted);margin:14px 0 8px;}
  .toast{margin-top:14px;padding:12px 14px;border-radius:10px;font-size:14px;display:none;}
  .toast.ok{background:#ecfdf5;color:#065f46;display:block;}
  .toast.err{background:#fef2f2;color:#991b1b;display:block;}
</style></head>
<body><div class="wrap">
  <div class="head"><span class="brand">CeleriTech Studio</span> ${revLine}</div>
  <div class="panel">
    <h1>${title}</h1>
    ${media}
    ${caption}
    <div id="toast" class="toast"></div>
    <div class="actions" id="actions" ${posted ? 'style="display:none"' : ''}>
      <button class="primary" id="approveBtn">✓ Approve &amp; Post to Instagram</button>
      <div class="divider"></div>
      <div class="sub">Or tell it what to change — it'll regenerate and email you the new version:</div>
      <textarea id="feedback" placeholder="e.g. Make the hook punchier, swap the second scene for an office setting, warmer color grade..."></textarea>
      <button class="ghost" id="regenBtn">↻ Regenerate with these changes</button>
    </div>
    ${posted ? '<div class="toast ok">This version has already been posted. ✓</div>' : ''}
  </div>
</div>
<script>
  const ID = ${JSON.stringify(gen.id)};
  const TOKEN = ${JSON.stringify(token)};
  const toast = document.getElementById('toast');
  const actions = document.getElementById('actions');
  function show(msg, ok){ toast.textContent = msg; toast.className = 'toast ' + (ok ? 'ok' : 'err'); }
  async function call(path, body){
    const r = await fetch('/api/trends/review/' + ID + path + '?token=' + encodeURIComponent(TOKEN), {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{})
    });
    const data = await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(data.error || ('HTTP '+r.status));
    return data;
  }
  document.getElementById('approveBtn').onclick = async (e)=>{
    e.target.disabled = true; show('Posting…', true);
    try{
      const d = await call('/approve', {});
      if(d.posted){ show('Posted to Instagram! ' + (d.permalink? d.permalink : ''), true); }
      else { show('Approved. (Instagram publishing isn\\'t configured, so post it manually.)', true); }
      actions.style.display='none';
    }catch(err){ show(err.message, false); e.target.disabled=false; }
  };
  document.getElementById('regenBtn').onclick = async (e)=>{
    const fb = document.getElementById('feedback').value.trim();
    if(!fb){ show('Please describe what to change first.', false); return; }
    e.target.disabled = true; show('Starting a new version with your notes…', true);
    try{
      await call('/regenerate', { feedback: fb });
      show('Got it — regenerating now. You\\'ll get another email when the new version is ready.', true);
      actions.style.display='none';
    }catch(err){ show(err.message, false); e.target.disabled=false; }
  };
</script>
</body></html>`;
}

router.get('/review/:id', async (req, res) => {
    if (!requireDb(res)) return;
    if (!verifyReviewToken(req.params.id, req.query.token)) {
        return res.status(403).type('html').send('<h1>Invalid or expired link</h1><p>This review link is not valid.</p>');
    }
    try {
        const gen = await getGeneration(req.params.id);
        if (!gen) return res.status(404).type('html').send('<h1>Not found</h1>');
        res.type('html').send(reviewPageHtml(gen, req.query.token));
    } catch (err) {
        res.status(500).type('html').send(`<h1>Error</h1><p>${escHtml(err.message)}</p>`);
    }
});

router.post('/review/:id/approve', async (req, res) => {
    if (!requireDb(res)) return;
    const token = req.query.token || req.body?.token;
    if (!verifyReviewToken(req.params.id, token)) return res.status(403).json({ error: 'Invalid token' });
    try {
        res.json(await approveAndPost(req.params.id));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.post('/review/:id/regenerate', async (req, res) => {
    if (!requireDb(res)) return;
    const token = req.query.token || req.body?.token;
    if (!verifyReviewToken(req.params.id, token)) return res.status(403).json({ error: 'Invalid token' });
    try {
        res.json(await regenerateWithFeedback(req.params.id, req.body?.feedback));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Manual trigger to (re)send the review email for a generation (e.g. testing).
router.post('/generations/:id/send-review-email', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        // Allow forcing a resend by clearing the guard first.
        if (req.body?.force || req.query.force) {
            await query('update generations set review_email_sent = false where id = $1', [req.params.id]).catch(() => {});
        }
        res.json(await notifyReviewReady(req.params.id, { req }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trends/generations/:id → one generation with shots (chain state)
router.get('/generations/:id', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        const g = await getGeneration(req.params.id);
        if (!g) return res.status(404).json({ error: 'Generation not found' });
        res.json(g);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// ─── Step 6: generation pipeline ───────────────────────────────
// POST /api/trends/candidates/:id/recreate  { solutionId? }
router.post('/candidates/:id/recreate', async (req, res) => {
    if (!requireDb(res)) return;
    if (!isLlmConfigured) {
        return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured. Add it to generate scripts.' });
    }
    try {
        const gen = await createGeneration(req.params.id, { solutionId: req.body?.solutionId || null });
        res.json(gen);
    } catch (err) {
        console.error('❌ Recreate error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trends/generations  ?status=
router.get('/generations', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        const rows = await listGenerations({
            status: req.query.status || null,
            limit: Math.min(parseInt(req.query.limit) || 100, 1000),
        });
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/trends/generations/:id/refresh  → poll fal, promote to review
router.post('/generations/:id/refresh', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        const gen = await refreshGeneration(req.params.id);
        if (gen && gen._justReady) {
            await notify(`🎬 New CeleriTech video ready for review.\nCaption: ${gen.caption || ''}\nReview it in the Trend Analysis → Queue tab.`);
        }
        res.json(gen);
    } catch (err) {
        console.error('❌ Generation refresh error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/trends/generations/:id  { status, approvedBy?, posted_url? }
router.put('/generations/:id', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        const { status, approvedBy, posted_url } = req.body || {};
        const gen = await updateGenerationStatus(req.params.id, status, approvedBy, { postedUrl: posted_url || null });
        if (!gen) return res.status(404).json({ error: 'Generation not found' });
        if (status === 'approved') {
            await notify(`✅ Approved for posting: ${gen.caption || gen.id}\nAsset: ${gen.asset_url || '(script only)'}`);
        }
        if (status === 'posted') {
            // Memory: log what we posted so it compounds into the next run.
            addNote({
                note: `Posted a ${gen.output_type || 'video'} (${gen.director_json?.format || ''}) for "${gen.resolved_target || ''}" — ${gen.target_mode || ''} mode, remaking a ${gen.platform || ''} source.`,
                outputType: gen.output_type || 'video',
            }).catch(() => {});
            // Kick off an initial performance snapshot if we have the public URL.
            if (gen.posted_url) recordPerformance(gen.id).catch(() => {});
        }
        res.json(gen);
    } catch (err) {
        console.error('❌ Generation update error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/trends/generations/:id/performance  { url? } → scrape + store stats
router.post('/generations/:id/performance', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        res.json(await recordPerformance(req.params.id, { url: req.body?.url || null }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/trends/generations/:id/publish → post the finished reel/carousel to
// Instagram, mark it posted, and start tracking performance.
router.post('/generations/:id/publish', async (req, res) => {
    if (!requireDb(res)) return;
    if (!isInstagramPublishConfigured) {
        return res.status(503).json({ error: 'Instagram publishing not configured (set IG_USER_ID and IG_ACCESS_TOKEN).' });
    }
    try {
        const out = await publishGeneration(req.params.id);
        addNote({ note: `Auto-published a ${out.type} to Instagram${out.permalink ? ` (${out.permalink})` : ''}.`, scope: 'global' }).catch(() => {});
        if (out.permalink) recordPerformance(req.params.id, { url: out.permalink }).catch(() => {});
        await notify(`📲 Published to Instagram: ${out.permalink || out.mediaId}`).catch(() => {});
        res.json({ ok: true, ...out });
    } catch (err) {
        console.error('❌ Instagram publish error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET/POST /api/trends/performance/cron → refresh stats for posted generations
async function performanceCronHandler(req, res) {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
        const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (token !== cronSecret && req.query.secret !== cronSecret) return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!requireDb(res)) return;
    try {
        res.json(await sweepPerformance({}));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}
router.get('/performance/cron', performanceCronHandler);
router.post('/performance/cron', performanceCronHandler);

// ═══════════════════════════════════════════════════════════════
// ─── Autopilot — autonomous daily generation ───────────────────
// Two agents share these endpoints, selected by ?agent= (or body.agent):
//   • default → fits viral concepts to a product/brand
//   • ownpage → retargets viral concepts to our own Instagram content
// GET status (settings + recent runs), PUT settings, POST run-now, cron.
function pickAgent(v) {
    return v === 'ownpage' ? 'ownpage' : 'default';
}

router.get('/autopilot', async (req, res) => {
    if (!requireDb(res)) return;
    const agent = pickAgent(req.query.agent);
    try {
        const [settings, runs] = await Promise.all([
            getAutopilotSettings(agent),
            autopilotRuns({ limit: 20, agent }),
        ]);
        res.json({ settings, runs, agent });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/autopilot/settings', async (req, res) => {
    if (!requireDb(res)) return;
    const agent = pickAgent(req.body?.agent || req.query.agent);
    try {
        res.json({ settings: await saveAutopilotSettings(req.body || {}, agent) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Manual trigger (ignores the enabled flag so you can test it on demand).
router.post('/autopilot/run', async (req, res) => {
    if (!requireDb(res)) return;
    if (!isLlmConfigured) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured (needed for the Director).' });
    const agent = pickAgent(req.body?.agent || req.query.agent);
    try {
        res.json(await runAutopilot({ trigger: 'manual', force: true, agent }));
    } catch (err) {
        console.error('❌ Autopilot run error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET/POST daily cron. Honors the enabled flag; advances nothing if disabled.
function makeAutopilotCron(agent) {
    return async function autopilotCronHandler(req, res) {
        const cronSecret = process.env.CRON_SECRET;
        if (cronSecret) {
            const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
            if (token !== cronSecret && req.query.secret !== cronSecret) return res.status(401).json({ error: 'Unauthorized' });
        }
        if (!requireDb(res)) return;
        try {
            const out = await runAutopilot({ trigger: 'cron', agent });
            if (out?.made) {
                const src = agent === 'ownpage' ? 'your Instagram content' : 'your top-scoring videos';
                await notify(`🤖 Autopilot started ${out.made} new remake${out.made > 1 ? 's' : ''} from ${src}.`).catch(() => {});
            }
            res.json(out);
        } catch (err) {
            console.error('❌ Autopilot cron error:', err.message);
            res.status(500).json({ error: err.message });
        }
    };
}
router.get('/autopilot/cron', makeAutopilotCron('default'));
router.post('/autopilot/cron', makeAutopilotCron('default'));
router.get('/autopilot/ownpage/cron', makeAutopilotCron('ownpage'));
router.post('/autopilot/ownpage/cron', makeAutopilotCron('ownpage'));

// ─── Own Instagram page awareness ───────────────────────────────
// GET  /api/trends/ownpage        → cached own-page insights
// POST /api/trends/ownpage/refresh → scrape + refresh cache
router.get('/ownpage', async (req, res) => {
    try {
        const cache = await getOwnPageCache();
        if (!cache) return res.json({ status: 'empty', message: 'No own-page data yet. Set OWN_INSTAGRAM_HANDLE and POST /ownpage/refresh.' });
        res.json({ status: 'ok', ...cache });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// Accepts GET (Vercel Cron) + POST (manual). Optional CRON_SECRET guard.
async function ownPageRefreshHandler(req, res) {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.method === 'GET') {
        const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (token !== cronSecret && req.query.secret !== cronSecret) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }
    try {
        res.json(await refreshOwnPage());
    } catch (err) {
        console.error('❌ Own-page refresh error:', err.message);
        res.status(500).json({ error: err.message });
    }
}
router.get('/ownpage/refresh', ownPageRefreshHandler);
router.post('/ownpage/refresh', ownPageRefreshHandler);

// Strategy notes (run memory) — list + add.
router.get('/notes', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        res.json({ notes: await recentNotes({ outputType: req.query.output_type || null, limit: 20 }) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
router.post('/notes', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        const note = await addNote({ note: req.body?.note, scope: req.body?.scope || 'global', outputType: req.body?.output_type || null });
        if (!note) return res.status(400).json({ error: 'note text required' });
        res.json(note);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trends/generations/:id/voiceover  → ElevenLabs TTS of the script
router.get('/generations/:id/voiceover', async (req, res) => {
    if (!requireDb(res)) return;
    if (!ELEVENLABS_KEY) {
        return res.status(503).json({ error: 'ELEVENLABS_API_KEY not configured.' });
    }
    try {
        const gen = await getGeneration(req.params.id);
        if (!gen) return res.status(404).json({ error: 'Generation not found' });
        const text = gen.script || '';
        if (!text.trim()) return res.status(400).json({ error: 'No voiceover text on this generation' });

        const voiceId = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';
        const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
            method: 'POST',
            headers: {
                'xi-api-key': ELEVENLABS_KEY,
                'Content-Type': 'application/json',
                Accept: 'audio/mpeg',
            },
            body: JSON.stringify({
                text,
                model_id: 'eleven_multilingual_v2',
                voice_settings: { stability: 0.5, similarity_boost: 0.75 },
            }),
        });
        if (!r.ok) {
            const body = await r.text();
            return res.status(r.status).json({ error: `ElevenLabs ${r.status}: ${body.slice(0, 160)}` });
        }
        res.setHeader('Content-Type', 'audio/mpeg');
        const buf = Buffer.from(await r.arrayBuffer());
        res.send(buf);
    } catch (err) {
        console.error('❌ Voiceover error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// ─── Scheduling: cron (Vercel Cron hits this on a schedule) ─────
// Runs the full cycle: ingest → topics → cluster → score the new ones.
// Accepts GET (Vercel cron default) and POST. Each stage degrades on its
// own so a missing key never breaks the rest.
async function runCron(req, res) {
    // When CRON_SECRET is set (Vercel sends it as a Bearer token on scheduled
    // invocations), require it. Without it configured, stay open so manual
    // triggering keeps working.
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
        const auth = req.headers.authorization || '';
        const token = auth.replace(/^Bearer\s+/i, '');
        if (token !== cronSecret && req.query.secret !== cronSecret) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }
    if (!isDbConfigured) return res.status(503).json({ error: 'DATABASE_URL not configured' });
    const out = { startedAt: new Date().toISOString(), stages: {} };
    try {
        if (isApifyConfigured || isEnsembleConfigured) {
            out.stages.ingest = await runIngestCycle({});
        } else {
            out.stages.ingest = { skipped: 'No ingest provider configured (APIFY_TOKEN or ENSEMBLEDATA_API_KEY)' };
        }
    } catch (err) { out.stages.ingest = { error: err.message }; }

    try { out.stages.topics = await runTopicCycle(); }
    catch (err) { out.stages.topics = { error: err.message }; }

    try { out.stages.cluster = await runClustering({}); }
    catch (err) { out.stages.cluster = { error: err.message }; }

    try {
        if (isLlmConfigured) out.stages.score = await scoreBatch({ limit: 30 });
        else out.stages.score = { skipped: 'ANTHROPIC_API_KEY not configured' };
    } catch (err) { out.stages.score = { error: err.message }; }

    out.finishedAt = new Date().toISOString();
    res.json(out);
}
router.get('/cron', runCron);
router.post('/cron', runCron);

// ═══════════════════════════════════════════════════════════════
// ─── Weekly intelligence reports (trend-spotting analyst) ──────
// POST /api/trends/report      → generate a fresh weekly report now
// GET  /api/trends/report/latest → most recent stored report
// GET  /api/trends/reports     → history (id + summary)
// GET  /api/trends/report/:id  → one full report
// GET/POST /api/trends/report/cron → scheduled weekly generation
// NOTE: order matters — specific paths declared before '/report/:id'.
router.post('/report', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        const days = Math.min(Math.max(parseInt(req.body?.days) || 7, 1), 30);
        const report = await generateReport({ days });
        res.json(report);
    } catch (err) {
        console.error('❌ Trend report error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.get('/report/latest', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        res.json(await getLatestReport());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/reports', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        res.json(await listReports({ limit: Math.min(parseInt(req.query.limit) || 12, 50) }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

async function runReportCron(req, res) {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
        const auth = req.headers.authorization || '';
        const token = auth.replace(/^Bearer\s+/i, '');
        if (token !== cronSecret && req.query.secret !== cronSecret) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }
    if (!requireDb(res)) return;
    try {
        const report = await generateReport({ days: 7 });
        res.json({ ok: true, reportId: report.id, confidence: report.confidence });
    } catch (err) {
        console.error('❌ Trend report cron error:', err.message);
        res.status(500).json({ error: err.message });
    }
}
router.get('/report/cron', runReportCron);
router.post('/report/cron', runReportCron);

router.get('/report/:id', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        const report = await getReport(req.params.id);
        if (!report) return res.status(404).json({ error: 'Report not found' });
        res.json(report);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// ─── Solutions knowledge base ("the brain") ────────────────────
// ═══════════════════════════════════════════════════════════════

// GET /api/trends/solutions — list with file counts
router.get('/solutions', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        res.json(await listSolutions());
    } catch (err) {
        console.error('❌ Solutions list error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/trends/solutions — create
router.post('/solutions', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        const body = req.body || {};
        if (!body.name || !body.name.trim()) return res.status(400).json({ error: 'Solution name is required' });
        const sol = await createSolution({ ...body, name: body.name.trim() });
        res.json(sol);
    } catch (err) {
        console.error('❌ Solution create error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trends/solutions/:id — one with files
router.get('/solutions/:id', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        const sol = await getSolution(req.params.id);
        if (!sol) return res.status(404).json({ error: 'Solution not found' });
        res.json(sol);
    } catch (err) {
        console.error('❌ Solution get error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/trends/solutions/:id — update
router.put('/solutions/:id', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        const sol = await updateSolution(req.params.id, req.body || {});
        if (!sol) return res.status(404).json({ error: 'Solution not found' });
        res.json(sol);
    } catch (err) {
        console.error('❌ Solution update error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/trends/solutions/:id
router.delete('/solutions/:id', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        await deleteSolution(req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Solution delete error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/trends/solutions/:id/files — upload knowledge files
router.post('/solutions/:id/files', upload.array('files', 10), async (req, res) => {
    if (!requireDb(res)) return;
    try {
        const sol = await getSolution(req.params.id);
        if (!sol) return res.status(404).json({ error: 'Solution not found' });

        const saved = [];
        for (const file of req.files || []) {
            const text = await extractText(file.buffer, file.originalname, file.mimetype);
            const row = await addFile(req.params.id, {
                filename: file.originalname,
                mimeType: file.mimetype,
                sizeBytes: file.size,
                extractedText: text,
            });
            saved.push(row);
        }
        res.json({ success: true, files: saved });
    } catch (err) {
        console.error('❌ Solution file upload error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/trends/solutions/:id/files/:fileId
router.delete('/solutions/:id/files/:fileId', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        await deleteFile(req.params.id, req.params.fileId);
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Solution file delete error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

export default router;
