// ═══════════════════════════════════════════════════════════════════
// Trend Engine — Express routes (step 1)
// Mounted under /api/trends. Every route degrades gracefully when the
// database or EnsembleData key is not configured, so the rest of the app
// is never affected.
// ═══════════════════════════════════════════════════════════════════
import express from 'express';
import multer from 'multer';
import { isDbConfigured, dbSource, migrate, pingDb } from './db.js';
import { isEnsembleConfigured } from './ensembledata.js';
import { runIngestCycle, listCandidates, getCandidateSnapshots } from './ingest.js';
import {
    createSolution, listSolutions, getSolution, updateSolution, deleteSolution,
    addFile, deleteFile, extractText,
} from './solutions.js';
import { scoreBatch } from './scorer.js';
import { runClustering, listClusters } from './cluster.js';
import { runTopicCycle, listTopics } from './topics.js';
import { isLlmConfigured } from './llm.js';
import {
    createGeneration, refreshGeneration, listGenerations,
    updateGenerationStatus, getGeneration, isVideoConfigured, videoModel,
} from './generate.js';
import { notify, isNotifyConfigured, notifyChannels } from './notify.js';
import {
    SEED_HASHTAGS,
    SURFACE_THRESHOLD,
    SCORE_WEIGHTS,
    MESSAGE_BANK,
    TOPIC_KEYWORDS,
} from './config.js';

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

// ─── GET /api/trends/health ─────────────────────────────────────
router.get('/health', async (req, res) => {
    const out = {
        db: { configured: isDbConfigured, ok: false, source: dbSource },
        ensembleData: { configured: isEnsembleConfigured },
        llm: { configured: isLlmConfigured },
        video: { configured: isVideoConfigured, model: videoModel },
        voiceover: { configured: !!ELEVENLABS_KEY },
        notify: { configured: isNotifyConfigured, channels: notifyChannels },
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
    if (!isEnsembleConfigured) {
        return res.status(503).json({
            error: 'ENSEMBLEDATA_API_KEY not configured. Add the key to run a live ingest cycle.',
        });
    }
    try {
        const { hashtags, days } = req.body || {};
        const summary = await runIngestCycle({ hashtags, days });
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
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
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
            limit: Math.min(parseInt(req.query.limit) || 50, 200),
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

// PUT /api/trends/generations/:id  { status, approvedBy? }
router.put('/generations/:id', async (req, res) => {
    if (!requireDb(res)) return;
    try {
        const { status, approvedBy } = req.body || {};
        const gen = await updateGenerationStatus(req.params.id, status, approvedBy);
        if (!gen) return res.status(404).json({ error: 'Generation not found' });
        if (status === 'approved') {
            await notify(`✅ Approved for posting: ${gen.caption || gen.id}\nAsset: ${gen.asset_url || '(script only)'}`);
        }
        res.json(gen);
    } catch (err) {
        console.error('❌ Generation update error:', err.message);
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
        if (isEnsembleConfigured) {
            out.stages.ingest = await runIngestCycle({});
        } else {
            out.stages.ingest = { skipped: 'ENSEMBLEDATA_API_KEY not configured' };
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
        const { name, description, buyer, pains, hooks } = req.body || {};
        if (!name || !name.trim()) return res.status(400).json({ error: 'Solution name is required' });
        const sol = await createSolution({ name: name.trim(), description, buyer, pains, hooks });
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
