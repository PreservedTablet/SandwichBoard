-- 0004_metrics_spine: platform_accounts, campaigns, ad_entities,
-- metric_snapshots, ingest_deadletter + the combo leaderboard views
-- (docs/plan/03, 06 Phase 2; decisions in docs/decisions/0005).
-- Runner wraps each migration in a transaction; no BEGIN/COMMIT here.
-- Depends on 0001 (app_current_org, set_updated_at), 0002 (creatives,
-- forbid_org_id_change, the v_unmatched_ads stub this migration replaces).

-- ---------------------------------------------------------------------------
-- platform_accounts — one row per connected ad account. currency + timezone
-- come from the platform on every sync: money parsing and the "yesterday"
-- range boundary are defined by the account, not by the server's locale.
-- ---------------------------------------------------------------------------
create table platform_accounts (
	id uuid primary key default gen_random_uuid(),
	org_id uuid not null,
	platform text not null check (platform in ('meta', 'google', 'tiktok', 'reddit_ads')),
	external_account_id text not null, -- act_… / customer id
	label text not null,
	currency text, -- ISO code as reported by the platform ('USD')
	timezone text, -- IANA name as reported by the platform
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	-- An ad account belongs to exactly one org, globally (docs/plan/03).
	unique (platform, external_account_id)
);

create index platform_accounts_org on platform_accounts (org_id, platform);

create trigger platform_accounts_set_updated_at
	before update on platform_accounts
	for each row execute function set_updated_at();

create trigger platform_accounts_org_guard
	before update on platform_accounts
	for each row execute function forbid_org_id_change();

alter table platform_accounts enable row level security;

