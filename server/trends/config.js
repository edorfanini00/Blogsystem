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
// TREND_PLATFORMS env var (comma-separated, e.g. "tiktok,instagram,youtube").
//
// All three on by default. YouTube uses a fast HTTP-only actor (no browser)
// so three actors fit inside the free-plan concurrent-memory cap.
const SUPPORTED = ['tiktok', 'instagram', 'youtube'];
const DEFAULT_PLATFORMS = ['tiktok', 'instagram', 'youtube'];
export const PLATFORMS = (process.env.TREND_PLATFORMS
    ? process.env.TREND_PLATFORMS.split(',')
    : DEFAULT_PLATFORMS
)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => SUPPORTED.includes(p));

// ─── Apify provider config ──────────────────────────────────────
// Actor IDs (use "~" form for the API path). Swap here to switch actors
// without touching provider code.
export const APIFY_ACTORS = {
    tiktok: 'scrapecore~tiktok-cheerio-hashtag-scraper',
    instagram: 'khadinakbar~instagram-hashtag-scraper',
    youtube: 'lentic_clockss~youtube-shorts-scraper',
};

// Top N posts to pull per hashtag per platform. Lower = cheaper (Apify bills
// per result). 30 is plenty for trend detection; bump for wider coverage.
export const APIFY_RESULTS_PER_HASHTAG = Number(process.env.APIFY_RESULTS_PER_HASHTAG) || 30;

// TikTok sort: createTime keeps the time series anchored on fresh posts so
// velocity/acceleration are meaningful. Options: relevance, playCount,
// diggCount, shareCount, createTime.
export const APIFY_TIKTOK_SORT = process.env.APIFY_TIKTOK_SORT || 'createTime';

// Memory (MB) per actor run. Must be a power of 2. Lower lets more actors run
// concurrently within the account cap (free plan = 8192MB total): 2048 lets ~3
// run at once. Raise on paid plans for faster runs.
export const APIFY_MEMORY_MB = Number(process.env.APIFY_MEMORY_MB) || 2048;

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

// ─── Performance-based discovery (search net) ───────────────────
// Instead of only pulling tagged posts, search topic phrases and rank by
// actual views, so videos that go viral WITHOUT your hashtags still surface.
// Discovery mode: 'both' (default), 'search' (views-only), or 'hashtag'.
export const TREND_DISCOVERY = (process.env.TREND_DISCOVERY || 'both').toLowerCase();

// Search phrases to hunt by, balanced across the three industry categories so
// each one (Companies / Food / Oil) actually gets populated. Override with
// TREND_SEARCH_TERMS (comma-separated) for a dedicated hunt list.
const DEFAULT_SEARCH_TERMS = [
    // General "companies going viral"
    'factory tour',
    'how its made',
    'manufacturing process',
    'warehouse operations',
    'company behind the scenes',
    // Food industry
    'food factory',
    'food manufacturing',
    'food recall',
    'cold chain logistics',
    // Oil & gas industry
    'oil and gas',
    'oil refinery',
    'oil rig life',
];
export const SEARCH_TERMS = (process.env.TREND_SEARCH_TERMS
    ? process.env.TREND_SEARCH_TERMS.split(',')
    : DEFAULT_SEARCH_TERMS
)
    .map((s) => s.trim())
    .filter(Boolean);

// Platforms that support keyword search (Instagram has no public keyword
// search, so it only participates in the hashtag net).
export const SEARCH_PLATFORMS = ['tiktok', 'youtube'];

// Search-net actors. TikTok uses a search API that can sort by mostViews;
// YouTube uses a fast HTTP-only Shorts scraper that searches by keyword and
// can sort by popularity (views).
export const APIFY_SEARCH_ACTORS = {
    tiktok: 'sentry~tiktok-search-api',
    youtube: 'lentic_clockss~youtube-shorts-scraper',
};

// mostViews = rank by actual performance, not tag relevance. Options:
// relevance, mostRecent, mostViews.
export const APIFY_SEARCH_SORT = process.env.APIFY_SEARCH_SORT || 'mostViews';
// Recency window: allTime, today, thisWeek, thisMonth, 3months, 6months.
// thisMonth gives the views-sort enough volume to find real performers in a
// niche where a single week is often too thin.
export const APIFY_SEARCH_DATE = process.env.APIFY_SEARCH_DATE || 'thisMonth';
// Results per search term per platform.
export const APIFY_SEARCH_RESULTS = Number(process.env.APIFY_SEARCH_RESULTS) || 30;
// Drop anything below this view count (0 = keep all). Raise to focus on virals.
export const APIFY_SEARCH_MIN_VIEWS = Number(process.env.APIFY_SEARCH_MIN_VIEWS) || 0;

