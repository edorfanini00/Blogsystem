// ═══════════════════════════════════════════════════════════════════
// CeleriTech Trend Engine — config
// Guardrail: weights, thresholds, seeds, and the message bank live here
// so they tune without code changes. Step 1 uses seeds + ingest; the
// scorer/composite values are defined now so later steps read one source.
// ═══════════════════════════════════════════════════════════════════

// ─── Velocity layer seeds ───────────────────────────────────────
// Seed with the buyer's adjacent world, not consumer hashtags, so
// candidates are bridgeable before any scoring runs.
// Trimmed to the 4 most on-brand tags to conserve EnsembleData quota (each
// tag = 1 API request per ingest cycle). Re-add the commented tags below once
// on a paid plan with more headroom.
export const SEED_HASHTAGS = [
    'manufacturing',
    'supplychain',
    'foodmanufacturing',
    'oilandgas',
    // 'plantmanager',
    // 'operations',
    // 'inventorymanagement',
    // 'erphumor',
    // 'corporatehumor',
    // 'smallbusinessowner',
    // 'logistics',
];

// Watchlist of B2B and ops creator accounts (expand later).
export const WATCHLIST_ACCOUNTS = [];

// How many days back to bound the hashtag recent-posts pull (EnsembleData
// fallback only; the Apify actors are bounded by results-per-hashtag instead).
export const INGEST_DAYS = 7;

// Platforms the engine ingests from. With Apify configured, each platform is
// pulled from its own actor in one call per cycle. Override via the
// TREND_PLATFORMS env var (comma-separated, e.g. "tiktok,instagram").
const SUPPORTED = ['tiktok', 'instagram', 'youtube'];
export const PLATFORMS = (process.env.TREND_PLATFORMS
    ? process.env.TREND_PLATFORMS.split(',')
    : SUPPORTED
)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => SUPPORTED.includes(p));

// ─── Apify provider config ──────────────────────────────────────
// Actor IDs (use "~" form for the API path). Swap here to switch actors
// without touching provider code.
export const APIFY_ACTORS = {
    tiktok: 'scrapecore~tiktok-cheerio-hashtag-scraper',
    instagram: 'khadinakbar~instagram-hashtag-scraper',
    youtube: 'khadinakbar~youtube-shorts-scraper',
};

// Top N posts to pull per hashtag per platform. Lower = cheaper (Apify bills
// per result). 30 is plenty for trend detection; bump for wider coverage.
export const APIFY_RESULTS_PER_HASHTAG = Number(process.env.APIFY_RESULTS_PER_HASHTAG) || 30;

// TikTok sort: createTime keeps the time series anchored on fresh posts so
// velocity/acceleration are meaningful. Options: relevance, playCount,
// diggCount, shareCount, createTime.
export const APIFY_TIKTOK_SORT = process.env.APIFY_TIKTOK_SORT || 'createTime';

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
