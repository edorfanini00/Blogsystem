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

-- Thumbnail / cover image so the dashboard can show the actual video frame
-- instead of just a platform glyph. Idempotent add for existing deployments.
alter table candidates add column if not exists thumbnail text;

-- Deep video analysis (frames + on-screen text + audio transcript + sound),
-- produced on demand by a multimodal model. media_url is a playable/downloadable
-- video URL captured at ingest so we can feed the actual video to the analyzer.
alter table candidates add column if not exists media_url   text;
alter table candidates add column if not exists analysis    jsonb;
alter table candidates add column if not exists analyzed_at timestamptz;

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

-- Generation pipeline columns (step 6). Idempotent adds so existing
-- deployments migrate forward without dropping data.
alter table generations add column if not exists script_json    jsonb;
alter table generations add column if not exists video_prompt    text;
alter table generations add column if not exists caption         text;
alter table generations add column if not exists model           text;
alter table generations add column if not exists fal_request_id  text;
alter table generations add column if not exists status_url      text;
alter table generations add column if not exists response_url    text;
alter table generations add column if not exists error           text;

-- ─── solutions (the "brain" / knowledge base) ───────────────────
-- Each solution is a sellable offering with its own context. Replaces the
-- single hardcoded message bank: the scorer and the generator read the
-- selected solution's profile + attached files when producing video.
create table if not exists solutions (
    id          uuid primary key default gen_random_uuid(),
    name        text not null,
    description text,
    -- optional overrides; fall back to the global message bank when null
    buyer       text,
    pains       text,
    hooks       text,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

-- ─── solution_files ─────────────────────────────────────────────
-- Knowledge files attached to a solution. We store extracted text so the
-- generator can feed it to the LLM as context. blob_url optionally points
-- at the original file when Vercel Blob is configured.
create table if not exists solution_files (
    id             uuid primary key default gen_random_uuid(),
    solution_id    uuid not null references solutions (id) on delete cascade,
    filename       text not null,
    mime_type      text,
    size_bytes     bigint,
    extracted_text text,
    blob_url       text,
    created_at     timestamptz not null default now()
);

create index if not exists idx_solution_files_solution on solution_files (solution_id);

-- Link a generation to the solution it was created for.
alter table generations add column if not exists solution_id uuid references solutions (id) on delete set null;

-- ─── Product knowledge base fields (Video Generation spec §2) ────
-- The image-first remake chain needs a richer, self-contained product entry
-- than the original scorer message bank. Each field maps to the spec contract.
-- Idempotent adds so existing solutions migrate forward.
alter table solutions add column if not exists one_liner       text;       -- plain "what it is and does"
alter table solutions add column if not exists proof_points    text[] default '{}'; -- concrete outcomes/numbers
alter table solutions add column if not exists visual_cues     text[] default '{}'; -- what it looks like on screen
alter table solutions add column if not exists message_bank    text[] default '{}'; -- approved angles/phrasings
alter table solutions add column if not exists editorial       jsonb;      -- { banned_terms[], required_framing, notes }

-- ─── Remake / Director fields on generations (Video Generation spec) ─
-- The image-first chain replaces the old text-to-video shortcut. We persist
-- the remake config + the Director's shot plan so the rest of the chain
-- (image → qc → motion → video → assembly) reads from one row.
alter table generations add column if not exists target_mode     text;    -- product | custom | auto
alter table generations add column if not exists custom_prompt   text;    -- set when target_mode = custom
alter table generations add column if not exists resolved_target text;    -- product name | custom | auto-selected
alter table generations add column if not exists director_json   jsonb;   -- full shot plan { format, shots[] }
alter table generations add column if not exists shots           jsonb;   -- per-shot pipeline state (image/video urls, qc)
alter table generations add column if not exists copy_json       jsonb;   -- Copy agent: { voiceover, captions{platform}, hashtags[] }
alter table generations add column if not exists vo_url          text;    -- ElevenLabs voiceover asset (public URL)

-- ─── Output type: video remake vs photo slideshow/carousel ──────
-- The same image-first chain powers two outputs. 'video' animates stills into
-- clips; 'slideshow' burns on-screen text onto the stills and packages a photo
-- carousel (+ a rendered preview reel). Idempotent adds.
alter table generations add column if not exists output_type     text default 'video'; -- video | slideshow
alter table generations add column if not exists slide_urls      jsonb;   -- composed slides [{url, text, text_position}]
alter table generations add column if not exists posted_url      text;    -- public URL once posted (feedback loop)
-- When true, the chain auto-publishes this generation to Instagram once it is
-- fully rendered (set by an Autopilot run that has auto-publish enabled).
alter table generations add column if not exists auto_publish    boolean default false;

-- Trending sound: the source's own audio, extracted at analyze/keyframe time,
-- reused as the bed for the remake (video or slideshow reel).
alter table candidates add column if not exists source_audio_url text;

-- ─── strategy_notes (run-over-run memory) ───────────────────────
-- Compounding strategy log: short reflections fed back into the Director/Copy so
-- the engine learns what to make next instead of starting cold each time.
create table if not exists strategy_notes (
    id          uuid primary key default gen_random_uuid(),
    scope       text,                       -- 'global' or an industry/format tag
    output_type text,                       -- video | slideshow | null (any)
    note        text not null,
    created_at  timestamptz not null default now()
);
create index if not exists idx_strategy_notes_created on strategy_notes (created_at desc);

-- ─── generation_performance (closed feedback loop) ──────────────
-- Real metrics for what we posted, scraped from the public post URL over time.
-- Top performers feed the research brain so the next remake leans on proof.
create table if not exists generation_performance (
    id             uuid primary key default gen_random_uuid(),
    generation_id  uuid references generations (id) on delete cascade,
    candidate_id   uuid references candidates (id) on delete set null,
    public_url     text,
    platform       text,
    views          bigint,
    likes          bigint,
    comments       bigint,
    shares         bigint,
    saves          bigint,
    engagement_pct numeric,
    captured_at    timestamptz not null default now()
);
create index if not exists idx_genperf_generation on generation_performance (generation_id, captured_at desc);
create index if not exists idx_genperf_captured on generation_performance (captured_at desc);

-- ─── app_settings (generic key/value for runtime toggles) ───────
-- Lets the UI flip features (e.g. Autopilot on/off + settings) without a redeploy.
create table if not exists app_settings (
    key        text primary key,
    value      jsonb,
    updated_at timestamptz not null default now()
);

-- ─── autopilot_runs (autonomous daily generation log) ───────────
-- Each Autopilot run records what it picked, WHY, and the generations it kicked
-- off, so the new videos are fully auditable in the UI.
create table if not exists autopilot_runs (
    id          uuid primary key default gen_random_uuid(),
    status      text not null default 'running',  -- running | done | error
    trigger     text,                              -- cron | manual
    picked      jsonb,                             -- [{candidate_id,title,reason,score,generation_id,output_type}]
    notes       text,
    error       text,
    started_at  timestamptz not null default now(),
    finished_at timestamptz
);
-- Which agent produced this run: 'default' (product/brand) or 'ownpage'
-- (retargets viral concepts to our own Instagram content). Idempotent add so
-- existing deployments migrate forward.
alter table autopilot_runs add column if not exists agent text not null default 'default';
create index if not exists idx_autopilot_runs_started on autopilot_runs (started_at desc);
create index if not exists idx_autopilot_runs_agent on autopilot_runs (agent, started_at desc);

-- ─── trend_reports (weekly intelligence) ────────────────────────
-- One row per weekly analysis run. The factual parts (signals, trending,
-- rising/forecast) are computed deterministically from the data above; the
-- analyst LLM only writes the narrative summary + content recommendations,
-- and is constrained to cite the computed numbers. Storing each run builds
-- the history that makes week-over-week prediction increasingly accurate.
create table if not exists trend_reports (
    id              uuid primary key default gen_random_uuid(),
    period_start    timestamptz not null,
    period_end      timestamptz not null,
    generated_at    timestamptz not null default now(),
    model           text,
    confidence      text,                 -- overall data-confidence: building | low | medium | high
    signals         jsonb,                -- raw computed metrics (audit trail)
    trending        jsonb,                -- what is hot now (deterministic)
    rising          jsonb,                -- momentum + forecast (deterministic)
    summary         text,                 -- analyst narrative (LLM)
    recommendations jsonb,                -- content ideas to make (LLM, evidence-cited)
    status          text default 'complete'
);

create index if not exists idx_trend_reports_generated on trend_reports (generated_at desc);
