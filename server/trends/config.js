// ═══════════════════════════════════════════════════════════════════
// CeleriTech Trend Engine — config
// Guardrail: weights, thresholds, seeds, and the message bank live here
// so they tune without code changes. Step 1 uses seeds + ingest; the
// scorer/composite values are defined now so later steps read one source.
// ═══════════════════════════════════════════════════════════════════

// ─── Velocity layer seeds ───────────────────────────────────────
// Seed with the buyer's adjacent world, not consumer hashtags, so
// candidates are bridgeable before any scoring runs.
export const SEED_HASHTAGS = [
    'manufacturing',
    'supplychain',
    'foodmanufacturing',
    'plantmanager',
    'operations',
    'inventorymanagement',
    'erphumor',
    'corporatehumor',
    'smallbusinessowner',
    'oilandgas',
    'logistics',
];

// Watchlist of B2B and ops creator accounts (expand later).
export const WATCHLIST_ACCOUNTS = [];

// How many days back to bound the hashtag recent-posts pull.
export const INGEST_DAYS = 7;

// Platforms the engine ingests from (step 1 implements tiktok).
export const PLATFORMS = ['tiktok'];

// ─── Listening layer keywords (added in step 8) ─────────────────
export const TOPIC_KEYWORDS = [
    'FSMA 204',
    'food traceability',
    'recall',
    'cold chain',
    'supply chain disruption',
    'food and beverage demand',
    'inventory shrink',
    'plant downtime',
    'oil and gas operations',
    'cross-border logistics',
];

// ─── Composite score weights (section 6.3) ──────────────────────
// Starting points. Tune from real data.
export const SCORE_WEIGHTS = {
    bridge: 0.5,
    baselineRatio: 0.25,
    acceleration: 0.15,
    topicWave: 0.1,
};

// Surface candidates at or above this composite score.
export const SURFACE_THRESHOLD = 0.6;

// Clustering thresholds (used in step 3).
export const CLUSTER = {
    captionSimilarityThreshold: 0.82,
};

// ─── CeleriTech message bank (section 6.1) ──────────────────────
// The scorer checks every candidate against this. The generator wraps
// every script around it. Expand over time.
export const MESSAGE_BANK = {
    product:
        'EZ solutions. Software that gives food and beverage manufacturers and oil and gas operators visibility they do not get from spreadsheets.',
    buyer:
        'food and beverage manufacturers, oil and gas operators, cross-border US to Venezuela operations.',
    corePains: [
        'demand surges they cannot see coming',
        'inventory and reconciliation done by hand',
        'no real-time visibility on the plant floor',
        'FSMA 204 traceability pressure',
        'finding out about a problem when they run out',
    ],
    hooks: [
        'FSMA 204 compliance',
        'demand surge visibility',
        'the plant running blind on spreadsheets',
    ],
    voice: 'Hugo the Hippo delivers lines. Dry, plain, mechanism first.',
};

// ─── Editorial rules (enforced on all generated copy) ───────────
export const EDITORIAL_RULES = [
    'no em dashes',
    'no exclamation points',
    'no AI-sounding phrasing',
    'mechanism first, concise and human',
    'the product is always called "EZ solutions" in buyer-facing text',
    'never "ERP", never "SAP partner"',
];