create policy platform_accounts_org_isolation on platform_accounts
	using (org_id = app_current_org())
	with check (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- campaigns — platform campaigns as ingested (plus, later, ones drafted
-- here). status stays free text: each platform has its own vocabulary and
-- ingestion stores it lowercased as reported.
-- ---------------------------------------------------------------------------
create table campaigns (
	id uuid primary key default gen_random_uuid(),
	org_id uuid not null,
	platform_account_id uuid not null references platform_accounts (id),
	external_id text, -- platform campaign id; null for local drafts
	name text not null,
	objective text,
	city_target text, -- denver|portland|austin|minneapolis|multi
	budget_daily_cents int,
	status text not null default 'draft',
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

-- Upsert key for ingestion; local drafts (external_id null) are exempt.
create unique index campaigns_account_external on campaigns (platform_account_id, external_id)
	where external_id is not null;

create index campaigns_org_created on campaigns (org_id, created_at desc);

create trigger campaigns_set_updated_at
	before update on campaigns
	for each row execute function set_updated_at();

create trigger campaigns_org_guard
	before update on campaigns
	for each row execute function forbid_org_id_change();

-- FKs guarantee the account exists; this guarantees it is the same org's.
create or replace function campaigns_validate_refs() returns trigger
	language plpgsql
	as $$
begin
	if not exists (
		select 1 from platform_accounts pa
		where pa.id = new.platform_account_id and pa.org_id = new.org_id
	) then
		raise exception 'campaigns.platform_account_id must reference an account in the same org';
	end if;
	return new;
end;
$$;

create trigger campaigns_refs_guard
	before insert or update of platform_account_id on campaigns
	for each row execute function campaigns_validate_refs();

alter table campaigns enable row level security;

create policy campaigns_org_isolation on campaigns
	using (org_id = app_current_org())
	with check (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- ad_entities — one row per platform ad object; the bridge between "their
-- world" and ours. Ingestion parses ad_name through packages/core and either
-- links creative_id or records precisely why not (docs/decisions/0005):
-- the parser's machine-readable codes, plus ingest's own 'code-not-found'
-- when a well-formed name carries a short code no creative row has.
-- ---------------------------------------------------------------------------
create table ad_entities (
	id uuid primary key default gen_random_uuid(),
	org_id uuid not null,
	platform_account_id uuid not null references platform_accounts (id),
	campaign_id uuid references campaigns (id),
	creative_id uuid references creatives (id), -- null ⇒ unmatched (alert!)
	platform text not null check (platform in ('meta', 'google', 'tiktok', 'reddit_ads')),
	external_ad_id text not null,
	external_adset_id text,
	ad_name text not null, -- raw, for convention parsing
	match_failure_code text, -- AdNameParseFailureCode | 'code-not-found'
	match_failure_reason text,
	first_seen date not null default current_date,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	unique (platform, external_ad_id),
	-- Unmatched rows always say why; matched rows carry no stale reason.
	check ((creative_id is null) = (match_failure_code is not null)),
	check (match_failure_code is not null or match_failure_reason is null)
);

create index ad_entities_org on ad_entities (org_id, first_seen desc);
create index ad_entities_account on ad_entities (platform_account_id);
create index ad_entities_creative on ad_entities (creative_id);
create index ad_entities_unmatched on ad_entities (org_id) where creative_id is null;

create trigger ad_entities_set_updated_at
	before update on ad_entities
	for each row execute function set_updated_at();

create trigger ad_entities_org_guard
	before update on ad_entities
	for each row execute function forbid_org_id_change();

-- Cross-table sense checks (FKs guarantee existence, not coherence):
-- the account is this org's and this platform's; the campaign belongs to
-- the same account; the creative belongs to the same org.
create or replace function ad_entities_validate_refs() returns trigger
	language plpgsql
	as $$
begin
	if not exists (
		select 1 from platform_accounts pa
		where pa.id = new.platform_account_id
			and pa.org_id = new.org_id
			and pa.platform = new.platform
	) then
		raise exception 'ad_entities.platform_account_id must reference a same-org account of platform %', new.platform;
	end if;
	if new.campaign_id is not null and not exists (
		select 1 from campaigns c
		where c.id = new.campaign_id
			and c.org_id = new.org_id
			and c.platform_account_id = new.platform_account_id
	) then
		raise exception 'ad_entities.campaign_id must reference a campaign of the same platform account';
	end if;
	if new.creative_id is not null and not exists (
		select 1 from creatives cr
		where cr.id = new.creative_id and cr.org_id = new.org_id
	) then
		raise exception 'ad_entities.creative_id must reference a creative in the same org';
	end if;
	return new;
end;
$$;

create trigger ad_entities_refs_guard
	before insert or update of platform_account_id, campaign_id, creative_id, platform on ad_entities
	for each row execute function ad_entities_validate_refs();

alter table ad_entities enable row level security;

create policy ad_entities_org_isolation on ad_entities
	using (org_id = app_current_org())
	with check (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- metric_snapshots — one row per ad per day. The PK is the idempotent upsert
-- key: any sync cadence (daily, weekly, erratic) converges on the same rows.
-- raw keeps the full platform row forever so re-parsing is always possible
-- (docs/plan/05 T6). Days without delivery have no row — that is normal.
-- ---------------------------------------------------------------------------
create table metric_snapshots (
	org_id uuid not null,
	ad_entity_id uuid not null references ad_entities (id),
	date date not null,
	spend_cents int not null default 0,
	impressions int not null default 0,
	clicks int not null default 0,
	conversions numeric not null default 0, -- platform-attributed
	conversion_value_cents int,
	video_thruplays int,
	raw jsonb, -- full platform row, always kept
	ingested_at timestamptz not null default now(),
	primary key (ad_entity_id, date)
);

create index metric_snapshots_org_date on metric_snapshots (org_id, date desc);

-- org_id is denormalized for RLS; keep it truthful.
create or replace function metric_snapshots_validate_refs() returns trigger
	language plpgsql
	as $$
begin
	if not exists (
		select 1 from ad_entities e
		where e.id = new.ad_entity_id and e.org_id = new.org_id
	) then
		raise exception 'metric_snapshots.org_id must match its ad_entity''s org';
	end if;
	return new;
end;
$$;

create trigger metric_snapshots_refs_guard
	before insert or update of ad_entity_id, org_id on metric_snapshots
	for each row execute function metric_snapshots_validate_refs();

alter table metric_snapshots enable row level security;

create policy metric_snapshots_org_isolation on metric_snapshots
	using (org_id = app_current_org())
	with check (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- ingest_deadletter — rows the sync could not use, kept whole (no silent
-- catches, per CLAUDE.md): the payload is the original platform data plus
-- phase context, the error says exactly what went wrong.
-- ---------------------------------------------------------------------------
create table ingest_deadletter (
	id uuid primary key default gen_random_uuid(),
	org_id uuid not null,
	platform text not null,
	payload jsonb not null,
	error text not null,
	created_at timestamptz not null default now(),
	resolved boolean not null default false
);

create index ingest_deadletter_org_open on ingest_deadletter (org_id, created_at desc)
	where not resolved;

alter table ingest_deadletter enable row level security;

create policy ingest_deadletter_org_isolation on ingest_deadletter
	using (org_id = app_current_org())
	with check (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- v_unmatched_ads — replaces the deliberately empty Phase 1 stub (migration
-- 0002) now that its subject exists. Same leading columns as the stub, plus
-- the failure diagnostics the dashboard badge/detail need. Never edit an
-- applied migration: the stub is dropped and the view recreated here.
-- ---------------------------------------------------------------------------
drop view v_unmatched_ads;

create view v_unmatched_ads
	with (security_invoker = true)
	as
select
	e.org_id,
	e.id as ad_entity_id,
	e.platform,
	e.external_ad_id,
	e.ad_name,
	e.first_seen,
	e.match_failure_code,
	e.match_failure_reason,
	pa.label as account_label,
	c.name as campaign_name
from ad_entities e
join platform_accounts pa on pa.id = e.platform_account_id
left join campaigns c on c.id = e.campaign_id
where e.creative_id is null;

comment on view v_unmatched_ads is
	'Ads whose names failed naming-convention matching (creative_id is null), with the machine-readable reason. Surfaces on the dashboard.';

-- ---------------------------------------------------------------------------
-- v_combo_daily — metrics joined through ad_entities→creatives: one row per
-- combo × platform × day (multiple ads running the same combo sum together;
-- per-ad detail stays in metric_snapshots).
-- ---------------------------------------------------------------------------
create view v_combo_daily
	with (security_invoker = true)
	as
select
	e.org_id,
	e.creative_id,
	c.short_code,
	e.platform,
	s.date,
	sum(s.spend_cents)::bigint as spend_cents,
	sum(s.impressions)::bigint as impressions,
	sum(s.clicks)::bigint as clicks,
	sum(s.conversions) as conversions,
	sum(s.conversion_value_cents)::bigint as conversion_value_cents,
	sum(s.video_thruplays)::bigint as video_thruplays
from metric_snapshots s
join ad_entities e on e.id = s.ad_entity_id
join creatives c on c.id = e.creative_id
group by e.org_id, e.creative_id, c.short_code, e.platform, s.date;

comment on view v_combo_daily is
	'Per-combo per-platform daily metrics (ungated raw material for sparklines and analysis).';

-- ---------------------------------------------------------------------------
-- v_combo_leaderboard — evidence-gated combo aggregates, one row per
-- (combo, platform) plus a platform='all' rollup (GROUPING SETS). The gate
-- thresholds are settings rows per org — evidence_gate_min_spend_cents /
-- evidence_gate_min_impressions (packages/core metrics.ts) — with the
-- product-brief defaults (2500¢, 1000 impressions) as fallback when unset.
-- A $6 fluke never outranks a $150 workhorse (docs/plan/01).
-- ---------------------------------------------------------------------------
create view v_combo_leaderboard
	with (security_invoker = true)
	as
with rolled as (
	select
		e.org_id,
		e.creative_id,
		coalesce(e.platform, 'all') as platform,
		count(distinct e.id) as ad_count,
		count(distinct s.date) as days_with_delivery,
		min(s.date) as first_date,
		max(s.date) as last_date,
		sum(s.spend_cents)::bigint as spend_cents,
		sum(s.impressions)::bigint as impressions,
		sum(s.clicks)::bigint as clicks,
		sum(s.conversions) as conversions,
		sum(s.conversion_value_cents)::bigint as conversion_value_cents
	from metric_snapshots s
	join ad_entities e on e.id = s.ad_entity_id
	where e.creative_id is not null
	group by grouping sets (
		(e.org_id, e.creative_id, e.platform),
		(e.org_id, e.creative_id)
	)
)
select
	r.org_id,
	r.creative_id,
	c.short_code,
	c.status as creative_status,
	c.angle,
	r.platform,
	r.ad_count,
	r.days_with_delivery,
	r.first_date,
	r.last_date,
	r.spend_cents,
	r.impressions,
	r.clicks,
	r.conversions,
	r.conversion_value_cents,
	round(r.clicks::numeric / nullif(r.impressions, 0), 6) as ctr,
	round(r.spend_cents::numeric / nullif(r.clicks, 0), 2) as cpc_cents,
	round(r.spend_cents::numeric * 1000 / nullif(r.impressions, 0), 2) as cpm_cents,
	round(r.spend_cents::numeric / nullif(r.conversions, 0), 2) as cpa_cents
from rolled r
join creatives c on c.id = r.creative_id
where r.spend_cents >= coalesce(
		(
			select (v.value #>> '{}')::bigint from settings v
			where v.org_id = r.org_id and v.key = 'evidence_gate_min_spend_cents'
		), 2500)
	and r.impressions >= coalesce(
		(
			select (v.value #>> '{}')::bigint from settings v
			where v.org_id = r.org_id and v.key = 'evidence_gate_min_impressions'
		), 1000);

comment on view v_combo_leaderboard is
	'Evidence-gated combo aggregates per platform plus an ''all'' rollup; gate thresholds read from settings per org (defaults 2500 cents / 1000 impressions).';
