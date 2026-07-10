# Configuration variable manifest

The public manifest of every environment variable SandwichBoard reads
(docs/plan/04). Names and shapes are public; values never are. The single
consumer is `packages/core/src/config.ts` — no other file reads
`process.env`, and app logic never imports an Infisical SDK: Infisical is a
delivery mechanism, not a dependency. A plain gitignored `.env` works too
(`.env.example`, `pnpm dev:local`).

Suggested Infisical secret paths are in parentheses.

| Variable                                                                                                                  | Path        | Required                | Notes                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                                            | `/api`      | yes                     | Privileged app role; any vanilla Postgres 15+ (home-server container, Supabase, Neon) |
| `API_HOST`, `API_PORT`                                                                                                    | `/api`      | no (defaults)           | Bind address for `apps/api`; defaults `127.0.0.1:3000`                                |
| `STORAGE_DRIVER`                                                                                                          | `/api`      | no (default `local-fs`) | One of `local-fs`, `s3`, `supabase-storage`                                           |
| `STORAGE_LOCAL_PATH`                                                                                                      | `/api`      | with `local-fs`         | Default `data/storage` (gitignored)                                                   |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`                                                              | `/api`      | with `s3`               | Any S3-compatible store (e.g. MinIO)                                                  |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`                                                                               | `/api`      | with `supabase-storage` | Supabase Storage driver                                                               |
| `ANALYST_DATABASE_URL`                                                                                                    | `/analysis` | Phase 3                 | Read-only `analyst` role used by Claude sessions                                      |
| `META_SYSTEM_USER_TOKEN`                                                                                                  | `/ingest`   | Phase 2 (if required)   | `ads_read` only; existence depends on the ☐ Meta CLI auth-model verification          |
| `META_AD_ACCOUNT_ID`                                                                                                      | `/ingest`   | Phase 2                 | `act_…` identifier, kept here for tidiness                                            |
| `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_PROJECT_ID`, `GOOGLE_ADS_MCP_OAUTH_CLIENT_ID`, `GOOGLE_ADS_MCP_OAUTH_CLIENT_SECRET` | `/ingest`   | Phase 2                 | Read-only scope                                                                       |
| `POSTIZ_BASE_URL`, `POSTIZ_API_KEY`                                                                                       | `/api`      | Phase 5                 | Self-hosted Postiz; URL + API key only                                                |
| `INBOUND_CAPTURE_SECRET`                                                                                                  | `/api`      | Phase 4                 | HMAC for bookmarklet / email-in capture endpoints                                     |

**Explicit absences, by design (docs/plan/04):** no Anthropic key variable of
any kind — AI runs happen in the operator's own Claude Code session on their
own subscription, and CI fails the build if the forbidden variable name
appears anywhere outside `docs/plan/`. No platform OAuth tokens are ever
stored in SandwichBoard's database — custody stays with each operator's
Infisical project. `API_LIMIT` belongs to the operator's Postiz deployment,
not to SandwichBoard.
