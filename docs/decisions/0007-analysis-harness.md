# 0007 — Analysis harness (Phase 3)

Date: 2026-07-12. Scope: everything decided while executing Phase 3 —
the analyst role, the recommendations loop, the /analyze contract, and the
Postgres-MCP re-evaluation that 0002 (note 11) deferred to this phase.
Built without credentials, per the maintainer's standing instruction.

## ☐ resolved: the pinned Postgres MCP server is gone — psql is the path

Phase 0 pinned `@modelcontextprotocol/server-postgres@0.6.2` in both MCP
profiles with a note to re-evaluate here. Re-evaluation was decisive: that
reference server was **archived (GitHub/npm/Docker Hub) in May 2025 after
Datadog Security Labs disclosed a SQL-injection read-only bypass** — its
"read-only" wrapper transaction is escapable with
`COMMIT; DROP SCHEMA public CASCADE`-style multi-statement input. A public
repo must not ship a known-vulnerable pin, so:

1. **Both profiles drop the database MCP.** `mcp-draft.json` is now
   deliberately empty — its whole job is to be the strict profile that
   guarantees _no ad-platform MCP_ is attached to sessions that read
   untrusted content (docs/plan/05 T1). `mcp-manage.json` keeps only the
   official Meta MCP. The setup ritual now includes
   `--strict-mcp-config`, without which user-scope MCP servers would leak
   into draft sessions.
2. **AI-session database access is plain `psql` over
   `ANALYST_DATABASE_URL`** — already blessed by docs/plan/02 ("a generic
   Postgres MCP or psql, identical across backends"), zero new supply
   chain, works headless everywhere. Community successor MCPs remain an
   operator's own choice, deliberately not shipped.
3. **The vulnerability class is structurally inert here anyway**, which is
   the point of this phase: the fence is the database ROLE, not any
   client's read-only mode. The integration suite and the live demo both
   run the exact escape shape (`commit; update creatives …`) as analyst —
   it dies with `permission denied`. Datadog's own recommended mitigation
   ("restrict database user permissions") is this design.

## The analyst role

4. **NOLOGIN role carrying grants; the operator brings the login.** A
   migration cannot contain a password, so migration 0005 creates the
   `analyst` role idempotently (requires the migrating role to have
   CREATEROLE — true of the reference deployment and managed defaults) and
   the operator creates their own login user granted `analyst`
   (docs/setup.md §4.5). Grants: `usage` on schema, `select` on all tables
   and views, `insert` on exactly `recommendations` + `audit_log`
   (audit_log's 0001 policies were written append-only for precisely this
   role), sequence usage for the identity column, and
   `alter default privileges` so tables from later migrations stay
   readable. **The drafts insert grant arrives with Phase 4's migration**
   — granting on a nonexistent table is impossible, and the plan's
   "insert only recommendations/drafts/audit_log" is satisfied
   incrementally.
5. **RLS now bites for real** (anticipated by 0002 decision 6): analyst
   does not own the tables, so an unset `app.org_id` yields zero rows —
   a safe failure mode, demonstrated in tests. The recommended
   `ANALYST_DATABASE_URL` carries the org context in connection options
   (`?options=-c%20app.org_id%3D<ORG_ID>`), so psql, node-postgres, or any
   future client inherits it at connect time; the prompt includes the
   `set_config` fallback.

## Recommendations as data

6. **The record is immutable except the verdict.** After insert, only
   `status` and `outcome_note` may change — enforced by trigger even
   against the privileged role, because rewriting rationale/evidence would
   falsify the history the next run scores itself against. Analyst gets no
   UPDATE grant at all: proposals are the AI's, verdicts are the
   operator's, through the audited API
   (`recommendation_status_changed`).
7. **Verdict machine:** open → accepted/rejected/expired; accepted →
   done/expired; terminal states never reopen (invalid transitions answer
   409). `expired` exists so stale advice is closed honestly rather than
   deleted — recommendations are never deleted.
8. **Evidence must recompute.** The contract (prompts/analyze.md) requires
   every evidence claim to embed the exact SQL that reproduces its value
   (CLAUDE.md hard rule); both the integration suite and the live demo
   insert a recommendation and re-run its claims to equality.

## The /analyze contract

9. `prompts/analyze.md` v1 is the versioned contract (prompts are code):
   session preconditions (strict empty profile, ANALYST_DATABASE_URL),
   the exact input queries, judgment rules ("insufficient data" is a
   first-class conclusion; every scale/pause cites the gate; budget-floor
   awareness; freshness disclosure; score last run honestly), and the two
   outputs — `reports/YYYY-MM-DD.md` plus recommendations rows and an
   `analyze_run_completed` audit trace. `.claude/commands/analyze.md`
   makes it a slash command; `pnpm analyze:open` prints the latest report.
10. **`reports/` is gitignored**: reports contain real spend data —
    operator-local by design in a public repo. The report template's
    appendix carries every SQL query used, so any number in any report is
    re-runnable later even though reports never enter the tree.

## ⚠ STOP dispositions (this session)

| STOP                      | Disposition                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (none defined by Phase 3) | Acceptance demonstrated on the demo warehouse: real report + two recommendations whose evidence SQL recomputes exactly; analyst denied `update creatives` (and the archived-MCP escape shape). The "against real Phase-2 data" nuance: live-campaign data still waits on the Meta credential (0005) — the harness is fully exercisable the moment it lands. |
