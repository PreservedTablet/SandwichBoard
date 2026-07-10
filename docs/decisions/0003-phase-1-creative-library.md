# 0003 — Phase 1 creative-library decisions

Date: 2026-07-10. Scope: everything decided while executing Phase 1 of
docs/plan/06-BUILD-PLAN.md. No ☐ verify-register item fell inside Phase 1
scope (all remaining register items concern Phase 2+ integrations); this
entry records implementation decisions and the phase's ⚠ STOP disposition.

## Implementation decisions

1. **`v_unmatched_ads` ships as a typed empty stub.** The Phase 1 acceptance
   criterion wants the view to exist, but its subject (`ad_entities`)
   arrives in Phase 2. The stub selects correctly-typed nulls `where false`
   with `security_invoker = true`, giving the dashboard a stable contract;
   Phase 2 drops and recreates it against the real table (a new migration,
   never an edit).
2. **A creative is its combination — enforced in the database.** Migration
   0002 makes `short_code`, `org_id`, and the four component references
   immutable after insert, and restricts DELETE to `status='draft'`.
   Swapping components (or codes) under a live short code would silently
   re-attribute every metric row that joins through the naming convention.
   A mis-built draft is deleted and rebuilt; codes are free (36⁵ ≈ 60.4M).
   Known softness, accepted: `copy_variants.body` stays editable — fixing a
   typo in live copy is operator judgment, not schema policy.
3. **short_code generation.** `gen_short_code()` draws 5 lowercase base36
   chars from `pgcrypto` randomness; a BEFORE INSERT trigger retries up to
   20 candidates against existing rows, with the unique constraint as the
   concurrent-insert backstop (the API surfaces that as a retriable 409).
   Modulo bias (byte % 36) is accepted — the code is an opaque join key,
   not a secret. The core parser tolerates 3–12 base36 chars syntactically
   so a future length change cannot make historical names unparseable;
   whether a code matches a row is ingestion's lookup, not parser syntax.
4. **Parser posture: strict with one mercy.** Whitespace around pipe
   delimiters is normalized (a hand-retyped name still matches); every
   other deviation — Meta's " - Copy" suffix, case changes, dropped
   segments, version typos — fails with a machine-readable code + reason,
   which is exactly what feeds `v_unmatched_ads` in Phase 2. Failure is a
   return value (`ok:false`), never an exception: unparseable platform
   names are a normal data condition.
5. **`ORG_ID` config variable (default nil UUID).** Single-operator v1
   stamps every row with one org id from config; RLS policies additionally
   see it via `set_config('app.org_id', …, true)` inside every API
   transaction (belt and suspenders — the privileged role owns the tables,
   so explicit WHERE clauses carry the real isolation until Phase 3's
   analyst role, where RLS bites for real).
6. **Tokenized reads sign with a per-process secret.** Read URLs are
   `exp`+HMAC over the asset id, TTL 300 s, secret generated at boot:
   tokens are consumed within minutes by the page that requested them, v1
   is a single API instance, and a restart merely makes the UI request a
   fresh URL. No new secret in the manifest, nothing to rotate or leak.
   Served files get `X-Content-Type-Options: nosniff`; only allowlisted
   content types are stored, and SVG is attachment-only (it executes
   script when rendered inline).
7. **Uploads are raw-body PUTs, not multipart** — `fetch(url, { method:
'PUT', body: file })` with the content type as the header. Avoids a
   multipart dependency entirely; cap 250 MB (large video stays external
   by design, docs/plan/01). Keys are `assets/{id}/original.{ext}`.
8. **zod added to `apps/api` dependencies.** Not a new workspace dependency
   — same `^4.4.3` line `packages/core` already uses; the API validates
   every request boundary with it (CLAUDE.md convention), and route-local
   schemas (query params) live beside the routes while row/payload
   contracts live in core.
9. **The web app reads no configuration and renders client-side only**
   (`ssr = false`). Every data call is same-origin `/api/*`: vite's dev
   server proxies to `127.0.0.1:3000` (mirroring config.ts's API_PORT
   default), and production uses the reverse proxy already in the
   deployment topology (docs/plan/02). This keeps the only-config-module
   rule intact — no `$env` imports anywhere in `apps/web`.
10. **Naming prefix is bootstrapped as data, never a constant.** The API
    whitelists writable settings keys (`naming_prefix`, validated); when
    unset, the ad-name endpoint returns a 409 and the combo page shows a
    one-time inline "set your prefix" prompt. Nothing in the tree hardcodes
    `fwt` outside docs and test fixtures.
11. **CI gained a digest-pinned Postgres service container** (postgres:16
    by sha256, matching the SHA-pinned-actions discipline) and sets
    `TEST_DATABASE_URL` for the API integration suite. Without the
    variable the suite skips — loudly, via a placeholder test that names
    the variable — so local `pnpm test` still passes with no database.
12. **eslint: browser globals + `resolve()` navigation.** `apps/web/src`
    gets `globals.browser`; all internal links/`goto()`s use SvelteKit's
    `resolve()` (route-id form for dynamic segments) with a tiny
    `withQuery()` helper that appends search params without losing the
    `ResolvedPathname` brand. Tokenized file URLs are `rel="external"` —
    they are API resources, not router destinations.

## Phase 1 ⚠ STOP disposition

| STOP                         | Disposition                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seed CSV (maintainer export) | **Raised; work stopped there.** The importer is deliberately unwritten: the plan says to build it against the CSV's real headers, and inventing headers would produce a mapper the real file breaks. Everything else in Phase 1 (migrations, core, API, web, tests, CI) is complete and demonstrated. The "seed import loads real library" acceptance criterion stays open until the CSV arrives. |
