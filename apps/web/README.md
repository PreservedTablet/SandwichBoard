# @sandwichboard/web

SvelteKit 2 / Svelte 5 dashboard: creative library (assets, copy, combo
builder with canonical ad names + UTM), metrics leaderboard with sparklines
and the staleness banner, CSV ingestion, and the recommendations verdict
screen. The scout inbox and publish approval screens land with Phases 4–5
(see `docs/plan/06-BUILD-PLAN.md`).

The app reads no configuration at all: the browser talks same-origin
`/api/*` and `/internal/*`, proxied to `apps/api` by the vite dev server
locally and by your reverse proxy in production (both prefixes — see
docs/setup.md).

Run from the repo root (`--path` matters if your Infisical secrets live in
folders — see docs/setup.md):
`infisical run --env=dev --path=/api -- pnpm dev`
(or `pnpm dev:local` with a gitignored `.env`).
