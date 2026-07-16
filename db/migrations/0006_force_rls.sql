-- 0006_force_rls: make row-level security bind the app connection too.
--
-- 0001–0005 ENABLEd RLS but never FORCEd it, and the application connects
-- as the role that owns these tables — and table owners bypass non-forced
-- policies entirely. The org policies therefore applied to nobody but the
-- analyst role, while comments (db/pool.ts) claimed belt-and-suspenders
-- isolation. FORCE makes every non-superuser connection — owner included —
-- subject to the policies; the app already sets `app.org_id`
-- transaction-locally on every statement (db/pool.ts), so it keeps working
-- unchanged. Explicit `where org_id = $1` clauses in routes remain the
-- first belt; this makes the second one real.
--
-- Two consequences, both intended:
--   * audit_log becomes genuinely append-only for the app connection —
--     no update/delete policies exist, so history cannot be rewritten.
--   * the short-code generator's cross-org uniqueness pre-check
--     (migration 0002) now sees only same-org rows; the global unique
--     constraint stays as the backstop, so a cross-org collision surfaces
--     as a 409 conflict instead of a silent retry (base36^5 ≈ 60M codes
--     makes this vanishingly rare for a solo deployment).
--
-- Caveat recorded for operators: Postgres SUPERUSER connections always
-- bypass RLS, forced or not. If DATABASE_URL connects as a superuser (a
-- default docker-compose `postgres` user, for instance) the policies
-- cannot bind — use a dedicated non-superuser role for the app when you
-- want the second belt (docs/setup.md).
--
-- Runner wraps each migration in a transaction; no BEGIN/COMMIT here.

alter table settings force row level security;
alter table audit_log force row level security;
alter table assets force row level security;
alter table copy_variants force row level security;
alter table creatives force row level security;
alter table platform_accounts force row level security;
alter table campaigns force row level security;
alter table ad_entities force row level security;
alter table metric_snapshots force row level security;
alter table ingest_deadletter force row level security;
alter table recommendations force row level security;

-- The operator records verdicts (status/outcome_note) through the app
-- connection, which 0005 assumed would bypass RLS as owner — under FORCE
-- it needs an explicit update policy. This does NOT widen the analyst
-- fence: policies filter rows, they grant nothing, and the analyst role
-- has no UPDATE privilege on this table (0005 grants select + insert
-- only), so verdicts remain the operator's.
create policy recommendations_org_update on recommendations
	for update using (org_id = app_current_org())
	with check (org_id = app_current_org());
