# Operator setup

How a deployment links its own accounts to SandwichBoard. Every step here is
bring-your-own (docs/plan/01 principle 6): the repo ships no credentials, no
workspace ids, and no schedulers.

## 1. Secrets — your own Infisical project

SandwichBoard reads configuration from environment variables injected at
process start. The happy path is [Infisical](https://infisical.com) (open
source, self-hostable; the cloud free tier is fine):

1. Create your own Infisical project. Add environments `dev` and `prod`.
2. Add secrets per the manifest in [config/variables.md](../config/variables.md)
   — suggested folder layout: `/api`, `/ingest`, `/analysis`.
3. Link your local checkout (writes `.infisical.json`, which is
   **gitignored** — every clone links its own workspace; see
   `.infisical.json.example` for the shape):

   ```sh
   infisical login
   infisical init
   ```

4. Run everything through injection. `infisical run` reads only the root
   folder (`/`) of the environment by default — with the folder layout
   above you must pass `--path` (repeatable for multiple folders):

   ```sh
   infisical run --env=dev --path=/api -- pnpm db:migrate
   infisical run --env=dev --path=/api -- pnpm dev
   infisical run --env=dev --path=/api --path=/ingest -- pnpm sync
   ```

   **Troubleshooting:** if the CLI prints `Injecting 0 Infisical secrets`,
   the env slug or `--path` doesn't match where your secrets live — the
   command will then fail with a configuration error naming the missing
   variables.

**Deployed processes** authenticate with an Infisical **machine identity**
(Universal Auth). Its client-id/secret pair is the single bootstrap
credential stored outside Infisical (host env / Fly secrets); it can read
the vault and nothing else, and revoking it severs the deployment from every
platform token at once:

```sh
export INFISICAL_TOKEN=$(infisical login --method=universal-auth \
  --client-id=<machine-identity-client-id> \
  --client-secret=<machine-identity-client-secret> --silent --plain)
infisical run --projectId=<your-project-id> --env=prod \
  --path=/api --path=/ingest -- pnpm sync
```

**Fallback without Infisical:** copy `.env.example` to `.env` (gitignored),
fill in values, and use the `:local` scripts (`pnpm dev:local`,
`pnpm db:migrate:local`). Supported, but discouraged for anything beyond
local development — and gitleaks treats `.env` files as radioactive either
way.

**Check your wiring at any time** — per-feature readiness against the
manifest, variable names only (values are never printed); `--db` also
verifies the database is reachable with all migrations applied:

```sh
infisical run --env=dev --path=/api -- pnpm config:check --db
```

## 2. Database — any vanilla Postgres 15+

The reference deployment is a **Postgres 16 container** beside Postiz on a
home server; Supabase and Neon work identically (docs/plan/02). Point
`DATABASE_URL` (Infisical `/api`) at it, then:

```sh
infisical run --env=dev --path=/api -- pnpm db:migrate
```

Migrations are plain SQL in `db/migrations/`, applied in order, once each,
inside transactions, recorded in `schema_migrations`. Re-running is a no-op.
Never edit an applied migration — add a new one.

## 3. Storage

`STORAGE_DRIVER=local-fs` (default) writes under `STORAGE_LOCAL_PATH`
(default `data/storage`, gitignored). S3-compatible and Supabase Storage
drivers are planned additions behind the same adapter interface.

## 3.5 Importing an existing library

Leaving a spreadsheet behind? Reshape it once into the documented exchange
format ([docs/import-format.md](import-format.md)) — plain CSVs using the
library's own columns — drop the files somewhere gitignored (suggested:
`data/import/`), and run:

```sh
infisical run --env=dev --path=/api -- pnpm import:library data/import/assets.csv data/import/copy.csv
```

Validation is all-or-nothing, writes are one transaction, re-runs are
idempotent (`--dry-run` to preview). The importer speaks only
SandwichBoard's format by design: no legacy tracker's structure ever gets
wired into the codebase.

## 3.6 Meta ingestion (Phase 2)

The manual range sync pulls per-ad daily insights through **Meta's official
Ads CLI** — auth model, command contract, and the reasoning live in
[docs/decisions/0005-meta-ingestion.md](decisions/0005-meta-ingestion.md).

1. **Install the CLI** wherever syncs run (Python ≥ 3.12 required). Pin the
   verified version — PyPI also hosts an unrelated third-party
   `meta-ads-cli`; the official package is **`meta-ads`**:

   ```sh
   uv tool install 'meta-ads==1.1.0'   # or: pipx install 'meta-ads==1.1.0'
   ```

   If `meta` is not on the sync process's PATH, set `META_ADS_CLI_BIN`.

2. **Provision the credential** (Business Manager → Business settings →
   Users → System users): create a system user (Employee role suffices),
   assign your ad account with **View performance** access only, generate a
   token scoped to **`ads_read`** — nothing broader; a stolen sync token
   must only be able to read stats, never spend. Store it as
   `META_SYSTEM_USER_TOKEN` (Infisical `/ingest`) together with
   `META_AD_ACCOUNT_ID` (`act_…`). Set a quarterly rotation reminder.

3. **Set `INTERNAL_API_TOKEN`** (Infisical `/api`, e.g.
   `openssl rand -hex 32`) to enable the dashboard's "Sync now" button —
   the browser asks for it once per session. Without it the button's
   endpoint answers 503; `pnpm sync` works regardless (it talks to the
   database directly).

