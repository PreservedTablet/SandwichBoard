# 06 — Build Plan (Agent Execution)

Rules of engagement for the building agent: **one phase per session**; begin every session by reading `CLAUDE.md` and the current phase section in full; ⚠ STOP markers require the maintainer's confirmation before proceeding; every phase ends with acceptance criteria *demonstrated* (commands run, output shown), a conventional-commit history, and an entry in `docs/decisions/` for anything resolved from the ☐ verify register. Never mark a criterion met without showing the evidence.

## Phase 0 — Foundation (1 session)

Scaffold pnpm monorepo (`apps/web` SvelteKit 2/Svelte 5 + TS, `apps/api` Fastify 5 + TS, `packages/core` zod/types, `prompts/`, `docs/plan/` already present). Tooling: ESLint+Prettier per FWT conventions, vitest, tsconfig project refs. CI (GitHub Actions, SHA-pinned, **no `schedule:` triggers, ever**): install→lint→typecheck→test→**gitleaks**→`pnpm audit`/osv-scanner→**grep gate failing on any occurrence of `ANTHROPIC_API_KEY` in the tree**. Pre-commit: gitleaks + lint-staged. **Repo settings (via authenticated `gh`, free-tier only):** first run `gh auth status` — the session needs `repo` + `workflow` scopes (or a fine-grained PAT limited to this repo with Administration, Contents, and Workflows read/write); if scopes are missing, ⚠ STOP and ask rather than degrading. Then configure via `gh api`: branch protection on `main` (required status checks = the CI job, block force-pushes, require linear history, **no required approvals** — solo maintainer), Dependabot alerts + security updates, and secret-scanning push protection. Everything listed is free for public repositories; the agent must never enable anything metered or paid (Codespaces prebuilds, larger runners, Git LFS, GitHub Advanced Security on private repos, marketplace apps). **Infisical wiring:** ⚠ STOP (maintainer creates their own Infisical project + machine identity and links the checkout locally with `infisical init`); the agent adds `.infisical.json` to `.gitignore`, commits `.infisical.json.example` and a setup-doc step so **every clone links its own Infisical workspace** — the git tree must never contain a workspace id or any other operator-specific identifier. Agent writes the single zod-validated config module in `packages/core/src/config.ts` that reads `process.env` only, authors `config/variables.md` (the public manifest from `04`), and wraps dev/run scripts as `infisical run --env=<env> -- <cmd>` with a documented plain-`.env` fallback. Postgres: provision ⚠ STOP (maintainer picks the backend — default: a Postgres 16 container in the home-server compose stack; Supabase or Neon acceptable alternatives — and puts `DATABASE_URL` into Infisical `/api`). Migrations are **plain SQL files** run by a small node-postgres runner (`pnpm db:migrate` — works identically on any Postgres; the supabase CLI is only used if Supabase is the chosen backend). Apply migration 0001 (extensions, `settings` table, `audit_log`). Implement the storage adapter interface with the `local-fs` driver (S3-compatible and Supabase drivers are additive later). Add `.env.example` (names only, fake values), `SECURITY.md`, `LICENSE` (canonical FSL-1.1-Apache-2.0 per `07`, ⚠ STOP for the Licensor line), `CONTRIBUTING.md` (DCO + CLA per `07`), README stub stating the BYO posture and the license summary from `07`. Add `.mcp.json` profiles (`mcp-draft.json`, `mcp-manage.json`) and the repo `CLAUDE.md` (appendix below).
**Accept:** fresh clone → `pnpm i && pnpm build && pnpm test` green; `infisical run --env=dev -- pnpm dev` boots both apps with injected config; CI green including gitleaks and the ANTHROPIC_API_KEY grep gate (demonstrated: a branch containing the string fails); `pnpm db:migrate` applies cleanly against the chosen Postgres; deliberately committing a fake secret in a test branch fails CI; repo-wide grep confirms zero `schedule:`/cron triggers; branch protection, Dependabot, and push protection verified via `gh api` output; git tree contains no `.infisical.json`, no workspace ids, and no personal names (grep demonstrated).

## Phase 1 — Creative Library (1–2 sessions)

