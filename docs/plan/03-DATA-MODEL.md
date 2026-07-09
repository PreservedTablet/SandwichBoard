# 03 — Data Model

Draft DDL — the agent turns this into numbered Supabase migrations in Phase 1/2. Conventions: `uuid` PKs (`gen_random_uuid()`), `created_at/updated_at timestamptz` on every table (triggers), `org_id uuid not null` on every table with RLS `org_id = auth.jwt() ->> 'org_id'` even though v1 has one org — retrofitting tenancy is misery, carrying it is free.

## Creative library

```sql
create table assets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  kind text not null check (kind in ('image','video','overlay_template')),
  title text not null,
  storage_path text,          -- supabase storage, nullable if external
  external_url text,          -- e.g. large Scalemo output
  width int, height int, duration_s numeric,
  tags text[] not null default '{}',   -- e.g. {porch,drill,neighbors,denver}
  source text,                -- 'photo-shoot-jun26' | 'scalemo' | 'canva'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table copy_variants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  kind text not null check (kind in ('headline','primary_text','tagline','description','cta')),
  body text not null,
  angle text,                 -- 'save-money' | 'meet-neighbors' | 'declutter' | ...
  tone text,                  -- 'practical' | 'warm' | 'funny'
  char_count int generated always as (char_length(body)) stored,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A "creative" is a tested combination. short_code is the join key to platforms.
create table creatives (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  short_code text not null unique,      -- e.g. 'a3xk7' — base36, 5 chars, immutable
  asset_id uuid references assets(id),
  headline_id uuid references copy_variants(id),
  primary_text_id uuid references copy_variants(id),
  cta_id uuid references copy_variants(id),
  angle text,
  status text not null default 'draft' check (status in ('draft','live','retired')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

## Campaigns and platform mapping

```sql
create table platform_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  platform text not null check (platform in ('meta','google','tiktok','reddit_ads')),
  external_account_id text not null,    -- act_… / customer id
  label text not null,
  unique (platform, external_account_id)
);

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  platform_account_id uuid not null references platform_accounts(id),
  external_id text,                     -- platform campaign id
  name text not null,                   -- must follow naming convention
  objective text,
  city_target text,                     -- denver|portland|austin|minneapolis|multi
  budget_daily_cents int,
  status text not null default 'draft'
);

-- one row per platform ad object; the bridge between "their world" and ours
create table ad_entities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  campaign_id uuid references campaigns(id),
  creative_id uuid references creatives(id),   -- null ⇒ unmatched (alert!)
  platform text not null,
  external_ad_id text not null,
  external_adset_id text,
  ad_name text not null,                        -- raw, for convention parsing
  first_seen date not null default current_date,
  unique (platform, external_ad_id)
);

create index ad_entities_unmatched on ad_entities (org_id) where creative_id is null;
```

## Metrics spine

```sql
create table metric_snapshots (
  org_id uuid not null,
  ad_entity_id uuid not null references ad_entities(id),
  date date not null,
  spend_cents int not null default 0,
  impressions int not null default 0,
  clicks int not null default 0,
  conversions numeric not null default 0,       -- platform-attributed
  conversion_value_cents int,
  video_thruplays int,
  raw jsonb,                                    -- full platform row, always kept
  ingested_at timestamptz not null default now(),
  primary key (ad_entity_id, date)              -- idempotent upsert key
);

create table ingest_deadletter (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  platform text not null,
  payload jsonb not null,
  error text not null,
  created_at timestamptz not null default now(),
  resolved boolean not null default false
);
```

Derived views (SQL views, not tables): `v_combo_daily` (metrics joined through ad_entities→creatives), `v_combo_leaderboard` (aggregates with the evidence gate: `having sum(spend_cents) >= 2500 and sum(impressions) >= 1000` — constants read from a `settings` table, not hardcoded), `v_unmatched_ads` (convention violations, surfaces on dashboard).

## Analysis, scout, publishing

```sql
create table recommendations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  run_id uuid not null,                 -- one /analyze invocation
  kind text not null check (kind in ('scale','pause','new_variant','budget_shift','investigate')),
  subject_creative_id uuid references creatives(id),
  rationale text not null,
  evidence jsonb not null,              -- the metric rows/aggregates cited
  status text not null default 'open' check (status in ('open','accepted','rejected','done','expired')),
  outcome_note text,
  created_at timestamptz not null default now()
);

create table scout_items (               -- captured opportunities
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  source text not null check (source in ('manual','bookmarklet','email_alert','rss')),
  url text not null,
  community text,                       -- e.g. r/HomeImprovement
  title text,
  captured_text text,                   -- excerpt the operator pasted / alert body
  relevance text,                       -- filled by /draft triage
  status text not null default 'inbox' check (status in ('inbox','drafting','drafted','approved','posted','skipped')),
  created_at timestamptz not null default now()
);

create table drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  scout_item_id uuid references scout_items(id),   -- null ⇒ own-brand content
  kind text not null check (kind in ('reddit_reply','brand_post','ugc_style_post')),
  target_channels text[] not null default '{}',    -- postiz integration ids or 'manual'
  body text not null,
  media_asset_ids uuid[] not null default '{}',
  disclosure_ok boolean not null default false,     -- founder disclosure present (enforced for reddit_reply)
  status text not null default 'proposed' check (status in ('proposed','edited','approved','published','rejected')),
  postiz_post_id text,
  release_url text,
  approved_by text, approved_at timestamptz,
  created_at timestamptz not null default now()
);

create table audit_log (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  actor text not null,                  -- 'operator' | 'ingest-job' | 'claude-analyze' | ...
  action text not null,                 -- 'publish' | 'approve' | 'budget_change_proposed' | ...
  subject_table text, subject_id text,
  payload jsonb,
  at timestamptz not null default now()
);
```

## The naming convention (load-bearing wall)

Ad names on every platform: `{prefix}|{campaign_slug}|{short_code}|v{n}` — e.g. `fwt|denver-circle|a3xk7|v2`. The `{prefix}` is a per-org value from the `settings` table (`fwt` for FriendsWithTools; open-source adopters set their own), and the parser treats it as data, not a constant. Rules: pipe-delimited; `short_code` is the `creatives.short_code`; parser lives in `packages/core` with exhaustive tests; ingestion parses `ad_name` → sets `creative_id`; parse failure ⇒ `ad_entities.creative_id = null` ⇒ dashboard alert. Meta preserves ad names in Insights rows; Google ad names come through GAQL `ad_group_ad.ad.name` (RSAs — where names aren't set, fall back to UTM matching).

**UTM scheme** on every destination URL: `utm_source={platform}&utm_medium=paid|organic&utm_campaign={campaign_slug}&utm_content={short_code}`. This gives landing-side attribution independent of platform reporting and is the safety net when a name gets mangled. FWT's site should log `utm_content` on the invite-request event (one-line change on the FWT side — maintainer note, out of SandwichBoard scope).

## RLS posture

Enable RLS on every table; policies scoped to `org_id` (RLS is plain Postgres — it works identically on a home-server container, Supabase, or Neon). `apps/api` connects with a privileged application role server-side only (never shipped to the browser); the SvelteKit app talks to `apps/api`, not to the database directly, and file reads go through short-lived signed/tokenized URLs issued by the storage adapter. `/analyze` sessions use a **read-only Postgres role** (create `analyst` role: `select` on all, `insert` only on `recommendations`, `drafts`, `audit_log`) — enforced at the database, not by prompt.
