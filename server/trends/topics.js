// ═══════════════════════════════════════════════════════════════════
// Trend Engine — Step 8: listening layer (rising buyer topics)
// Tracks how often each buyer-world topic shows up across ingested
// candidates over time. A topic that is mentioned more this cycle than
// last cycle is "rising" — its wave_score boosts the composite of any
// candidate that touches it. This derives the signal from data we already
// pull, so it needs no extra API key.
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';
import { TOPIC_KEYWORDS } from './config.js';

// Count current mentions of each keyword and store a topic snapshot.
// wave_score = clamped relative growth vs the previous snapshot (0..1).
export async function runTopicCycle({ keywords = TOPIC_KEYWORDS } = {}) {
    const results = [];
    for (const kw of keywords) {
        const like = `%${kw.toLowerCase()}%`;
        let vol = 0;
        try {
            const r = await query(
                `select count(*)::int as vol
                 from candidates
                 where lower(coalesce(caption, '')) like $1
                    or exists (select 1 from unnest(hashtags) h where lower(h) like $1)`,
                [like]
            );
            vol = r.rows[0]?.vol || 0;
        } catch (err) {
            results.push({ keyword: kw, error: err.message });
            continue;
        }

        const prev = await query(
            'select mention_volume from topics where keyword = $1 order by captured_at desc limit 1',
            [kw]
        );
        const prevVol = Number(prev.rows[0]?.mention_volume) || 0;

        let wave;
        if (prevVol > 0) wave = (vol - prevVol) / prevVol;
        else wave = vol > 0 ? 1 : 0;
        const waveClamped = Math.max(0, Math.min(1, wave)); // rising-only signal

        await query(
            'insert into topics (keyword, mention_volume, wave_score) values ($1,$2,$3)',
            [kw, vol, waveClamped]
        );
        results.push({ keyword: kw, mention_volume: vol, wave_score: Number(waveClamped.toFixed(3)) });
    }
    return { topics: results };
}

// Latest snapshot per keyword, sorted by how hot it is right now.
export async function listTopics() {
    const r = await query(
        `select distinct on (keyword) keyword, mention_volume, wave_score, captured_at
         from topics order by keyword, captured_at desc`
    );
    return r.rows.sort(
        (a, b) =>
            (Number(b.wave_score) - Number(a.wave_score)) ||
            (Number(b.mention_volume) - Number(a.mention_volume))
    );
}

// Best wave score among topics matched by a candidate's caption/hashtags.
// Used by the scorer to boost time-relevant candidates.
export async function matchTopicWave(caption, hashtags) {
    const text = `${caption || ''} ${(hashtags || []).join(' ')}`.toLowerCase();
    if (!text.trim()) return 0;
    let best = 0;
    try {
        const topics = await listTopics();
        for (const t of topics) {
            if (text.includes(String(t.keyword).toLowerCase())) {
                best = Math.max(best, Number(t.wave_score) || 0);
            }
        }
    } catch {
        return 0;
    }
    return best;
}