Migrations for `assets`, `copy_variants`, `creatives` (+RLS, triggers, `short_code` base36 generator with collision retry). `packages/core`: naming-convention builder/parser (`{prefix}|{campaign}|{code}|v{n}`, prefix from `settings`) + UTM builder, exhaustive unit tests including mangled-name cases. API CRUD + upload through the storage adapter (short-lived signed/tokenized URLs for reads). Web: library grid with tag filter, asset/copy detail, **combo builder** (pick asset + copy pieces → creative row → shows canonical ad name + UTM string with copy buttons). Seed script imports the existing 17 stills / video briefs / RSA copy from a CSV the maintainer exports from the current Sheets tracker ⚠ STOP (maintainer supplies CSV; agent writes the importer against its real headers).
**Accept:** create combo in UI → parser round-trips its generated name; seed import loads real library; `v_unmatched_ads` view exists (empty).

## Phase 2 — Metrics Spine (2 sessions)

Migrations: `platform_accounts`, `campaigns`, `ad_entities`, `metric_snapshots`, `ingest_deadletter`, leaderboard views with `settings`-driven evidence gate. **Session 2a — Meta (Plan A confirmed):** resolve the ☐ CLI auth-model question from Meta's official docs and record it in `docs/decisions/0002-meta-ingestion.md`; ⚠ STOP only to have the maintainer provision whatever credential the docs require — falling back to Plan B needs their explicit approval; implement the **manual range sync** — `pnpm sync` and a dashboard "Sync now" button hitting authenticated `POST /internal/ingest/meta` — which computes the per-account watermark (max snapshot date, else 90-day backfill floor), fetches per-ad insights for watermark→yesterday, upserts `ad_entities` (parse names → `creative_id`), upserts snapshots, deadletters failures, and writes an `audit_log` summary row. Dashboard gets a **staleness banner** ("last synced N days ago") since nothing runs unattended. **Session 2b — Google:** GAQL ingestion via the official read-only MCP path or direct API if token approved; regardless, ship the CSV-upload ingestion endpoint + UI as universal fallback/backfill. Dashboard: combo leaderboard (evidence-gated, per-platform toggle), spend/CTR sparklines (last 30d), unmatched-ads and deadletter badges.
**Accept:** two manual runs on different days produce idempotent snapshots for the live "Start Your Circle" campaign, and a deliberately skipped day is healed by the next run (watermark catch-up demonstrated); leaderboard renders with the gate; an intentionally malformed ad name lands in unmatched + badge; staleness banner reflects reality; DB spend total for one campaign within 5% of platform UI ⚠ STOP (maintainer eyeballs).

## Phase 3 — Analysis Harness (1 session)

