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
} from './config.js';

// Upsert a candidate by url; returns its id.
async function upsertCandidate(c) {
    const r = await query(
        `insert into candidates
            (platform, url, author_id, author_followers, caption, audio_id, hashtags, thumbnail, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (url) do update set
            author_followers = excluded.author_followers,
            caption = excluded.caption,
            audio_id = excluded.audio_id,
            hashtags = excluded.hashtags,
            thumbnail = coalesce(excluded.thumbnail, candidates.thumbnail)
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
            c.createdAt,
        ]
    );
    return r.rows[0].id;
}

// Quality floor: drop low-view junk before it ever hits the pool. A view
// count is the cleanest spam signal — it filters dropship/bot posts while
// still letting a genuine viral from a tiny account through.
function passesQuality(post) {
    if (!TREND_MIN_VIEWS) return true;
    const views = Number(post?.stats?.playCount) || 0;
    return views >= TREND_MIN_VIEWS;
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
        const unique = deduped.filter(passesQuality);
        summary.belowViewFloor = deduped.length - unique.length;
        summary.minViews = TREND_MIN_VIEWS;
        const snaps = await persistPosts(unique);
        summary.totalCandidates = unique.length;
        summary.totalSnapshots = snaps;
        console.log(`📈 Trend ingest (${TREND_DISCOVERY}): ${unique.length} kept / ${deduped.length} found (>= ${TREND_MIN_VIEWS} views), ${snaps} snapshots`);

        summary.finishedAt = new Date().toISOString();
        return summary;
    }

    // ─── EnsembleData fallback (TikTok only, per-hashtag) ───────────
    for (const tag of hashtags) {
        try {
            const raw = await getHashtagRecentPosts(tag, days);
            const posts = raw.filter(passesQuality);
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
    return r.rows;
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
