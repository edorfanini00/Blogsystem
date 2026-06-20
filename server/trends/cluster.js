// ═══════════════════════════════════════════════════════════════════
// Trend Engine — Step 3: clustering
// A trend is a cluster, not a single video. Two cheap, high-signal cues
// group candidates without an embedding service:
//   1. exact shared audio_id  — the strongest "same trend" signal on TikTok
//   2. caption token overlap   — Jaccard similarity over content words
// Rebuilds clusters from the most recent candidates each run (small scale,
// so a full rebuild is simpler and correct than incremental upserts).
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';
import { CLUSTER } from './config.js';

const STOP = new Set(
    ('the a an and or of to in for on with is are be this that your you it as at by from but not ' +
        'we they i me my our us so if then than too very can will just how what why when who all any')
        .split(' ')
);

function tokenize(text) {
    return new Set(
        String(text || '')
            .toLowerCase()
            .replace(/[^a-z0-9# ]/g, ' ')
            .split(/\s+/)
            .filter((w) => w.length > 2 && !STOP.has(w))
    );
}

function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / (a.size + b.size - inter);
}

function labelFor(group) {
    // Most frequent content tokens across the group's members.
    const freq = new Map();
    for (const toks of group.memberTokens) {
        for (const t of toks) {
            if (t.startsWith('#')) continue;
            freq.set(t, (freq.get(t) || 0) + 1);
        }
    }
    const top = [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([t]) => t);
    return top.length ? top.join(' · ') : 'untitled trend';
}

export async function runClustering({ limit = 300 } = {}) {
    const { rows: cands } = await query(
        `select id, caption, audio_id, hashtags from candidates order by first_seen_at desc limit $1`,
        [limit]
    );

    const groups = [];
    for (const c of cands) {
        const toks = tokenize(`${c.caption || ''} ${(c.hashtags || []).join(' ')}`);
        let placed = false;
        for (const g of groups) {
            const sameAudio = c.audio_id && g.audioId && c.audio_id === g.audioId;
            const sim = jaccard(toks, g.tokenSet);
            if (sameAudio || sim >= CLUSTER.captionSimilarityThreshold) {
                g.members.push(c.id);
                g.memberTokens.push(toks);
                for (const t of toks) g.tokenSet.add(t);
                if (!g.audioId && c.audio_id) g.audioId = c.audio_id;
                placed = true;
                break;
            }
        }
        if (!placed) {
            groups.push({
                audioId: c.audio_id || null,
                tokenSet: new Set(toks),
                members: [c.id],
                memberTokens: [toks],
            });
        }
    }

    // Full rebuild: nothing else references clusters by id, so a wipe is safe.
    await query('delete from candidate_clusters');
    await query('delete from clusters');

    let trendCount = 0;
    for (const g of groups) {
        const r = await query(
            `insert into clusters (label, audio_id, member_count) values ($1,$2,$3) returning id`,
            [labelFor(g), g.audioId, g.members.length]
        );
        const clusterId = r.rows[0].id;
        if (g.members.length >= 2) trendCount++;
        for (const candidateId of g.members) {
            await query(
                `insert into candidate_clusters (candidate_id, cluster_id) values ($1,$2)
                 on conflict do nothing`,
                [candidateId, clusterId]
            );
        }
    }

    return {
        candidates: cands.length,
        clusters: groups.length,
        trends: trendCount, // clusters with 2+ members
    };
}

// List clusters that represent real trends (2+ members), hottest first.
export async function listClusters({ minMembers = 2, limit = 50 } = {}) {
    const r = await query(
        `select id, label, audio_id, member_count
         from clusters where member_count >= $1
         order by member_count desc limit $2`,
        [minMembers, limit]
    );
    return r.rows;
}
