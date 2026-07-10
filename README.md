# SandwichBoard

Self-hostable marketing operations for solo founders: a creative library, a
cross-platform performance warehouse, an AI analysis loop, and a
human-approved publishing rail.

**Human-in-the-loop by design: this tool will not astroturf or spend money
autonomously.** Nothing posts publicly and nothing changes spend without
explicit one-tap approval. Community replies are disclosed-founder only.

## License, in plain English

SandwichBoard is source-available under the **Functional Source License
(FSL-1.1-ALv2)** — see [LICENSE](LICENSE):

- Anyone may **use, modify, and self-host** SandwichBoard, including inside
  their commercial business.
- No one may offer SandwichBoard — or a substitute derived from it — **as a
  commercial product or service**.
- Each release **automatically becomes Apache-2.0 two years** after that
  release's date.

(GitHub's license detector may show "Other" — expected, not a bug.)

## Bring-your-own everything

SandwichBoard ships logic; you bring accounts (docs/plan/01):

- **Secrets** live in _your own_ [Infisical](https://infisical.com) project
  and are injected as env vars at process start. The codebase reads
  configuration only through one zod-validated module; a plain gitignored
  `.env` also works. SandwichBoard's code and database never store platform
  credentials for anyone.
- **AI** runs in _your own_ Claude Code session on _your own_ subscription.
  This repo contains no Anthropic credentials and makes no Anthropic API
  calls (CI enforces it).
- **Scheduling** is _yours if you want it_. Nothing here runs unattended:
  every job (`pnpm sync`, `/analyze`, `/draft`) is a command a human runs.
  Sync is range-based catch-up, so irregular cadence is the designed-for
  case. Operators who want cadence wrap the same commands in their own cron.

## Status

**Phase 0 (foundation) — done.** Monorepo scaffold, config module, storage
adapter (local-fs), plain-SQL migrations, CI security gates. Phases 1–5
(creative library → metrics spine → analysis → scout/drafts → publish rail)
are specified in [docs/plan/06-BUILD-PLAN.md](docs/plan/06-BUILD-PLAN.md).

## Quickstart

Prereqs: Node ≥ 22.12, pnpm 10 (`corepack enable`), any Postgres 15+,
[gitleaks](https://github.com/gitleaks/gitleaks) on PATH (pre-commit hook).

```sh
pnpm install
cp .env.example .env        # fallback path; Infisical is the happy path — see docs/setup.md
# edit .env: point DATABASE_URL at your Postgres
pnpm db:migrate:local       # apply plain-SQL migrations
pnpm dev:local              # boots apps/api (:3000) and apps/web (:5173)
```

With your own Infisical project linked (`infisical init` — see
[docs/setup.md](docs/setup.md)):

```sh
infisical run --env=dev -- pnpm db:migrate
infisical run --env=dev -- pnpm dev
```

## Repository layout

| Path              | Contents                                                          |
| ----------------- | ----------------------------------------------------------------- |
| `apps/web`        | SvelteKit 2 / Svelte 5 dashboard                                  |
| `apps/api`        | Fastify 5 API: auth, CRUD, ingestion, storage drivers, migrations |
| `packages/core`   | zod schemas, shared types, the single config module               |
| `db/migrations`   | Plain SQL, applied by `pnpm db:migrate` on any Postgres           |
| `prompts/`        | Versioned prompt templates (prompts are code)                     |
| `config/`         | Public configuration manifest                                     |
| `docs/plan/`      | The committed v1 plan set — the spec this repo is built from      |
| `docs/decisions/` | Decision records, including ☐ verify-register resolutions         |

Claude Code session profiles: `mcp-draft.json` (drafting/analysis — database
as read-only analyst, **no ad-platform access**) and `mcp-manage.json`
(interactive campaign management). Never mix them — see `CLAUDE.md`.

## Security

See [SECURITY.md](SECURITY.md) for reporting and
[docs/plan/05-SECURITY.md](docs/plan/05-SECURITY.md) for the threat model.