Create `analyst` Postgres role (select-all; insert only `recommendations`/`drafts`/`audit_log`) and wire it into `mcp-draft.json`/analysis config. `prompts/analyze.md` v1: inputs (leaderboard views, last run's recommendations + outcomes), required output shape (markdown report to `reports/YYYY-MM-DD.md` + `recommendations` rows with `evidence` jsonb citing concrete aggregates), tone rules ("insufficient data" is a first-class conclusion; every `scale`/`pause` must cite the gate being met). `/analyze` slash command (Claude Code custom command) + `pnpm analyze:open` to review. Dashboard: recommendations list with accept/reject/done (+`outcome_note`), which feeds the next run.
**Accept:** run against real Phase-2 data → report exists, ≥1 recommendation whose `evidence` matches SQL re-computation, zero writes possible outside the three allowed tables (demonstrated: analyst role denied an `update creatives` attempt).

## Phase 4 — Scout & Drafts (1–2 sessions)

Migrations: `scout_items`, `drafts` (+ API state machines; `disclosure_ok` enforced server-side for `reddit_reply` approval). Capture: bookmarklet (HMAC), iOS-shareable endpoint (works via Shortcuts "Get Contents of URL"), inbound-alert paste form; keyword-alert setup doc for F5Bot-or-equivalent ☐. `prompts/voice-reddit.md` (disclosure line mandatory, no link unless thread asks, match sub's register) and `prompts/voice-brand.md` for own-channel/UGC-style posts — both versioned, both cite real examples the maintainer supplies ⚠ STOP (voice guide review is the maintainer's; this is the soul of the thing). `/draft` command: triage relevance → draft into `drafts` (status `proposed`). Approval UI: side-by-side item/draft, edit-in-place, approve (records approver+time), "copy & open thread" action for manual Reddit posting.
**Accept:** captured real thread → drafted → approved with disclosure enforced (approval blocked when `disclosure_ok=false`); full state history in `audit_log`; a `/draft` session demonstrably has no ad-platform MCP available.

## Phase 5 — Publish Rail (1 session + platform-approval calendar time)

Postiz self-host: compose file with pinned image tag on the home server behind Cloudflare Tunnel + Access; channels connect in order of platform-approval friction (Reddit manual path → FB Page → IG → TikTok), so this phase's UI ships even if only one channel is live. `apps/api` Postiz client: list integrations, upload media, create post as **draft/schedule** (never `now`), poll state/`releaseURL` back onto `drafts` + `audit_log`. Approval UI gains channel picker (from live `GET /integrations`) and scheduled-time field. Own-brand/UGC-style pipeline: `/draft` can also propose brand posts from library assets (no scout item), same approval gate.
**Accept:** approved draft appears in Postiz calendar as scheduled; after publish, `release_url` populated; audit trail complete end-to-end; Postiz API key demonstrated absent from web bundle and Claude sessions.

## Appendix — operator-owned scheduling (optional, never shipped enabled)

SandwichBoard ships no scheduler. Operators who want cadence wrap the same commands themselves — example systemd timer for a weekly Monday sync on a home server, documented in `docs/operations.md` and nothing more: a `sandwichboard-sync.service` running `infisical run --env=prod -- pnpm sync` plus a `sandwichboard-sync.timer` with `OnCalendar=Mon 07:00`. AI runs (`/analyze`, `/draft`) stay human-invoked by design — they consume the operator's Claude subscription and should be spent deliberately.

## Deferred backlog (post-v1, priority order)

Google write-path via reviewed third-party MCP or manual-only forever; Pipeboard for TikTok/Snap/Reddit paid when spend justifies; engagement-metrics pull from Postiz analytics into the warehouse; Scalemo brief generator button; recommendation-outcome scoring (did accepted recs beat rejected?); multi-user auth for open-source adopters; landing-side conversion join via FWT `utm_content` logging.

## Agent guardrails (binding, restated from ad-ops best practice)

Campaign/ad writes create objects **PAUSED** where supported; **never auto-retry** a failed write — report and stop; anything that changes spend requires explicit fresh confirmation in-session even if "pre-approved" in a recommendation; respect platform budget floors (≈$5/day Meta ad set, ≈$10/day Google, ≈$20/day TikTok campaign) when proposing; never invent metrics — every number in a report must be reproducible by a SQL query included in the report appendix; GitHub configuration touches only features that are free for public repositories — anything metered or paid requires an explicit ⚠ STOP.

---

## Appendix — draft `CLAUDE.md` for the repo

```markdown
# SandwichBoard — agent rules

## Project
Marketing ops for FriendsWithTools: creative library, metrics warehouse, analysis, human-approved publishing. Read docs/plan/ before nontrivial work. Stack: pnpm monorepo, SvelteKit 2/Svelte 5, Fastify 5, Supabase, vitest.

## Hard rules
- NEVER attach an ad-platform MCP and scout/untrusted content in the same session. Draft/analyze sessions use mcp-draft.json only.
- NEVER publish (`type:"now"`), change budgets, or create campaigns without explicit human confirmation in this session. Writes create PAUSED objects. Failed writes are reported, never retried.
- NEVER introduce an Anthropic API key or any Anthropic API call — all AI work happens in the operator's own Claude Code session on their subscription. CI enforces this with a grep gate.
- NEVER add schedulers: no `schedule:` CI triggers, no cron manifests, no background intervals. Every job is a human-invoked command; sync-type commands must be watermark/range idempotent so irregular invocation is safe.
- Configuration reaches code exclusively through packages/core/src/config.ts reading process.env (Infisical-injected at process start). No other file reads env; no Infisical SDK imports in app logic; no hardcoded values.
- NEVER commit secrets, real account IDs, or operator-specific identifiers (personal names, Infisical workspace ids, emails). Roles are "maintainer" (repo decisions) and "operator" (deployments); deployment specifics live in Infisical and gitignored local files. Fixtures are synthetic (pnpm gen:fixtures).
- GitHub settings: only features free for public repos; never enable paid or metered products.
- Every money- or publish-adjacent action writes audit_log.
- Every number in analysis output must be reproducible via an included SQL query.
- Errors: no silent catches; deadletter + surface, per FWT error-handling standards.

## Conventions
- Ad names: {prefix}|{campaign_slug}|{short_code}|v{n} (prefix from settings) — builder/parser in packages/core only; never hand-construct.
- Conventional commits; schema changes via SQL migration files + pnpm db:migrate only, never dashboard/ad-hoc edits.
- TypeScript strict; zod at every boundary; no new deps without checking packages/core first and noting rationale in the PR body.

## Session ritual
Start: read this file + the current phase in docs/plan/06-BUILD-PLAN.md. End: show acceptance-criteria evidence, update docs/decisions/ if a ☐ item was resolved.
```
