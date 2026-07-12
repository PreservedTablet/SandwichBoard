# 0005 — Meta ingestion (Phase 2, Session 2a)

Date: 2026-07-10. Scope: the ☐ Meta-CLI auth-model verification, the
resulting ingestion contract, and everything decided while building the
manual range sync. (The plan names `0002-meta-ingestion.md` for this record;
0002 was already taken by the Phase 0 entry, so it lives here.)

## ☐ resolved: Meta Ads CLI auth model

**System-user access token — not OAuth-only.** Meta's official Ads CLI
overview (developers.facebook.com → documentation → ads-commerce →
ads-ai-connectors → ads-cli) states verbatim: _"Ads CLI authenticates with a
Meta system user access token and calls the Marketing API on your behalf."_
Confirmed empirically: `meta auth status` without credentials prints
`Not authenticated. Set the ACCESS_TOKEN environment variable.` (exit 3).

Why sources conflicted: the CLI's config module carries OAuth helpers (app
id/secret, a local callback port, default 8787), so third-party writeups
describing "standard Business OAuth, no token to rotate" were conflating the
**hosted MCP** (`mcp.facebook.com/ads`, which is OAuth) with the CLI —
whose shipped version exposes only `meta auth status` and reads
`ACCESS_TOKEN`. For scripted ingestion the documented model is the token.

**Package identity (supply-chain note).** The official CLI is **`meta-ads`
on PyPI** (published by Meta's PyPI account; v1.1.0, 2026-06-17; Python
≥ 3.12; installs a `meta` command). The plan's guess `@meta/ads-cli` (npm)
does not exist, and PyPI also hosts an unrelated **third-party**
`meta-ads-cli` that predates Meta's release — an easy near-miss. Operators
must install exactly:

```sh
uv tool install 'meta-ads==1.1.0'   # or: pipx install 'meta-ads==1.1.0'
```

## Verified CLI contract (basis of the connector)

Verified 2026-07-10 by installing `meta-ads==1.1.0` in a disposable venv and
tracing the requests it constructs against a stubbed SDK transport — **no
live API calls, no credentials**. The CLI wraps the official
`facebook_business` SDK (25.0.2, Graph API v25.0).

- Env: `ACCESS_TOKEN`, `AD_ACCOUNT_ID` (`act_` prefix optional — the CLI
  normalizes). `.env`-file support exists; env vars take precedence.
- Scripted use: `meta -o json --no-input --no-color ads …`; documented
  "consistent exit codes (0–5)"; errors print to stderr.
- `ads adaccount get` → `GET act_X?fields=id,name,account_status,currency,timezone_name,amount_spent`
  → JSON **array of one** object. Doubles as the sync's auth preflight and
  supplies the account's currency + IANA timezone.
- `ads campaign list` / `ads ad list` → `GET act_X/campaigns|ads` with
  pass-through `--fields`, `--limit` → JSON **array** (envelope unwrapped).
- `ads insights get --since YYYY-MM-DD --until YYYY-MM-DD --time-increment
daily --fields …` → `GET {node}/insights` with
  `time_range{since,until}`, `time_increment=1` → prints the **raw
  Marketing API envelope** `{data: […], paging: {…}}`.
- **`level` is derived from the filter flag** — no filter ⇒
  `level=account`, `--campaign-id` ⇒ `campaign`, `--ad-id` ⇒ `ad`. There is
  **no account-wide `level=ad` invocation**, so per-ad ingestion is
  necessarily _enumerate-then-fetch_: one `ad list`, then one
  `insights get --ad-id` per ad. N+1 is acceptable at this deployment's
  scale (one account, tens of ads); every response is one page and the
  connector **fails loudly** if `paging.next` appears or a list comes back
  at its `--limit` ceiling — silent truncation would corrupt the warehouse.

**Plan A is confirmed viable** on these facts; Plan B (direct Insights API)
stays a fallback that requires the maintainer's explicit approval, per plan.

## ⚠ STOP — credential the maintainer must provision

Ingestion needs exactly one secret plus one identifier, both in Infisical
`/ingest` (manifest: `config/variables.md`):

1. Business Manager → Business settings → Users → **System users** → create
   (Employee role is enough) → **Assign assets**: the FWT ad account with
   **View performance** only.
2. **Generate token** for that system user: choose the business's app (a
   plain Business-type app; create one if none exists — no review needed for
   reading your own account), scope **`ads_read` only**, 60-day or
   non-expiring per preference → store as `META_SYSTEM_USER_TOKEN`.
   Quarterly rotation reminder per docs/plan/05 T2.
