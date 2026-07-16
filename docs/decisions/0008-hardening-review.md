# 0008 — Full-repo hardening review (post-Phase-3)

Date: 2026-07-16. Scope: a maintainer-requested trust review of everything
built in Phases 0–3 — four independent audit passes (API, core+migrations,
web, docs/CI) plus a live end-to-end exercise of every phase against a
scratch Postgres 16. This record captures the decisions the fixes embody;
the commit history carries the individual changes.

## What the review confirmed (evidence, not vibes)

Build, typecheck, lint green; the full suite (233 tests including all DB
integration suites) passes against real Postgres — and now also passes run
twice in a row as a **non-superuser** table owner, which is the deployment
RLS actually binds (see below). Full-history gitleaks scan: clean. Grep
gates: clean. Live smoke test walked settings → asset → copy → combo →
canonical ad name (round-trip verified) → Google CSV ingest (idempotent
re-upload) → leaderboard/unmatched/staleness → recommendation verdict with
audit rows. The naming/UTM/money paths, the analyst fence, and the
watermark design were verified correct as built.

## Decisions

1. **CI drops `pnpm audit`.** npm retired the audit endpoints pnpm calls
   (verified live: HTTP 410), so the step failed every push and blocked
   the pipeline before the security gates ran. osv-scanner (already in CI)
   scans the same lockfile against OSV, which ingests the GitHub Advisory
   Database npm audit reads — same coverage, still deterministic. CI also
   gains a `pull_request` trigger so fork PRs get checked, and the
   no-scheduler gate now matches flow-style YAML too.

2. **Meta sync watermarks are per ad, not per account.** With one
   account-wide watermark, a transient per-ad insights failure was
   deadlettered and then _permanently skipped_ — the ads that succeeded
   advanced the mark past the failed ad's gap, silently under-counting
   that combo forever (exactly the corruption a metrics warehouse must
   never allow). Each ad now resumes from its own `max(date)`;
   never-delivered ads re-ask from the backfill floor (one extra ranged
   CLI call, returns empty — negligible). The regression test proves a
   failed ad's gap heals on the next run.

3. **RLS is FORCEd (migration 0006).** RLS was enabled but not forced, and
   the app connects as the table owner — owners bypass non-forced
   policies, so the "belt and suspenders" the code comments promised bound
   nobody but the analyst role. Forcing it makes the org policies bind
   every non-superuser connection, makes `audit_log` genuinely append-only
   for the app, and keeps `recommendations` history immutable (a new
   org-scoped UPDATE policy carries the operator verdict flow; the analyst
   role still has no UPDATE grant). Recorded caveats: Postgres superusers
   always bypass RLS (docs/setup.md now says to use a dedicated
   non-superuser role for the second belt), and the 0002 short-code
   cross-org pre-check is now org-scoped with the global unique constraint
   as backstop (cross-org collision ⇒ 409, vanishingly rare at base36^5).

4. **Google CSV `raw` keeps the original export cells** (keyed by the
   file's own header), not the normalized row — 0004's re-parseability
   contract was broken by storing already-derived cents. Campaign-name
   upserts now never let the `google campaign <id>` placeholder overwrite
   a real name.

5. **Numeric strictness everywhere:** conversions cells (Google CSV and
   Meta action values) now reject what bare `Number()` silently accepts
   ('1e3' → 1000, '0x10' → 16) via a strict-decimal parser; request-body
   zod schemas are `.strict()` so unknown/misspelled fields fail loudly
   instead of being dropped; CSV problems cite physical file lines even
   when quoted fields span lines; the metrics endpoints return `float8`
   instead of `int4` casts (cumulative totals past ~$21M / 2.1B
   impressions would have 500'd the leaderboard); the daily series window
   is now inclusive (last 30 days meant 29).

6. **Upload path rebuilt around one managed pipeline + atomic writes.**
   The old `.pipe()` chain raised an unhandled stream error on an
   over-limit chunked body — killing the API process (reproduced, then
   pinned by a regression test) — and `local-fs` truncated the existing
   object on open, so a failed re-upload destroyed the previous good file.
   Now: request stream bridged into a `pipeline()` (413 surfaces as a
   response, the process survives), storage writes to a temp file and
   renames into place, and the superseded object is deleted only after the
   database points at the new one.

7. **Web app gets an error story and honest UI state.** Root
   `+error.svelte` + a load-error adapter (ApiError keeps its status; API
   unreachable reads as 503 with a hint) replace redacted default 500s.
   The staleness banner moved into the layout load
   (`depends('app:sync-status')`), so CSV ingest / deadletter resolve /
   Sync now refresh it via invalidation instead of leaving it stale.
   Fixed along the way: the vite dev proxy now maps `/internal/*` (the
   Sync-now button and CSV upload were dead in dev), an `$effect` loop
   that made the combo page's destination URL unclearable, tag chips
   vanishing while their filter was active, the file input keeping its
   name after ingest, sparklines skipping zero-delivery days (now
   zero-filled over the window's date axis), clipboard copy failing
   silently on non-secure origins (legacy fallback + visible failure),
   and settings writes now leave `setting_changed` audit rows (the naming
   prefix and conversion mapping change what the numbers mean).

## Known-open (deliberate, not forgotten)

- Phases 4–5 are unbuilt; their ⚠ STOP inputs (voice-guide examples,
  Postiz deployment, capture secrets) are the maintainer's.
- Live-credential acceptance items from 0005/0006/0007 still wait on
  `META_SYSTEM_USER_TOKEN` and the Google developer token.
- Phase 0's repo-settings pass (branch protection, Dependabot, push
  protection via `gh api`) remains maintainer-executed per 0002.
- Library-import dedupe is case-insensitive for copy bodies but
  case-sensitive for asset titles — noted, harmless, left as is.