// ─── Quality gate (applied to EVERY net, not just search) ───────
// We keep a candidate only if it is a real performer. Two ways to qualify:
//   1. High absolute views (TREND_MIN_VIEWS) — proven reach, and
//   2. Breakout: views >= TREND_BREAKOUT_RATIO × the creator's followers
//      (a small account going viral) as long as it clears a sane floor
//      (TREND_BREAKOUT_MIN_VIEWS) so micro-noise doesn't sneak in.
// This is what kills the 1-3k-view junk while still surfacing both
// "very high views" and "high views from a small account".
export const TREND_MIN_VIEWS = process.env.TREND_MIN_VIEWS != null
    ? Number(process.env.TREND_MIN_VIEWS)
    : 10000;
// Breakout = views / followers. 15x means the algorithm pushed it well beyond
// the creator's own audience — the cleanest "this is actually trending" signal.
export const TREND_BREAKOUT_RATIO = process.env.TREND_BREAKOUT_RATIO != null
    ? Number(process.env.TREND_BREAKOUT_RATIO)
    : 15;
// A breakout still needs a sane absolute floor so a 500-view/10-follower post
// doesn't qualify on ratio alone.
export const TREND_BREAKOUT_MIN_VIEWS = process.env.TREND_BREAKOUT_MIN_VIEWS != null
    ? Number(process.env.TREND_BREAKOUT_MIN_VIEWS)
    : 3000;
// Bot guard: bought-view accounts have near-zero engagement. When likes are
// known and views are high, drop anything below this like:view ratio. Set 0
// to disable. Only applied above 20k views so we don't punish early videos.
export const TREND_MIN_ENGAGEMENT = process.env.TREND_MIN_ENGAGEMENT != null
    ? Number(process.env.TREND_MIN_ENGAGEMENT)
    : 0.0005;

// Region / language targeting. TikTok's search actor already defaults to US
// results, but the Instagram and YouTube actors have no country option and
// return global content (hence Brazilian/Spanish posts leaking in). Since the
// actors don't expose creator country, we use caption LANGUAGE as a practical
// proxy for "US audience" content: keep English, drop clearly non-English.
// TREND_LANG='en' (default) enables the filter; set '' or 'any' to disable.
export const TREND_LANG = process.env.TREND_LANG != null
    ? process.env.TREND_LANG.trim().toLowerCase()
    : 'en';

// ─── Higgsfield image/video model router (Video Generation spec §5) ─
// The Director sets model_choice per shot; we map it to a Higgsfield
// application slug (CLI job_set_type). Override any via env if Higgsfield
// renames a slug. Defaults: Nano Banana Pro (precision/text/dashboards),
// Seedream (multi-shot subject continuity), Grok (fast scroll-stoppers).
// Higgsfield's platform API uses hierarchical path slugs (e.g.
// 'flux-pro/kontext/max/text-to-image'), not the CLI short IDs. The valid set
// is account/version-specific and not publicly listed, so these are env-
// overridable. flux-pro/kontext/max is confirmed working and is a strong
// all-rounder: excellent text rendering (dashboards/on-screen copy) and native
// image-reference support (for use_source_frame). The Director still routes
// per shot; map each lane to a specialized slug here once confirmed.
const HF_DEFAULT_IMAGE_SLUG = process.env.HF_MODEL_DEFAULT || 'flux-pro/kontext/max/text-to-image';
export const HF_IMAGE_MODELS = {
    nano_banana_pro: process.env.HF_MODEL_NANO_BANANA || HF_DEFAULT_IMAGE_SLUG,
    seedream: process.env.HF_MODEL_SEEDREAM || HF_DEFAULT_IMAGE_SLUG,
    grok: process.env.HF_MODEL_GROK || HF_DEFAULT_IMAGE_SLUG,
};
// Vertical short-form by default.
export const HF_IMAGE_ASPECT = process.env.HF_IMAGE_ASPECT || '9:16';
// Param name the image model expects for a reference frame (use_source_frame).
// Empty disables passing a reference (safe default until confirmed per model).
export const HF_IMAGE_REF_PARAM = process.env.HF_IMAGE_REF_PARAM || '';
// Image-to-video endpoint (confirmed: v1/image2video/dop). Kling slugs were not
// resolvable on this account; DoP is the stable image-to-video path.
export const HF_VIDEO_MODELS = {
    default: process.env.HF_MODEL_VIDEO || 'v1/image2video/dop',
    simple: process.env.HF_MODEL_VIDEO_SIMPLE || 'v1/image2video/dop',
};
// Per-shot image generation retry cap (spec §7: cap regenerations at 3).
export const REMAKE_MAX_REGENS = Number(process.env.REMAKE_MAX_REGENS) || 3;

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
