-- 0002_creative_library: assets, copy_variants, creatives (docs/plan/03, 06 Phase 1)
-- Runner wraps each migration in a transaction; no BEGIN/COMMIT here.
-- Depends on 0001: pgcrypto (gen_random_bytes), app_current_org(), set_updated_at().

-- Rows never migrate between orgs; a moved row would strand its references.
create or replace function forbid_org_id_change() returns trigger
	language plpgsql
	as $$
begin
	if new.org_id is distinct from old.org_id then
		raise exception '%.org_id is immutable', tg_table_name;
	end if;
	return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- assets — every image / video / overlay template, stored via the storage
-- adapter (storage_path) or referenced externally (external_url).
-- ---------------------------------------------------------------------------
create table assets (
	id uuid primary key default gen_random_uuid(),
	org_id uuid not null,
	kind text not null check (kind in ('image', 'video', 'overlay_template')),
	title text not null,
	storage_path text, -- storage-adapter key, nullable if external
	storage_content_type text, -- served back on tokenized reads
	external_url text, -- e.g. large Scalemo output that stays where it lives
	width int,
	height int,
	duration_s numeric,
	tags text[] not null default '{}', -- e.g. {porch,drill,neighbors,denver}
	source text, -- 'photo-shoot-jun26' | 'scalemo' | 'canva'
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create index assets_org_created on assets (org_id, created_at desc);
create index assets_tags on assets using gin (tags);

create trigger assets_set_updated_at
	before update on assets
	for each row execute function set_updated_at();

create trigger assets_org_guard
	before update on assets
	for each row execute function forbid_org_id_change();

alter table assets enable row level security;

create policy assets_org_isolation on assets
	using (org_id = app_current_org())
	with check (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- copy_variants — every headline / primary text / tagline / description / CTA.
-- ---------------------------------------------------------------------------
create table copy_variants (
	id uuid primary key default gen_random_uuid(),
	org_id uuid not null,
	kind text not null check (kind in ('headline', 'primary_text', 'tagline', 'description', 'cta')),
	body text not null,
	angle text, -- 'save-money' | 'meet-neighbors' | 'declutter' | ...
	tone text, -- 'practical' | 'warm' | 'funny'
	char_count int generated always as (char_length(body)) stored,
	tags text[] not null default '{}',
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create index copy_variants_org_kind on copy_variants (org_id, kind, created_at desc);
create index copy_variants_tags on copy_variants using gin (tags);

create trigger copy_variants_set_updated_at
	before update on copy_variants
	for each row execute function set_updated_at();

create trigger copy_variants_org_guard
	before update on copy_variants
	for each row execute function forbid_org_id_change();

alter table copy_variants enable row level security;

create policy copy_variants_org_isolation on copy_variants
	using (org_id = app_current_org())
	with check (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- short_code generator — lowercase base36, collision-retried. The code is an
-- opaque join key embedded in ad names (docs/plan/03 "load-bearing wall"),
-- not a secret: the slight modulo bias of byte % 36 is acceptable.
-- ---------------------------------------------------------------------------
create or replace function gen_short_code(code_len int default 5) returns text
	language plpgsql volatile
	as $$
declare
	alphabet constant text := '0123456789abcdefghijklmnopqrstuvwxyz';
	bytes bytea;
	code text := '';
	i int;
begin
	if code_len < 1 then
		raise exception 'gen_short_code: code_len must be >= 1, got %', code_len;
	end if;
	bytes := gen_random_bytes(code_len);
	for i in 0 .. code_len - 1 loop
		code := code || substr(alphabet, (get_byte(bytes, i) % 36) + 1, 1);
	end loop;
	return code;
end;
$$;

-- ---------------------------------------------------------------------------
-- creatives — a tested asset × copy combination. short_code joins platform
-- metric rows back to this row via the naming convention; it is immutable.
-- ---------------------------------------------------------------------------
create table creatives (
	id uuid primary key default gen_random_uuid(),
	org_id uuid not null,
	short_code text not null unique check (short_code ~ '^[0-9a-z]{5}$'),
	asset_id uuid references assets (id),
	headline_id uuid references copy_variants (id),
	primary_text_id uuid references copy_variants (id),
	cta_id uuid references copy_variants (id),
	angle text,
	status text not null default 'draft' check (status in ('draft', 'live', 'retired')),
	notes text,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	-- an empty combo is meaningless; copy-only (RSA) and asset-only are fine
	check (
		asset_id is not null
		or headline_id is not null
		or primary_text_id is not null
		or cta_id is not null
	)
);

create index creatives_org_created on creatives (org_id, created_at desc);
-- reverse lookups: "which combos use this asset / this copy line?"
create index creatives_asset on creatives (asset_id);
create index creatives_headline on creatives (headline_id);
create index creatives_primary_text on creatives (primary_text_id);
create index creatives_cta on creatives (cta_id);

create trigger creatives_set_updated_at
	before update on creatives
	for each row execute function set_updated_at();

-- Assign a short_code on insert when the caller did not supply one.
-- Existence check + retry loop handles same-session collisions; the unique
-- constraint remains the backstop for concurrent inserts (the API surfaces
-- unique-violation as a retriable conflict). 36^5 ≈ 60.4M codes.
create or replace function creatives_assign_short_code() returns trigger
	language plpgsql
	as $$
declare
	candidate text;
	attempt int;
begin
	if new.short_code is not null then
		return new;
	end if;
	for attempt in 1 .. 20 loop
		candidate := gen_short_code(5);
		if not exists (select 1 from creatives where short_code = candidate) then
			new.short_code := candidate;
			return new;
		end if;
	end loop;
	raise exception 'creatives_assign_short_code: no unique candidate after 20 attempts';
end;
$$;

create trigger creatives_short_code_assign
	before insert on creatives
	for each row execute function creatives_assign_short_code();

-- A creative IS its combination. short_code is printed into live ad names on
-- external platforms, and swapping components under an existing code would
-- silently re-attribute every metric row that joins through it — so both are
-- immutable. A mis-built draft is deleted and rebuilt; codes are free.
create or replace function creatives_immutable_columns() returns trigger
	language plpgsql
	as $$
begin
	if new.short_code is distinct from old.short_code then
		raise exception 'creatives.short_code is immutable — it is the join key embedded in platform ad names';
	end if;
	if new.org_id is distinct from old.org_id then
		raise exception 'creatives.org_id is immutable';
	end if;
	if new.asset_id is distinct from old.asset_id
		or new.headline_id is distinct from old.headline_id
		or new.primary_text_id is distinct from old.primary_text_id
		or new.cta_id is distinct from old.cta_id then
		raise exception 'creative components are immutable — delete the draft and build a new combo';
	end if;
	return new;
end;
$$;

create trigger creatives_immutable_guard
	before update on creatives
	for each row execute function creatives_immutable_columns();

-- Draft combos are unpublished bookkeeping and may be removed; anything that
-- may have run as an ad is history — retire it instead.
create or replace function creatives_draft_only_delete() returns trigger
	language plpgsql
	as $$
begin
	if old.status <> 'draft' then
		raise exception 'only draft creatives may be deleted — retire % instead', old.short_code;
	end if;
	return old;
end;
$$;

create trigger creatives_delete_guard
	before delete on creatives
	for each row execute function creatives_draft_only_delete();

-- Component references must stay inside the creative's org and point at copy
-- of the right kind. FKs guarantee existence; this guarantees sense.
-- Fires on insert only: updates cannot change these columns at all.
create or replace function creatives_validate_components() returns trigger
	language plpgsql
	as $$
begin
	if new.asset_id is not null
		and not exists (select 1 from assets a where a.id = new.asset_id and a.org_id = new.org_id) then
		raise exception 'creatives.asset_id must reference an asset in the same org';
	end if;
	if new.headline_id is not null
		and not exists (
			select 1 from copy_variants c
			where c.id = new.headline_id and c.org_id = new.org_id and c.kind = 'headline'
		) then
		raise exception 'creatives.headline_id must reference a headline copy_variant in the same org';
	end if;
	if new.primary_text_id is not null
		and not exists (
			select 1 from copy_variants c
			where c.id = new.primary_text_id and c.org_id = new.org_id and c.kind = 'primary_text'
		) then
		raise exception 'creatives.primary_text_id must reference a primary_text copy_variant in the same org';
	end if;
	if new.cta_id is not null
		and not exists (
			select 1 from copy_variants c
			where c.id = new.cta_id and c.org_id = new.org_id and c.kind = 'cta'
		) then
		raise exception 'creatives.cta_id must reference a cta copy_variant in the same org';
	end if;
	return new;
end;
$$;

create trigger creatives_components_guard
	before insert on creatives
	for each row execute function creatives_validate_components();

alter table creatives enable row level security;

create policy creatives_org_isolation on creatives
	using (org_id = app_current_org())
	with check (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- v_unmatched_ads — the dashboard's contract for convention violations
-- (docs/plan/03: ad_entities rows whose ad_name failed to parse to a
-- creative). ad_entities arrives in Phase 2; until then this is a typed,
-- deliberately empty stub so the dashboard and acceptance checks bind to a
-- stable name. Phase 2 drops and recreates it against the real table.
-- ---------------------------------------------------------------------------
create view v_unmatched_ads
	with (security_invoker = true)
	as
select
	null::uuid as org_id,
	null::uuid as ad_entity_id,
	null::text as platform,
	null::text as external_ad_id,
	null::text as ad_name,
	null::date as first_seen
where false;

comment on view v_unmatched_ads is
	'Ads whose names failed naming-convention parsing (creative_id is null). Empty stub until Phase 2 creates ad_entities.';
