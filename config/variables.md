# Configuration variable manifest

The public manifest of every environment variable SandwichBoard reads
(docs/plan/04). Names and shapes are public; values never are. The single
consumer is `packages/core/src/config.ts` — no other file reads
`process.env`, and app logic never imports an Infisical SDK: Infisical is a
delivery mechanism, not a dependency. A plain gitignored `.env` works too
(`.env.example`, `pnpm dev:local`).

Suggested Infisical secret paths are in parentheses.

| Variable                                                                                                                  | Path        | Required                   | Notes                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                                            | `/api`      | yes                        | Privileged app role; any vanilla Postgres 15+ (home-server container, Supabase, Neon)                                        |
| `NODE_ENV`                                                                                                                | `/api`      | no (default `development`) | One of `development`, `test`, `production`                                                                                   |
| `API_HOST`, `API_PORT`                                                                                                    | `/api`      | no (defaults)              | Bind address for `apps/api`; defaults `127.0.0.1:3000`                                                                       |
| `ORG_ID`                                                                                                                  | `/api`      | no (default nil UUID)      | Tenancy scope stamped on every row; the default suits any solo deployment                                                    |
| `STORAGE_DRIVER`                                                                                                          | `/api`      | no (default `local-fs`)    | One of `local-fs`, `s3`, `supabase-storage`                                                                                  |
| `STORAGE_LOCAL_PATH`                                                                                                      | `/api`      | with `local-fs`            | Default `data/storage` (gitignored)                                                                                          |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`                                                              | `/api`      | with `s3`                  | Any S3-compatible store (e.g. MinIO)                                                                                         |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`                                                                               | `/api`      | with `supabase-storage`    | Supabase Storage driver                                                                                                      |
| `ANALYST_DATABASE_URL`                                                                                                    | `/analysis` | for `/analyze`             | Login user granted the `analyst` role; append `?options=-c%20app.org_id%3D<ORG_ID>` so RLS sees the org (docs/setup.md §4.5) |
| `INTERNAL_API_TOKEN`                                                                                                      | `/api`      | for `/internal/*`          | Bearer token guarding command endpoints (dashboard "Sync now"); unset ⇒ they answer 503                                      |
| `META_SYSTEM_USER_TOKEN`                                                                                                  | `/ingest`   | for Meta ingestion         | System-user token, `ads_read` only (☐ resolved: docs/decisions/0005)                                                         |
| `META_AD_ACCOUNT_ID`                                                                                                      | `/ingest`   | for Meta ingestion         | `act_…` identifier, kept here for tidiness                                                                                   |
| `META_ADS_CLI_BIN`                                                                                                        | `/ingest`   | no (default `meta`)        | Path to Meta's official Ads CLI binary (PyPI `meta-ads`, pinned in docs/setup.md)                                            |
| `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_PROJECT_ID`, `GOOGLE_ADS_MCP_OAUTH_CLIENT_ID`, `GOOGLE_ADS_MCP_OAUTH_CLIENT_SECRET` | `/ingest`   | Phase 2                    | Read-only scope                                                                                                              |
| `POSTIZ_BASE_URL`, `POSTIZ_API_KEY`                                                                                       | `/api`      | Phase 5                    | Self-hosted Postiz; URL + API key only                                                                                       |
| `INBOUND_CAPTURE_SECRET`                                                                                                  | `/api`      | Phase 4                    | HMAC for bookmarklet / email-in capture endpoints                                                                            |

**Explicit absences, by design (docs/plan/04):** no Anthropic key variable of
any kind — AI runs happen in the operator's own Claude Code session on their
own subscription, and CI fails the build if the forbidden variable name
appears anywhere outside `docs/plan/`. No platform OAuth tokens are ever
stored in SandwichBoard's database — custody stays with each operator's
Infisical project. `API_LIMIT` belongs to the operator's Postiz deployment,
not to SandwichBoard.
