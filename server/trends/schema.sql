-- ═══════════════════════════════════════════════════════════════════
-- CeleriTech Trend Engine — Step 1 schema (Supabase / Postgres)
-- Data model per build spec section 3.
-- Idempotent: safe to run repeatedly.
-- ═══════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto"; -- for gen_random_uuid()

-- ─── candidates ─────────────────────────────────────────────────
-- One row per discovered post. url is the natural key for upsert so
-- re-pulling the same post each cycle does not create duplicates.
create table if not exists candidates (
    id                uuid primary key default gen_random_uuid(),
    platform          text not null,              -- tiktok, instagram, youtube
    url               text not null unique,
    author_id         text,
    author_followers  integer,
    caption           text,
    audio_id          text,                       -- platform sound id, for clustering
    hashtags          text[] default '{}',
    created_at        timestamptz,                -- when the post was published
    first_seen_at     timestamptz not null default now()
);

create index if not exists idx_candidates_author on candidates (author_id);
create index if not exists idx_candidates_audio on candidates (audio_id);
create index if not exists idx_candidates_created on candidates (created_at);

-- ─── snapshots ──────────────────────────────────────────────────
-- The time series. One row per candidate per ingest cycle. The signal
-- lives in the slope across snapshots, not a single scrape.
create table if not exists snapshots (
    id            uuid primary key default gen_random_uuid(),
    candidate_id  uuid not null references candidates (id) on delete cascade,
    captured_at   timestamptz not null default now(),
    play_count    bigint,
    like_count    bigint,
    comment_count bigint,
    share_count   bigint
);

create index if not exists idx_snapshots_candidate on snapshots (candidate_id, captured_at desc);

-- ─── clusters ───────────────────────────────────────────────────
-- A trend is a cluster, not a single video. centroid stored as jsonb in
-- step 1 to avoid a hard pgvector dependency; migrate to the vector type
-- in step 3 (clustering) if embedding search is needed.
create table if not exists clusters (
    id                 uuid primary key default gen_random_uuid(),
    label              text,                      -- short human label for the format/trend
    centroid           jsonb,                     -- caption embedding centroid, optional
    audio_id           text,                      -- exact-match anchor when sound-driven
    member_count       integer default 0,
    aggregate_velocity numeric default 0
);

create table if not exists candidate_clusters (
    candidate_id uuid not null references candidates (id) on delete cascade,
    cluster_id   uuid not null references clusters (id) on delete cascade,
    primary key (candidate_id, cluster_id)
);

-- ─── topics (listening layer) ───────────────────────────────────
create table if not exists topics (
    id             uuid primary key default gen_random_uuid(),
    keyword        text not null,
    captured_at    timestamptz not null default now(),
    mention_volume bigint,
    sentiment      numeric,                       -- -1 to 1
    wave_score     numeric                        -- normalized acceleration of mentions
);

create index if not exists idx_topics_keyword on topics (keyword, captured_at desc);

-- ─── scores (the merge) ─────────────────────────────────────────
create table if not exists scores (
    id              uuid primary key default gen_random_uuid(),
    candidate_id    uuid not null references candidates (id) on delete cascade,
    bucket          text,                         -- trendjack, clone_format, discard
    bridge_score    numeric,                      -- 0 to 10 from the LLM
    bridge_line     text,                         -- one-line CeleriTech angle
    topic_id        uuid references topics (id) on delete set null,
    composite_score numeric,                      -- final ranking score
    scored_at       timestamptz not null default now()
);

create index if not exists idx_scores_candidate on scores (candidate_id, scored_at desc);
create index if not exists idx_scores_composite on scores (composite_score desc);

-- ─── generations (the Recreate action) ──────────────────────────
create table if not exists generations (
    id           uuid primary key default gen_random_uuid(),
    candidate_id uuid not null references candidates (id) on delete cascade,
    script       text,
    status       text default 'drafted',          -- drafted, rendering, review, approved, posted, killed
    asset_url    text,
    approved_by  text,
    posted_at    timestamptz,
    created_at   timestamptz not null default now()
);

create index if not exists idx_generations_candidate on generations (candidate_id);
create index if not exists idx_generations_status on generations (status);
