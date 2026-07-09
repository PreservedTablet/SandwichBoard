-- 0001_foundation: extensions, settings, audit_log (docs/plan/03, 06 Phase 0)
-- Runner wraps each migration in a transaction; no BEGIN/COMMIT here.

-- gen_random_uuid() is built into PG13+; pgcrypto keeps older tooling happy
-- and is harmless where redundant.
create extension if not exists pgcrypto;

-- Vanilla-Postgres tenancy hook: RLS policies compare org_id to a per-session
-- setting (`set app.org_id = '…'`) instead of any provider-specific JWT
-- helper, so the same policies work on a home-server container, Supabase,
-- Neon, or RDS. apps/api sets app.org_id when it opens a connection.
create or replace function app_current_org() returns uuid
	language sql stable
	as $$ select nullif(current_setting('app.org_id', true), '')::uuid $$;

create or replace function set_updated_at() returns trigger
	language plpgsql
	as $$
begin
	new.updated_at := now();
	return new;
end;
$$;

-- Per-org key/value settings: naming-convention prefix, evidence-gate
-- thresholds, and other tunable constants live here as data, never as
-- hardcoded values (docs/plan/03).
create table settings (
	org_id uuid not null,
	key text not null,
	value jsonb not null,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	primary key (org_id, key)
);

create trigger settings_set_updated_at
	before update on settings
	for each row execute function set_updated_at();

alter table settings enable row level security;

create policy settings_org_isolation on settings
	using (org_id = app_current_org())
	with check (org_id = app_current_org());

-- Every write that touches money or public posting lands here (docs/plan/01).
create table audit_log (
	id bigint generated always as identity primary key,
	org_id uuid not null,
	actor text not null, -- 'operator' | 'ingest-job' | 'claude-analyze' | ...
	action text not null, -- 'publish' | 'approve' | 'budget_change_proposed' | ...
	subject_table text,
	subject_id text,
	payload jsonb,
	at timestamptz not null default now()
);

create index audit_log_org_at on audit_log (org_id, at desc);

alter table audit_log enable row level security;

-- Append-only for RLS-subject roles: select + insert policies exist,
-- update/delete policies deliberately do not.
create policy audit_log_org_select on audit_log
	for select using (org_id = app_current_org());

create policy audit_log_org_insert on audit_log
	for insert with check (org_id = app_current_org());
