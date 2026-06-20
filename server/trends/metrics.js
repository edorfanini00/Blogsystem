// ═══════════════════════════════════════════════════════════════════
// Trend Engine — Step 2: derived metrics
// One scrape tells you a video is popular. The signal that matters is
// whether it is *accelerating*. These metrics read the snapshot time
// series and surface slope, not size.
//   velocity       — plays gained per hour (last two snapshots)
//   acceleration   — change in velocity (last three snapshots)
//   baselineRatio  — plays relative to the creator's follower base
//                    (a small creator going 50x their base is the signal)
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';

function num(v) {
    const n = Number(v);
    return isNaN(n) ? 0 : n;
}

function hoursBetween(a, b) {
    return (new Date(b).getTime() - new Date(a).getTime()) / 3.6e6;
}

// Compute metrics from snapshots sorted ascending by captured_at.
export function computeMetricsFromSnapshots(snapshots, candidate = {}) {
    const out = {
        snapshotCount: snapshots.length,
        playCount: null,
        velocity: null,
        acceleration: null,
        baselineRatio: null,
    };
    if (!snapshots.length) return out;

    const last = snapshots[snapshots.length - 1];
    out.playCount = num(last.play_count);

    const followers = num(candidate.author_followers);
    if (followers > 0) out.baselineRatio = out.playCount / followers;

    if (snapshots.length >= 2) {
        const a = snapshots[snapshots.length - 2];
        const b = last;
        const dh = hoursBetween(a.captured_at, b.captured_at);
        if (dh > 0) out.velocity = (num(b.play_count) - num(a.play_count)) / dh;
    }

    if (snapshots.length >= 3) {
        const a = snapshots[snapshots.length - 3];
        const b = snapshots[snapshots.length - 2];
        const c = last;
        const dh1 = hoursBetween(a.captured_at, b.captured_at);
        const dh2 = hoursBetween(b.captured_at, c.captured_at);
        if (dh1 > 0 && dh2 > 0) {
            const v1 = (num(b.play_count) - num(a.play_count)) / dh1;
            const v2 = (num(c.play_count) - num(b.play_count)) / dh2;
            const midSpan = (dh1 + dh2) / 2;
            out.acceleration = midSpan > 0 ? (v2 - v1) / midSpan : null;
        }
    }

    return out;
}

// Fetch + compute for a single candidate.
export async function getCandidateMetrics(candidateId) {
    const snaps = await query(
        `select captured_at, play_count, like_count, comment_count, share_count
         from snapshots where candidate_id = $1 order by captured_at asc`,
        [candidateId]
    );
    const cand = await query('select author_followers from candidates where id = $1', [candidateId]);
    return computeMetricsFromSnapshots(snaps.rows, cand.rows[0] || {});
}

// Squash an unbounded positive metric into 0..1 with a logarithmic soft cap.
// value at `cap` maps to ~1; small values stay small.
export function squash(value, cap) {
    if (value == null || isNaN(value) || value <= 0) return 0;
    const v = Math.min(value, cap);
    return Math.log10(1 + v) / Math.log10(1 + cap);
}