4. **Run it.** Sync is range-based catch-up: each run pulls from the last
   snapshot (or a 90-day backfill on first run) through yesterday in the ad
   account's timezone, idempotently — any cadence is correct.

   ```sh
   infisical run --env=prod --path=/api --path=/ingest -- pnpm sync
   ```

   Every run writes an `audit_log` summary; rows the sync can't use land in
   `ingest_deadletter`, and ads whose names don't match the naming
   convention surface in `v_unmatched_ads`.

## 3.7 Google metrics (Phase 2) — CSV upload, no token needed

Google ingestion needs **no API access**: export an ad-level report
segmented by day and upload it on the dashboard's **Metrics** page (or
POST it — see below). Re-uploads and overlapping date ranges are
idempotent; it doubles as historic backfill forever. Full decision record:
[docs/decisions/0006](decisions/0006-google-ingestion-and-metrics-dashboard.md).

**Columns.** Canonical headers are the GAQL field paths — this query's CSV
export is exactly right:

```
SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, segments.date,
       metrics.cost_micros, metrics.impressions, metrics.clicks,
       metrics.conversions, campaign.id, campaign.name
FROM ad_group_ad WHERE segments.date BETWEEN '2026-06-01' AND '2026-07-11'
```

Required: ad id, date (YYYY-MM-DD), impressions, clicks, and one cost
column (`metrics.cost_micros`, or a decimal `Cost`). The English UI export
headers (`Ad ID`, `Day`, `Cost`, `Impr.`, `Clicks`, `Conversions`,
`Campaign ID`, `Campaign`) are accepted as aliases; for anything else the
upload is rejected listing every accepted name — rename the header row
once and re-upload. Numbers must be unformatted (`1234`, not `"1,234"`);
a bad file is rejected whole with `file:line` problems, nothing partial.

Scripted upload (same endpoint the dashboard uses, bearer =
`INTERNAL_API_TOKEN`):

```sh
curl -X POST -H "Authorization: Bearer $YOUR_INTERNAL_API_TOKEN" \
  -H 'Content-Type: text/csv' --data-binary @report.csv \
  'http://127.0.0.1:3000/internal/ingest/google-csv?external_account_id=123-456-7890&label=My%20Google'
```

**Live GAQL ingestion** (no CSV step) arrives once your Google Ads API
developer token is approved (the pre-build queue item, docs/plan/00) — it
will wire the official read-only Google Ads MCP behind the same connector
seam. Nothing about the CSV path changes when it does.

## 4. Claude Code session profiles

Two MCP profiles ship with the repo (docs/plan/05 T1 — session separation is
a hard rule). Database access in AI sessions is **plain `psql` over
`ANALYST_DATABASE_URL`** — no third-party database MCP: the reference
Postgres MCP server was archived after a read-only-bypass SQL-injection
disclosure, and the analyst role is the real fence anyway
(docs/decisions/0007).

| Profile           | Use for                             | Has                          | Never has               |
| ----------------- | ----------------------------------- | ---------------------------- | ----------------------- |
| `mcp-draft.json`  | `/analyze`, `/draft`, scout content | Nothing — deliberately empty | Any ad-platform MCP     |
| `mcp-manage.json` | Interactive campaign management     | Official Meta Ads MCP        | Scout/untrusted content |

Always pass `--strict-mcp-config` so ONLY the named profile loads —
without it, user-scope MCP servers (possibly ad-platform ones) would leak
into draft sessions:

```sh
claude --mcp-config mcp-draft.json --strict-mcp-config    # drafting / analysis
claude --mcp-config mcp-manage.json --strict-mcp-config   # campaign management
```

The `analyst` database role is enforced at the database, not by prompt.
When connecting the Meta MCP, choose **"opt in for current business only"**
during OAuth — least privilege is the single most important click in the
whole setup (docs/plan/04).

## 4.5 The analysis loop (Phase 3)

The `analyst` role (created by migration 0005) can read everything and
insert only into `recommendations` and `audit_log` — even a fully hijacked
analysis session cannot spend, publish, or alter the library. One-time
wiring:

1. Create a **login user** for it and set its password yourself (the repo
   ships no credentials, so the NOLOGIN `analyst` role only carries the
   grants):

   ```sql
   create role my_analyst login password '<generate one>';
   grant analyst to my_analyst;
   ```

2. Set `ANALYST_DATABASE_URL` (Infisical `/analysis`) to connect as that
   user, **carrying the org context for row-level security** in the
   connection options (`ORG_ID` default is the nil UUID):

   ```
   postgres://my_analyst:…@host:5432/sandwichboard?options=-c%20app.org_id%3D00000000-0000-0000-0000-000000000000
   ```

   Without `app.org_id`, RLS returns zero rows — a safe failure mode; the
   prompt template includes the `set_config` fallback.

3. Run the ritual (Monday morning by design, any cadence in practice):

   ```sh
   infisical run --env=prod --path=/analysis -- \
     claude --mcp-config mcp-draft.json --strict-mcp-config
   # then, inside the session:
   /analyze
   ```

   The contract lives in `prompts/analyze.md` (prompts are code — they
   change via PRs). Output: `reports/YYYY-MM-DD.md` (gitignored — real
   spend data stays local) plus `recommendations` rows whose evidence
   embeds the SQL that re-computes every cited number. Review with
   `pnpm analyze:open`; record verdicts on the dashboard's
   **Recs** page — they feed the next run.

## 5. Scheduling — yours, optional, never shipped

Nothing in this repo runs unattended, and CI enforces that no workflow ever
gains a schedule trigger. Sync is range-based catch-up: each run pulls from
the last snapshot to yesterday, so weekly, daily, or erratic cadence all
produce the same correct result. If you want cadence, wrap the same commands
in your own cron/systemd timer on your own machine (example arrives with
`docs/operations.md` in a later phase).
