# 0006 — Google ingestion path + metrics dashboard (Phase 2, Session 2b)

Date: 2026-07-12. Scope: everything decided while executing Session 2b —
the Google side of the metrics spine, the dashboard over it, and the
`config:check` portability command. Built entirely without credentials
(maintainer's standing instruction, 2026-07-12): verified contracts, fake
fixtures for tests, live checks flagged where they depend on maintainer
credentials.

## Google ingestion: CSV ships now, GAQL waits for the token

The plan (docs/plan/06) conditions live GAQL ingestion on the Google Ads
developer token ("if token approved") and mandates the CSV path
"regardless". The token application is a maintainer pre-build task with no
approval signal yet, so **the CSV upload is Session 2b's shipping Google
path** — it is not a degraded mode; the plan designed it as the universal
fallback/backfill and it stays useful forever (historic backfills, token
outages, adopters who never request API access).

**Recorded for the day the token lands** (re-verified 2026-07-12): the
official Google Ads MCP is `github.com/googleads/google-ads-mcp`
(Apache-2.0) — stdio transport, three read-only tools (`search` for GAQL,
`get_resource_metadata`, `list_accessible_customers`), run via
`pipx run --spec git+https://github.com/googleads/google-ads-mcp.git google-ads-mcp`.
It has **no PyPI releases**, so when it is wired in it must be pinned by
commit SHA (supply-chain posture, docs/plan/05 T3). Its env contract
matches our manifest names (`GOOGLE_ADS_DEVELOPER_TOKEN`,
`GOOGLE_PROJECT_ID`, `GOOGLE_ADS_MCP_OAUTH_CLIENT_ID/SECRET`). The live
slice will add a `GoogleConnector` beside the Meta one — official-tool
subprocess, same seam — either speaking MCP-over-stdio to that server
(preferred: docs/plan/02 decision 3, official MCPs over custom clients) or
falling back to a direct GAQL `searchStream` client if the MCP proves
awkward non-interactively. That choice is deliberately deferred until it
can be made against the real thing; nothing in this session's schema or
endpoints changes either way.

## The CSV contract (packages/core/src/google.ts)

1. **Canonical headers are GAQL field paths** (`ad_group_ad.ad.id`,
   `segments.date`, `metrics.cost_micros`, …) — locale-free, deterministic,
   and exactly what API/MCP exports emit. A small alias set accepts the
   English UI report headers (`Ad ID`, `Day`, `Cost`, `Impr.`, …) as a
   courtesy; anything unrecognized fails listing every accepted name, and
   renaming a header row once is the documented escape hatch. Aliases for
   a UI we cannot see without credentials are best-effort by design — the
   error message is the contract.
2. **Both cost dialects accepted**: `metrics.cost_micros` (integer micros
   → cents via integer half-up math, 1¢ = 10,000µ) or a decimal `Cost`
   column (through `parseMoneyToCents`). Numerics are strict — formatted
   values ("1,234") are rejected with guidance to export unformatted, not
   silently mangled.
3. **Required**: ad id, date, impressions, clicks, one cost column.
   Optional: ad name, conversions, campaign id/name, ad group id. Empty
   metric cells ingest as zero delivery.
4. **Validation is all-or-nothing** with `file:line` problems (same
   semantics as `pnpm import:library`), _unlike_ the Meta sync's
   deadletter-and-continue. Rationale: the Meta path consumes a
   heterogeneous live API where one bad row is a row-level anomaly worth
   quarantining; a CSV is one operator-curated machine export where one bad
   cell almost always means a wrong export — a clear whole-file rejection
   beats a half-ingested report. Duplicate (ad, date) rows are rejected the
   same way (an export segmented beyond day would double-count).
5. **Unparseable ad names are not file errors.** They are the normal data
   condition: the row ingests, the ad lands in `v_unmatched_ads` with the
   parser's code (unnamed RSAs → `empty`). Google-side UTM fallback
   matching (docs/plan/03) remains a future landing-side join, out of
   Session 2b scope.
6. Uploads share the Meta sync's **per-org advisory write lock** — ingest
   writers never interleave — and write the same audit shape
   (`google_csv_ingested`, summary payload). Customer ids are stored
   digits-only (`123-456-7890` → `1234567890`).

## Dashboard decisions

7. **The API adds filtering, never arithmetic**: leaderboard and daily
   endpoints read `v_combo_leaderboard` / `v_combo_daily` as-is, so every
   number on screen is reproducible by querying the view (CLAUDE.md).
   `platform=all` selects the views' GROUPING-SETS rollup rows.
8. **"Insufficient data" is rendered, not hidden**: the leaderboard
   response carries `combos_below_gate` (combos with delivery that fail
   the settings-driven gate) and the page says so explicitly — the gate is
   a feature (docs/plan/01 principle 3), demonstrated live: a combo with
   1675¢ Google spend appears under `all` (4984¢ with Meta) but not under
   `google` (< 2500¢ gate).
9. **Sparklines are hand-rolled inline SVG** (spend + CTR, last 30 days,
   per leaderboard row from `v_combo_daily`) — no charting dependency
   (CLAUDE.md: no new deps).
10. **Deadletter resolve is a PATCH with an audit row**
    (`deadletter_resolved`/`deadletter_reopened`) — rows are never
    deleted; the payload stays for re-parsing. Unmatched-ads and
    deadletter counts in the staleness banner are now links to `/metrics`,
    which carries the two issue panels (the plan's "badges").
11. **The internal-token UX is shared** (`$lib/internal-token.ts`,
    sessionStorage-only): the banner's "Sync now" and the CSV upload use
    the same paste-once flow; a future session-login (docs/plan/05 T5)
    replaces one module.

## Portability: `pnpm config:check`

12. Added on the maintainer's request (2026-07-12) to make the
    clone-and-go path self-diagnosing: `configReadiness()` in core reports
    per-feature status (`ready`/`incomplete`/`not_configured`) against the
    manifest, printing **variable names only, never values** (unit test
    asserts no value leakage); `--db` additionally connects and compares
    applied migrations to `db/migrations/`. Exit code reflects core
    readiness only — optional features being unset is a state, not an
    error.

## ⚠ STOP dispositions (this session)

| STOP                        | Disposition                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (none raised in Session 2b) | The CSV path needs no credentials by design. The live-GAQL slice waits on the maintainer's developer-token approval (pre-build queue item, docs/plan/00) — flagged, not blocking. The phase-wide live acceptance checks (two Meta runs on different days, ≤5% spend drift vs platform UI) still wait on the Meta credential per 0005. |