3. `META_AD_ACCOUNT_ID` = the `act_…` id.
4. On whatever machine runs syncs: Python ≥ 3.12 and
   `uv tool install 'meta-ads==1.1.0'` (`meta` must be on PATH, or point
   `META_ADS_CLI_BIN` at the binary).

## Implementation decisions

1. **The CLI runs as a child process with an explicitly constructed
   environment.** `packages/core/src/config.ts` stays the single reader of
   `process.env`; the connector injects `ACCESS_TOKEN`/`AD_ACCOUNT_ID` from
   config into the child only, with a neutral working directory — the CLI's
   generic variable names never live in the operator's shell, and its
   `.env`-discovery can't pick up strays from the repo.
2. **`/internal/*` requires a bearer token** (`INTERNAL_API_TOKEN`, new
   config secret, constant-time compared). Unset ⇒ the endpoint answers 503
   naming the variable — loud, never silently open. The dashboard's "Sync
   now" prompts for the token once and keeps it in `sessionStorage`; the
   plan's session-login (docs/plan/05 T5) can replace this later without
   moving the endpoint.
3. **Watermark = per-account `max(metric_snapshots.date)`, re-pulled.** The
   sync range is `watermark → yesterday` inclusive (else a 90-day backfill
   floor), so the most recent synced day is fetched again every run — free
   healing for same-day partial data and late attribution on that day.
   "Yesterday" is computed in the **ad account's own timezone**
   (`timezone_name` from the preflight; UTC fallback), since that is the
   calendar Insights buckets by.
4. **`ad_entities.platform_account_id` added** (vs the draft DDL): the
   per-account watermark needs snapshots → account lineage, and
   `campaign_id` is nullable so it can't carry it. The draft's
   `unique (platform, external_ad_id)` stands. `match_failure_code/_reason`
   columns persist the parser's machine-readable verdict (Phase 1 handoff),
   plus ingest's own `code-not-found` for a parseable name whose short code
   has no creative row; a CHECK ties `creative_id is null` to
   `match_failure_code is not null` so unmatched rows always say why.
5. **Conversions are mapped by data, not code.** Which Insights
   `action_type`s count as a conversion depends on the operator's Pixel
   setup, so it lives in settings (`meta_conversion_action_types`, a string
   array; also summed against `action_values` for
   `conversion_value_cents`). Unset ⇒ conversions ingest as 0 — and because
   every snapshot keeps the full platform row in `raw` jsonb, setting the
   key later plus a re-sync (or a one-off re-parse) recovers history.
   Money is parsed with decimal string math (`parseMoneyToCents`), never
   floats.
6. **Evidence gate thresholds are settings rows** —
   `evidence_gate_min_spend_cents` / `evidence_gate_min_impressions`,
   whitelisted in the settings API. The leaderboard view reads them per org
   via scalar subqueries, falling back to the product brief's defaults
   (2500¢ / 1000 impressions) when unset. `v_combo_leaderboard` uses
   GROUPING SETS to emit per-platform rows plus a `platform='all'` rollup,
   each independently gated.
7. **Fetch, then write.** All CLI calls complete before a single write
   transaction touches the database (no subprocess latency inside a
   transaction). The write phase takes a per-org advisory transaction lock —
   a concurrent second run gets a clean 409 `sync_already_running`. On any
   failure the transaction rolls back whole and a `meta_sync_failed` audit
   row is written in its own transaction; per-row anomalies (unparseable
   metric values, one ad's insights call failing) deadletter and the run
   continues. Auth errors abort immediately — every subsequent call would
   fail identically.
8. **Reads retry, writes don't exist.** This path is read-only toward Meta;
   transient CLI failures retry twice with backoff, auth errors never
   retry. The no-auto-retry guardrail (docs/plan/06) binds platform
   _writes_, which Session 2a does not perform.
9. **Known caveats, accepted:** ads deleted at the platform stop appearing
   in `ad list`, so days between the last sync and the deletion are never
   fetched (already-ingested history is immutable — retire ads, don't
   delete them); Insights returns no row for zero-delivery days, so date
   gaps in `metric_snapshots` are normal, not missing data.

## ⚠ STOP dispositions (this session)

| STOP                      | Disposition                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meta credential provision | **Raised — maintainer's move.** Auth model resolved above; required credential is exactly `META_SYSTEM_USER_TOKEN` (`ads_read`) + `META_AD_ACCOUNT_ID`, steps listed. All plumbing is built and integration-tested against a fake connector; the live-campaign acceptance checks (two runs on different days, ≤5% spend drift vs platform UI) wait on the credential and the maintainer's eyeballs. |
| Plan B fallback           | **Not triggered.** Plan A confirmed workable from official docs + the shipped CLI itself; no approval sought.                                                                                                                                                                                                                                                                                       |
