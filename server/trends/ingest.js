// ═══════════════════════════════════════════════════════════════════
// Trend Engine — Step 1 ingest
// For each seed hashtag, pull recent posts, upsert candidates (url is the
// natural key), and append one snapshot per candidate per cycle. Re-pulling
// the same candidates each cycle is what builds the time series. One scrape
// tells you nothing; the signal is the slope across snapshots.
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';
import { getHashtagRecentPosts } from './ensembledata.js';
import { isApifyConfigured, ingestPlatform, searchPlatform } from './apify.js';
import {
    SEED_HASHTAGS,
    INGEST_DAYS,
    PLATFORMS,
    TREND_DISCOVERY,
    SEARCH_TERMS,
    SEARCH_PLATFORMS,
    TREND_MIN_VIEWS,
    TREND_BREAKOUT_RATIO,
    TREND_BREAKOUT_MIN_VIEWS,
    TREND_MIN_ENGAGEMENT,
    TREND_LANG,
} from './config.js';

// Upsert a candidate by url; returns its id.
async function upsertCandidate(c) {
    const r = await query(
        `insert into candidates
            (platform, url, author_id, author_followers, caption, audio_id, hashtags, thumbnail, media_url, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (url) do update set
            author_followers = excluded.author_followers,
            caption = excluded.caption,
            audio_id = excluded.audio_id,
            hashtags = excluded.hashtags,
            thumbnail = coalesce(excluded.thumbnail, candidates.thumbnail),
            media_url = coalesce(excluded.media_url, candidates.media_url)
         returning id`,
        [
            c.platform,
            c.url,
            c.authorId,
            c.authorFollowers,
            c.caption,
            c.audioId,
            c.hashtags || [],
            c.thumbnail || null,
            c.mediaUrl || null,
            c.createdAt,
        ]
    );
    return r.rows[0].id;
}

// Quality gate. Keep a candidate if it's a real performer:
//   • high absolute views (>= TREND_MIN_VIEWS), OR
//   • a breakout: views >= TREND_BREAKOUT_RATIO × followers, above a floor.
// Then drop bought-view bots (high views, ~0 likes). This is the core filter
// that removes 1-3k-view junk while surfacing both big hits and small-account
// breakouts. Works on the normalized post shape (stats + authorFollowers).
function qualifies(views, followers, likes) {
    if (!views) return false;
    const highViews = !TREND_MIN_VIEWS || views >= TREND_MIN_VIEWS;
    const ratio = followers > 0 ? views / followers : 0;
    const breakout = ratio >= TREND_BREAKOUT_RATIO && views >= TREND_BREAKOUT_MIN_VIEWS;
    if (!highViews && !breakout) return false;
    // Bot guard: only when likes are known and views are sizeable.
    if (TREND_MIN_ENGAGEMENT > 0 && likes != null && views >= 20000) {
        if (likes / views < TREND_MIN_ENGAGEMENT) return false;
    }
    return true;
}

function passesQuality(post) {
    return qualifies(
        Number(post?.stats?.playCount) || 0,
        Number(post?.authorFollowers) || 0,
        post?.stats?.likeCount != null ? Number(post.stats.likeCount) : null
    );
}

