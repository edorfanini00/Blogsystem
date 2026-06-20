// ═══════════════════════════════════════════════════════════════════
// Trend Engine — Step 1 ingest
// For each seed hashtag, pull recent posts, upsert candidates (url is the
// natural key), and append one snapshot per candidate per cycle. Re-pulling
// the same candidates each cycle is what builds the time series. One scrape
// tells you nothing; the signal is the slope across snapshots.
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';
import { getHashtagRecentPosts } from './ensembledata.js';
import { SEED_HASHTAGS, INGEST_DAYS } from './config.js';

// Upsert a candidate by url; returns its id.
async function upsertCandidate(c) {
    const r = await query(
        `insert into candidates
            (platform, url, author_id, author_followers, caption, audio_id, hashtags, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (url) do update set
            author_followers = excluded.author_followers,
            caption = excluded.caption,
            audio_id = excluded.audio_id,
            hashtags = excluded.hashtags
         returning id`,
        [
            c.platform,
            c.url,
            c.authorId,
            c.authorFollowers,
            c.caption,
            c.audioId,
            c.hashtags || [],
            c.createdAt,
        ]
    );
    return r.rows[0].id;
}

async function insertSnapshot(candidateId, stats) {
    await query(
        `insert into snapshots
            (candidate_id, play_count, like_count, comment_count, share_count)
         values ($1,$2,$3,$4,$5)`,
        [candidateId, stats.playCount, stats.likeCount, stats.commentCount, stats.shareCount]
    );
}

// Run one ingest cycle across all seed hashtags.
// Returns a per-hashtag summary so a scheduler/endpoint can prove the
// time series is building.
export async function runIngestCycle({ hashtags = SEED_HASHTAGS, days = INGEST_DAYS } = {}) {
    const summary = {
        startedAt: new Date().toISOString(),
        days,
        hashtags: [],
        totalCandidates: 0,
        totalSnapshots: 0,
        errors: [],
    };

    for (const tag of hashtags) {
        try {
            const posts = await getHashtagRecentPosts(tag, days);
            let snapshots = 0;
            for (const post of posts) {
                const id = await upsertCandidate(post);
                await insertSnapshot(id, post.stats);
                snapshots++;
            }
            summary.hashtags.push({ tag, candidates: posts.length, snapshots });
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
