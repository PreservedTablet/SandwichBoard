-- 0005_analysis_harness: recommendations table + the analyst role
-- (docs/plan/03, 06 Phase 3; decisions in docs/decisions/0007).
-- Runner wraps each migration in a transaction; no BEGIN/COMMIT here.
-- Depends on 0001 (app_current_org, set_updated_at, audit_log policies),
-- 0002 (creatives, forbid_org_id_change).

-- ---------------------------------------------------------------------------
-- recommendations — /analyze writes tables, not chat (docs/plan/02 decision
-- 4), so history accumulates and next week's run can score last week's
-- advice. One row per recommendation; run_id groups one /analyze invocation.
-- ---------------------------------------------------------------------------
create table recommendations (
	id uuid primary key default gen_random_uuid(),
	org_id uuid not null,
	run_id uuid not null,
	kind text not null check (kind in ('scale', 'pause', 'new_variant', 'budget_shift', 'investigate')),
	subject_creative_id uuid references creatives (id),
	rationale text not null,
	evidence jsonb not null, -- the metric aggregates cited, with their SQL
	status text not null default 'open'
		check (status in ('open', 'accepted', 'rejected', 'done', 'expired')),
	outcome_note text,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create index recommendations_org_status on recommendations (org_id, status, created_at desc);
create index recommendations_org_run on recommendations (org_id, run_id);

create trigger recommendations_set_updated_at
	before update on recommendations
	for each row execute function set_updated_at();

create trigger recommendations_org_guard
	before update on recommendations
	for each row execute function forbid_org_id_change();

-- A recommendation is the AI's recorded claim: after insert, only the
-- operator's verdict (status) and outcome_note may change — rewriting
-- rationale or evidence would falsify the history the next run learns from.
create or replace function recommendations_immutable_columns() returns trigger
	language plpgsql
	as $$
begin
	if new.run_id is distinct from old.run_id
		or new.kind is distinct from old.kind
		or new.subject_creative_id is distinct from old.subject_creative_id
		or new.rationale is distinct from old.rationale
		or new.evidence is distinct from old.evidence
		or new.created_at is distinct from old.created_at then
		raise exception 'recommendations are immutable except status and outcome_note — the record is what the next run learns from';
	end if;
	return new;
end;
$$;

create trigger recommendations_immutable_guard
	before update on recommendations
	for each row execute function recommendations_immutable_columns();

-- FKs guarantee existence; this guarantees the subject is the same org's.
create or replace function recommendations_validate_refs() returns trigger
	language plpgsql
	as $$
begin
	if new.subject_creative_id is not null and not exists (
		select 1 from creatives c
		where c.id = new.subject_creative_id and c.org_id = new.org_id
	) then
		raise exception 'recommendations.subject_creative_id must reference a creative in the same org';
	end if;
	return new;
end;
$$;

create trigger recommendations_refs_guard
	before insert on recommendations
	for each row execute function recommendations_validate_refs();

alter table recommendations enable row level security;

-- select + insert policies exist; update/delete policies deliberately do
-- not: RLS-subject roles (analyst) propose and read — verdicts are the
-- operator's, through the app role, which owns the table.
create policy recommendations_org_select on recommendations
	for select using (org_id = app_current_org());

create policy recommendations_org_insert on recommendations
	for insert with check (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- analyst — the DB-enforced fence for AI sessions (docs/plan/05 T1: even a
-- fully hijacked analysis session can only read, and write proposals).
--
-- NOLOGIN on purpose: no password can live in a migration. The operator
-- creates their own login user and grants it this role (docs/setup.md);
-- ANALYST_DATABASE_URL connects as that user. Requires the migration to run
-- as a role with CREATEROLE (true for the reference superuser deployment
-- and managed providers' default admin roles).
-- ---------------------------------------------------------------------------
do $$
begin
	if not exists (select 1 from pg_roles where rolname = 'analyst') then
		create role analyst nologin;
	end if;
end;
$$;

grant usage on schema public to analyst;

-- Read everything (tables and views — the leaderboard views are the
-- analysis inputs), write nothing…
grant select on all tables in schema public to analyst;

-- …except proposals and the audit trail. Phase 4's migration adds the
-- drafts grant when that table exists. Sequence usage covers audit_log's
-- identity column.
grant insert on recommendations, audit_log to analyst;
grant usage on all sequences in schema public to analyst;

-- Tables created by later migrations (run by this same admin role) are
-- readable automatically; new insert grants stay explicit and deliberate.
alter default privileges in schema public grant select on tables to analyst;
alter default privileges in schema public grant usage on sequences to analyst;

comment on role analyst is
	'SandwichBoard AI-session role: select-all, insert only into recommendations/drafts/audit_log. RLS applies — set app.org_id per session (docs/setup.md).';
