// ═══════════════════════════════════════════════════════════════════
// Trend Engine — Express routes (step 1)
// Mounted under /api/trends. Every route degrades gracefully when the
// database or EnsembleData key is not configured, so the rest of the app
// is never affected.
// ═══════════════════════════════════════════════════════════════════
import express from 'express';
import { isDbConfigured, migrate, pingDb } from './db.js';
import { isEnsembleConfigured } from './ensembledata.js';
import { runIngestCycle, listCandidates, getCandidateSnapshots } from './ingest.js';
import {
    SEED_HASHTAGS,
    SURFACE_THRESHOLD,
    SCORE_WEIGHTS,
    MESSAGE_BANK,
    TOPIC_KEYWORDS,
} from './config.js';

const router = express.Router();

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

export default router;