// Scripts that immediately mean "not US/English" content.
const NON_LATIN_SCRIPT = /[\u0400-\u04FF\u0600-\u06FF\u0590-\u05FF\u0E00-\u0E7F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF\u0900-\u097F\u0370-\u03FF]/;
// Common stopwords for Portuguese/Spanish/French/German/Italian. Two distinct
// hits is a strong signal the caption is not English.
const NON_EN_WORDS = /\b(que|n[ãa]o|voc[êe]|obrigad\w*|uma|dos|das|isso|muito|agora|fazer|pra|pela|pelo|est[áa]|s[ãa]o|gente|empresa|nuestro|nuestra|tambi[ée]n|gracias|c[óo]mo|qu[ée]|pero|esto|esta|aqu[íi]|avec|pour|vous|nous|c'est|une|und|nicht|f[üu]r|auch|sehr|della|questo|grazie|perch[ée])\b/gi;
// Heavy diacritics typical of romance languages.
const DIACRITICS = /[ãõñçáéíóúâêôàèìòùäöü]/gi;

// We can't get a creator's country from the actors, so caption language is the
// practical proxy for "US audience" content. English (Latin, no romance
// markers) passes; clearly non-English is dropped. Short/empty captions get the
// benefit of the doubt so we don't lose minimal-caption virals.
function looksEnglish(text) {
    const t = String(text || '').trim();
    if (t.length < 12) return true;
    if (NON_LATIN_SCRIPT.test(t)) return false;
    const hits = new Set((t.match(NON_EN_WORDS) || []).map((s) => s.toLowerCase())).size;
    const dia = (t.match(DIACRITICS) || []).length;
    if (hits >= 2) return false;            // two romance stopwords
    if (hits >= 1 && dia >= 2) return false; // a stopword plus accents
    if (dia >= 4) return false;              // heavily accented
    return true;
}

function passesRegion(post) {
    if (TREND_LANG !== 'en') return true;
    return looksEnglish(post?.caption);
}

// Combined gate applied to every ingested candidate.
function passesAll(post) {
    return passesQuality(post) && passesRegion(post);
}

async function insertSnapshot(candidateId, stats) {
    await query(
        `insert into snapshots
            (candidate_id, play_count, like_count, comment_count, share_count)
         values ($1,$2,$3,$4,$5)`,
        [candidateId, stats.playCount, stats.likeCount, stats.commentCount, stats.shareCount]
    );
}

// Persist a batch of normalized posts (upsert candidate + append snapshot).
async function persistPosts(posts) {
    let snapshots = 0;
    for (const post of posts) {
        const id = await upsertCandidate(post);
        await insertSnapshot(id, post.stats);
        snapshots++;
    }
    return snapshots;
}

// Run one ingest cycle. When Apify is configured, pull each enabled platform
// (TikTok / Instagram / YouTube Shorts) in one actor call per platform across
// all hashtags. Otherwise fall back to the EnsembleData per-hashtag TikTok
// pull. Returns a summary so a scheduler/endpoint can prove the time series
// is building.
export async function runIngestCycle({
    hashtags = SEED_HASHTAGS,
    days = INGEST_DAYS,
    platforms = PLATFORMS,
} = {}) {
    const summary = {
        startedAt: new Date().toISOString(),
        provider: isApifyConfigured ? 'apify' : 'ensembledata',
        days,
        hashtags: [],
        platforms: [],
        totalCandidates: 0,
        totalSnapshots: 0,
        errors: [],
    };

    if (isApifyConfigured) {
        const enabled = (platforms && platforms.length ? platforms : PLATFORMS);
        summary.discovery = TREND_DISCOVERY;

        // Pick ONE net per platform (avoids redundant actor runs that trip the
        // account memory cap). Search-capable platforms (TikTok, YouTube) use
        // the views-ranked search net; the rest (Instagram) use the hashtag net.
        //   discovery=search  → only search-capable platforms
        //   discovery=hashtag → every platform via hashtag
        //   discovery=both    → search where supported, hashtag otherwise
        const tasks = [];
        for (const p of enabled) {
            const canSearch = SEARCH_PLATFORMS.includes(p);
            if (TREND_DISCOVERY === 'hashtag') {
                tasks.push({ label: `${p}:hashtag`, run: () => ingestPlatform(p, hashtags) });
            } else if (TREND_DISCOVERY === 'search') {
                if (canSearch) tasks.push({ label: `${p}:search`, run: () => searchPlatform(p, SEARCH_TERMS) });
            } else {
                // 'both' — best net per platform
                if (canSearch) tasks.push({ label: `${p}:search`, run: () => searchPlatform(p, SEARCH_TERMS) });
                else tasks.push({ label: `${p}:hashtag`, run: () => ingestPlatform(p, hashtags) });
            }
        }

        // Run every task in parallel to fit the function time budget.
        const results = await Promise.allSettled(tasks.map((t) => t.run()));

        // Dedup across nets/platforms by url before persisting, so a video
        // found by both a hashtag and a search only gets one snapshot.
        const byUrl = new Map();
        for (let i = 0; i < tasks.length; i++) {
            const t = tasks[i];
            const r = results[i];
            if (r.status === 'fulfilled') {
                let n = 0;
                for (const post of r.value) {
                    if (post && post.url && !byUrl.has(post.url)) {
                        byUrl.set(post.url, post);
                        n++;
                    }
                }
                summary.platforms.push({ source: t.label, candidates: r.value.length, unique: n });
            } else {
                console.error(`❌ Trend ingest [${t.label}] failed:`, r.reason?.message);
                summary.platforms.push({ source: t.label, error: r.reason?.message });
                summary.errors.push({ tag: t.label, error: r.reason?.message || 'failed' });
            }
        }

        const deduped = [...byUrl.values()];
        const afterViews = deduped.filter(passesQuality);
        const unique = afterViews.filter(passesRegion);
        summary.belowViewFloor = deduped.length - afterViews.length;
        summary.nonUsDropped = afterViews.length - unique.length;
        summary.minViews = TREND_MIN_VIEWS;
        summary.lang = TREND_LANG || 'any';
        const snaps = await persistPosts(unique);
        summary.totalCandidates = unique.length;
        summary.totalSnapshots = snaps;
        console.log(`📈 Trend ingest (${TREND_DISCOVERY}): ${unique.length} kept / ${deduped.length} found (>= ${TREND_MIN_VIEWS} views, lang=${TREND_LANG || 'any'}, ${summary.nonUsDropped} non-EN dropped), ${snaps} snapshots`);

        summary.finishedAt = new Date().toISOString();
        return summary;
    }

    // ─── EnsembleData fallback (TikTok only, per-hashtag) ───────────
    for (const tag of hashtags) {
        try {
            const raw = await getHashtagRecentPosts(tag, days);
            const posts = raw.filter(passesAll);
            const snapshots = await persistPosts(posts);
            summary.hashtags.push({ tag, candidates: posts.length, found: raw.length, snapshots });
            summary.totalCandidates += posts.length;
            summary.totalSnapshots += snapshots;
            console.log(`📈 Trend ingest #${tag}: ${posts.length} candidates, ${snapshots} snapshots`);
        } catch (err) {
            console.error(`❌ Trend ingest #${tag} failed:`, err.message);
            summary.hashtags.push({ tag, error: err.message });
            summary.errors.push({ tag, error: err.message });
        }
    }

    summary.finishedAt = new Date().toISOString();
    return summary;
}

// List candidates joined with their latest snapshot, snapshot count,
// derived velocity / baseline ratio (step 2), and their latest score
// (step 4) + latest generation status (step 6). One query powers the
// whole dashboard so the cards have everything they need.
export async function listCandidates({ limit = 50 } = {}) {
    const r = await query(
        `select c.*,
                -- Industry category, derived from caption + hashtags so it works
                -- on existing rows without a re-ingest. Oil takes precedence over
                -- food; everything else is general "companies going viral".
                case
                    when (coalesce(c.caption,'') || ' ' || array_to_string(c.hashtags,' '))
                         ~* '(oil|gas|refiner|drill|oilfield|petroleum|pipeline|\\moilrig\\M|\\mrig\\M)'
                        then 'oil'
                    when (coalesce(c.caption,'') || ' ' || array_to_string(c.hashtags,' '))
                         ~* '(food|beverage|recall|fsma|cold ?chain|kitchen|restaurant|noodle|chocolate|snack|grocery|bakery|dairy|brewery|\\mfarm|\\mmeat\\M|drink|cpg|culinary)'
                        then 'food'
                    else 'companies'
                end as category,
                s.play_count, s.like_count, s.comment_count, s.share_count, s.captured_at,
                sc.snapshot_count,
                -- velocity: plays gained per hour across the last two snapshots
                case
                    when s2.captured_at is not null
                         and s.captured_at > s2.captured_at
                    then (s.play_count - s2.play_count)
                         / greatest(extract(epoch from (s.captured_at - s2.captured_at)) / 3600.0, 0.01)
                    else null
                end as velocity,
                -- baseline ratio: plays relative to the creator's follower base
                case when c.author_followers > 0
                    then round(s.play_count::numeric / c.author_followers, 2)
                    else null
                end as baseline_ratio,
                sco.bucket, sco.bridge_score, sco.bridge_line, sco.composite_score, sco.scored_at,
                gen.gen_status, gen.gen_id
         from candidates c
         left join lateral (
            select play_count, like_count, comment_count, share_count, captured_at
            from snapshots where candidate_id = c.id
            order by captured_at desc limit 1
         ) s on true
         left join lateral (
            select play_count, captured_at
            from snapshots where candidate_id = c.id
            order by captured_at desc offset 1 limit 1
         ) s2 on true
         left join lateral (
            select count(*)::int as snapshot_count
            from snapshots where candidate_id = c.id
         ) sc on true
         left join lateral (
            select bucket, bridge_score, bridge_line, composite_score, scored_at
            from scores where candidate_id = c.id
            order by scored_at desc limit 1
         ) sco on true
         left join lateral (
            select status as gen_status, id as gen_id
            from generations where candidate_id = c.id
            order by created_at desc limit 1
         ) gen on true
         order by c.first_seen_at desc
         limit $1`,
        [limit]
    );
    // Filter existing rows at read time so candidates stored before the current
    // language + quality gates drop out of the UI + reports immediately, without
    // needing a re-ingest or a destructive purge.
    return r.rows.filter((row) => {
        if (TREND_LANG === 'en' && !looksEnglish(row.caption)) return false;
        return qualifies(
            Number(row.play_count) || 0,
            Number(row.author_followers) || 0,
            row.like_count != null ? Number(row.like_count) : null
        );
    });
}

// Full snapshot time series for one candidate.
export async function getCandidateSnapshots(candidateId) {
    const r = await query(
        `select captured_at, play_count, like_count, comment_count, share_count
         from snapshots where candidate_id = $1
         order by captured_at asc`,
        [candidateId]
    );
    return r.rows;
}
