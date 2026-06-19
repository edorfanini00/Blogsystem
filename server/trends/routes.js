// ═══════════════════════════════════════════════════════════════════
// Trend Engine — Express routes (step 1)
// Mounted under /api/trends. Every route degrades gracefully when the
// database or EnsembleData key is not configured, so the rest of the app
// is never affected.
// ═══════════════════════════════════════════════════════════════════
import express from 'express';
import multer from 'multer';
import { isDbConfigured, migrate, pingDb } from './db.js';
import { isEnsembleConfigured } from './ensembledata.js';
import { runIngestCycle, listCandidates, getCandidateSnapshots } from './ingest.js';
import {
    createSolution, listSolutions, getSolution, updateSolution, deleteSolution,
    addFile, deleteFile, extractText,
} from './solutions.js';
import {
    SEED_HASHTAGS,
    SURFACE_THRESHOLD,
    SCORE_WEIGHTS,
    MESSAGE_BANK,
    TOPIC_KEYWORDS,
} from './config.js';

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
        db: { configured: isDbConfigured, ok: false },
        ensembleData: { configured: isEnsembleConfigured },
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
