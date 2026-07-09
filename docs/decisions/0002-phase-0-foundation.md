# 0002 — Phase 0 foundation decisions

Date: 2026-07-09. Scope: everything resolved or decided while executing
Phase 0 of docs/plan/06-BUILD-PLAN.md.

## ☐ verify-register items resolved

### License text (docs/plan/07)

Already resolved in [0001-license.md](0001-license.md) at repo setup.
Independently re-verified this session: the committed `LICENSE` matches the
current canonical `FSL-1.1-ALv2` template byte-for-byte apart from the
filled-in Notice line, and the old `FSL-1.1-Apache-2.0` template URL still
redirects to it. No file change needed.

### Infisical CLI machine-identity flow + GitHub Action name (docs/plan/00)

Verified against infisical.com/docs (2026-07-09):

- `infisical init` writes `.infisical.json` (workspace id + default
  environment). Infisical's docs consider it committable; **this repo
  gitignores it anyway** because the workspace id is operator-specific
  (docs/plan/04). `.infisical.json.example` is committed instead.
- Injection: `infisical run --env=<env> [--path=<path>] -- <cmd>`.
- Machine identity (Universal Auth):
  `INFISICAL_TOKEN=$(infisical login --method=universal-auth --client-id=… --client-secret=… --silent --plain)`.
- Current official GitHub Action: `Infisical/secrets-action` (v1.0.9).
  **Not used** — CI is secretless by design; recorded for the future case
  the register anticipated.

## Implementation decisions

1. **Security scanners via pinned `go install`.** CI builds
   `gitleaks@v8.30.1` and `osv-scanner@v2.4.0` from source through the Go
   module proxy instead of downloading release binaries. Integrity comes
   from Go's checksum database (no hand-copied sha256 values to go stale);
   versions stay exact-pinned. The pre-commit hook uses the same gitleaks
   version. osv-scanner v2 invocation: `osv-scanner scan source -L pnpm-lock.yaml`.
2. **Forbidden-string gate scope.** The gate fails on any occurrence of the
   Anthropic key variable name anywhere in the tree **except `docs/plan/`**,
   because the committed plan documents themselves name the variable while
   specifying this very rule. The gate's own pattern is assembled from two
   string halves so the workflow file never contains the literal.
3. **No-scheduler gate added to CI.** Beyond the acceptance grep, CI
   permanently fails if any workflow gains `schedule:`/cron keys — cheap
   insurance for the "no shipped schedulers" invariant (docs/plan/02).
4. **Build step added to CI** between test and the scanners: the fresh-clone
   acceptance criterion includes `pnpm build`, so CI proves it on every push.
5. **Dependabot version-update config deliberately omitted.** Phase 0's
   repo-settings list covers Dependabot _alerts + security updates_ (repo
   settings, no committed file). A `dependabot.yml` would introduce a
   required `schedule:` key into the tree; grouped weekly version-update
   PRs (docs/plan/05 T3) remain a maintainer choice for later (Renovate or
   Dependabot both fine).
6. **RLS on vanilla Postgres.** Policies compare `org_id` to
   `app_current_org()`, a helper reading the per-session setting
   `app.org_id`. Works identically on a home-server container, Supabase,
   Neon, or RDS (docs/plan/03's `auth.jwt()` sketch is Supabase-only).
   `apps/api` will set `app.org_id` per connection when it starts querying
   (Phase 1).
7. **Storage adapter placement.** Interface lives in `packages/core`
   (types only); drivers live in `apps/api/src/storage/*` so core never
   imports platform SDKs (docs/plan/02 decision 5). Signed/tokenized read
   URLs are an API-layer concern and arrive with the upload/read endpoints
   in Phase 1.
8. **CLAUDE.md stack line** says "vanilla Postgres (any provider via
   DATABASE_URL)" where the plan's draft appendix said "Supabase" — aligned
   with the locked Postgres-first decision (docs/plan/02 decision 7).
9. **Supply-chain settings** (docs/plan/05 T3): pnpm `minimumReleaseAge:
4320` (72h cooldown) and `onlyBuiltDependencies: [esbuild]` in
   `pnpm-workspace.yaml`; a selective override lifts `cookie@<0.7.0` to the
   patched `^0.7.2` line (GHSA-pxg6-pf52-xh8x via @sveltejs/kit) until kit
   bumps its own range.
10. **SECURITY.md contact** is GitHub private vulnerability reporting, not
    an email address — keeps operator-identifying strings out of the tree
    (CLAUDE.md hard rule) while giving researchers a private channel.
    Enabling it is part of the maintainer's repo-settings step.
11. **MCP profiles ship as skeletons.** `mcp-draft.json` /
    `mcp-manage.json` exist from Phase 0 with pinned versions; the analyst
    database role they reference is created in Phase 3, which will also
    re-evaluate the pinned Postgres MCP server (its upstream reference
    implementation is archived).

## Phase 0 ⚠ STOP dispositions

The four STOP markers were raised for maintainer confirmation; the
interactive channel was unavailable in this remote session, and work
proceeded on the plan's own defaults per the maintainer's standing
"continue" instruction. Standing decisions, each reversible:

| STOP                   | Disposition                                                                                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo settings via `gh` | No `gh`/admin API in the build session. Exact commands handed to the maintainer (see PHASE-0-EVIDENCE notes in the session log); criterion recorded as **pending maintainer execution**, not silently degraded.        |
| Infisical project      | Repo-side wiring complete; maintainer creates their own project + machine identity and runs `infisical init` locally. `.env` fallback demonstrated in-session.                                                         |
| Postgres backend       | Plan default assumed: Postgres 16 container beside Postiz on the home server. In-session migration demo ran against a disposable local PostgreSQL 16.13. Supabase/Neon remain drop-in alternatives via `DATABASE_URL`. |
| LICENSE Licensor line  | Pre-answered by [0001-license.md](0001-license.md): `Copyright 2026 PreservedTablet` is the maintainer's recorded wording, re-verified canonical this session. CONTRIBUTING.md's CLA names the same party.             |
