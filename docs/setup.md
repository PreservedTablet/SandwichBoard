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

4. Run everything through injection:

   ```sh
   infisical run --env=dev -- pnpm db:migrate
   infisical run --env=dev -- pnpm dev
   ```

**Deployed processes** authenticate with an Infisical **machine identity**
(Universal Auth). Its client-id/secret pair is the single bootstrap
credential stored outside Infisical (host env / Fly secrets); it can read
the vault and nothing else, and revoking it severs the deployment from every
platform token at once:

```sh
export INFISICAL_TOKEN=$(infisical login --method=universal-auth \
  --client-id=<machine-identity-client-id> \
  --client-secret=<machine-identity-client-secret> --silent --plain)
infisical run --projectId=<your-project-id> --env=prod -- pnpm sync
```

**Fallback without Infisical:** copy `.env.example` to `.env` (gitignored),
fill in values, and use the `:local` scripts (`pnpm dev:local`,
`pnpm db:migrate:local`). Supported, but discouraged for anything beyond
local development — and gitleaks treats `.env` files as radioactive either
way.

## 2. Database — any vanilla Postgres 15+

The reference deployment is a **Postgres 16 container** beside Postiz on a
home server; Supabase and Neon work identically (docs/plan/02). Point
`DATABASE_URL` (Infisical `/api`) at it, then:

```sh
infisical run --env=dev -- pnpm db:migrate
```

Migrations are plain SQL in `db/migrations/`, applied in order, once each,
inside transactions, recorded in `schema_migrations`. Re-running is a no-op.
Never edit an applied migration — add a new one.

## 3. Storage

`STORAGE_DRIVER=local-fs` (default) writes under `STORAGE_LOCAL_PATH`
(default `data/storage`, gitignored). S3-compatible and Supabase Storage
drivers are planned additions behind the same adapter interface.

## 4. Claude Code session profiles

Two MCP profiles ship with the repo (docs/plan/05 T1 — session separation is
a hard rule):

| Profile           | Use for                             | Has                                            | Never has               |
| ----------------- | ----------------------------------- | ---------------------------------------------- | ----------------------- |
| `mcp-draft.json`  | `/analyze`, `/draft`, scout content | Postgres as read-only `analyst` role (Phase 3) | Any ad-platform MCP     |
| `mcp-manage.json` | Interactive campaign management     | Meta Ads MCP + read-only database              | Scout/untrusted content |

```sh
claude --mcp-config mcp-draft.json    # drafting / analysis sessions
claude --mcp-config mcp-manage.json   # campaign management sessions
```

The `analyst` database role (created in Phase 3) is enforced at the
database, not by prompt. When connecting the Meta MCP, choose **"opt in for
current business only"** during OAuth — least privilege is the single most
important click in the whole setup (docs/plan/04).

## 5. Scheduling — yours, optional, never shipped

Nothing in this repo runs unattended, and CI enforces that no workflow ever
gains a schedule trigger. Sync is range-based catch-up: each run pulls from
the last snapshot to yesterday, so weekly, daily, or erratic cadence all
produce the same correct result. If you want cadence, wrap the same commands
in your own cron/systemd timer on your own machine (example arrives with
`docs/operations.md` in a later phase).
