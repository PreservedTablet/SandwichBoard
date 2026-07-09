# 04 — Integrations

Facts below verified against primary/secondary sources on **2026-07-08**. ☐ = re-verify at build time (items also listed in `00`'s register).

## Meta (Facebook + Instagram ads)

Meta shipped official **"ads AI connectors"** in open beta on 2026-04-29: a hosted MCP server at `https://mcp.facebook.com/ads` and a CLI. Coverage: comprehensive reporting, campaign/ad-set/ad creation and editing, catalog management, signal (Pixel/CAPI) diagnostics — 29 tools on the MCP; the CLI exposes the broader Marketing API surface. Free during beta ☐.

**MCP (interactive management).** Add as a remote custom connector in Claude / Claude Code; auth is standard Meta Business OAuth — no developer app, no app review. During OAuth, choose **"opt in for current business only"** and select only the FWT Business Manager (least privilege; this is the single most important click in the whole setup). Writes require explicit authorization in-session. Use for: weekly interactive management, creative uploads, launching (paused) campaigns from approved recommendations.

**CLI (scripted ingestion — Plan A).** `npm install -g @meta/ads-cli` ☐ (verify current package name/installation in Meta's docs). Sources conflict on the auth model (system-user token vs. OAuth-only). ☐ **Resolve from Meta's official docs before Phase 2**; record in `docs/decisions/`. If a system-user token is required: create it in Business Manager scoped to `ads_read` only for the sync command; store it in Infisical (`/ingest` path); rotate quarterly (calendar reminder). The sync wrapper invokes the CLI for a **date range** (watermark → yesterday), not a fixed "yesterday" — manual cadence means catch-up is the normal case.

**Direct Insights API (Plan B).** ~150 lines: `GET /{ad-account-id}/insights?level=ad&fields=ad_id,ad_name,spend,impressions,clicks,actions&time_increment=1`. Same system-user token consideration. Choose B only if the CLI proves awkward to run non-interactively.

## Google Ads

Google's **official Google Ads MCP** (github.com/googleads/google-ads-mcp, Apache-2.0, released 2026-04-28) is deliberately narrow: **read-only**, three tools — `list_accessible_customers`, `search` (GAQL), `get_resource_metadata`. Runs locally via pipx as a stdio server (Claude Code / Desktop) or self-hosted on Cloud Run for remote use. Requires: developer token (Manager account → API Center), Google Cloud project ID, OAuth client or ADC. Env: `GOOGLE_PROJECT_ID`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_MCP_OAUTH_CLIENT_ID`, `GOOGLE_ADS_MCP_OAUTH_CLIENT_SECRET`.

**Maintainer action, pre-build (queue exists):** apply for Basic Access on the developer token. Specific wording performs better than generic: *"Solo founder using Google's official open-source Google Ads MCP server (github.com/googleads/google-ads-mcp) for read-only GAQL reporting on my own single ad account, via Claude Code, for an internal performance dashboard. No third-party data access, no writes."* Use a Test Account while it sits in queue.

Read-only is fine for v1: Google side is RSAs at low spend — the manual sync runs a range GAQL query (`SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM ad_group_ad WHERE segments.date BETWEEN '{watermark}' AND '{yesterday}'`), and changes stay manual in the UI. If the token queue stalls past Phase 2, fallback: Google Ads UI report export → CSV → `POST /ingest/google-csv` (build the CSV path anyway; it doubles as backfill).

## Postiz (publishing rail)

Self-hosted from `github.com/gitroomhq/postiz-app` (AGPL-3.0): three containers (app, PostgreSQL, Redis) via docker compose behind Caddy or Cloudflare Tunnel. Postiz Cloud is not used. **Public API** at `{BACKEND_URL}/public/v1` with API-key auth: `GET /integrations` (connected channels — "integration" = channel), `POST /posts` with `type: "draft"|"schedule"|"now"`, per-channel `settings` DTOs, `POST /upload` and `/upload-from-url`, `GET /posts?startDate&endDate` (returns `state` and `releaseURL`), `DELETE /posts/:id`. Rate limit is instance-global and self-hosters can raise it via the `API_LIMIT` env var ☐ (docs have shown both 30/hr and 90/hr as defaults across versions — check the deployed version's config reference). There is also an official **`postiz` agent CLI** (`posts:create`, `upload`, `analytics`, OAuth2 or API-key auth) purpose-built for driving Postiz from AI agents, and a Postiz MCP — either is acceptable for `/draft`-session use; `apps/api` uses the REST API.

**SandwichBoard integration contract:** approved `drafts` rows → `POST /posts` as Postiz **drafts or scheduled posts** (never `now` from code; the final go-live click can live in Postiz's calendar as a second checkpoint early on) → store `postiz_post_id` → poll `GET /posts` to capture `state` + `releaseURL` back onto the draft + `audit_log`.

**Platform-side reality:** self-hosted Postiz means bring-your-own platform apps, and the platforms gate *publishing* by account/app type regardless of Postiz: Instagram API publishing requires a Business/Creator IG account linked to a Facebook Page plus the `instagram_content_publish` permission through Meta app review; Facebook posting targets Pages and those permissions frequently require business verification; TikTok's content-posting scope requires passing an audit and a business/creator account footing; and any Google/YouTube OAuth app must be published to production or its refresh tokens die weekly. This is calendar time. Channels come online in approval-friction order: Reddit via the "copy & open thread" manual path from day one → Facebook Page once Pages permissions clear → Instagram after `instagram_content_publish` review → TikTok after its audit. The Meta permission path starts pre-build (`00`).

## Reddit (organic — the redesigned piece)

Constraints (2026): the Data API free tier is non-commercial-only behind a manual approval wall, and unauthenticated `.json` reads return 403 from datacenter IPs. **v1 takes no Reddit Data API dependency.**

**Scout capture, v1 (no Reddit API):**
1. **Keyword alert emails** — F5Bot (free Reddit keyword monitoring, long-running service ☐ verify alive) or equivalent → forwarded to a SandwichBoard inbound address or pasted → `scout_items(source='email_alert')`. Keywords: "borrow tools", "tool library", "rent a drill", city-sub mentions of tool-sharing, "FriendsWithTools".
2. **Bookmarklet / iOS share sheet → capture endpoint** — the operator browses Reddit normally; one tap files URL+selection into the inbox. This is the workhorse and it's 30 lines of code.
3. **Subreddit RSS** (`/r/{sub}/new/.rss`) from the home server's residential IP ☐ — verify it returns 200 from home; treat as bonus, not foundation.

**Reply flow:** `/draft` reads the item + the versioned founder-voice guide (`prompts/voice-reddit.md`, which mandates the disclosure line — e.g. *"(founder of FriendsWithTools, so grain of salt)"* — and bans link-dropping unless the thread asks), the operator edits/approves, and the reply posts **as the operator, from their own account** — via Postiz's Reddit channel where connected, else copy-and-paste (the button says "copy & open thread"). `drafts.disclosure_ok` must be true for `kind='reddit_reply'` to be approvable — enforced in the API, not the prompt. In parallel, optionally apply for the free-tier Data API key with an honest description (personal founder tool, read-only, low volume); if granted it upgrades capture, but nothing waits on it.

**Reddit paid** comes later via the Ads API (Pipeboard MCP covers Meta/Google/TikTok/Snap/Reddit under one auth with a free tier, when multi-platform paid is real — accepting a third party in the auth path is a deliberate future decision, not a default).

## Configuration via Infisical (BYO secrets)

SandwichBoard has **no secrets of its own** — every deployment connects its operator's Infisical project, and all runtime configuration is injected as environment variables at process start. The contract on the code side is strict: one zod-validated config module reads `process.env`; nothing else in the codebase touches configuration; no Infisical SDK imports in `packages/core` or app logic (Infisical is the delivery mechanism, not a dependency — a plain `.env` keeps working for contributors and CI-without-secrets).

**How injection works:** humans run `infisical login` once, then every command is wrapped — `infisical run --env=dev -- pnpm dev`, `infisical run --env=prod -- pnpm sync`. Deployed processes authenticate with an Infisical **machine identity**; its client-id/secret pair is the single bootstrap credential stored outside Infisical (Fly secrets or host env), it can read the vault and nothing else, and revoking it severs the deployment from every platform token at once. `infisical init` links a local checkout to **your own** Infisical workspace via `.infisical.json` — that file is **gitignored** (an `.infisical.json.example` is committed instead), so every clone connects its own Infisical project and nothing in the repo references any specific workspace. CI needs no platform secrets at all (lint/test/gitleaks are secretless); if a future workflow ever does, use Infisical's official GitHub Action ☐ rather than repo secrets. Infisical is open source and self-hostable if the cloud dependency ever chafes.

**Variable manifest** (checked into the repo as `config/variables.md` + mirrored in the zod schema — names and shapes are public, values never are). Suggested Infisical paths in parentheses:

| Var | Path | Notes |
|---|---|---|
| `DATABASE_URL` | `/api` | privileged app role; any vanilla Postgres (home-server container, Supabase, Neon) |
| `STORAGE_DRIVER` + driver vars (`STORAGE_LOCAL_PATH` \| `S3_ENDPOINT`/`S3_BUCKET`/`S3_ACCESS_KEY`/`S3_SECRET_KEY` \| `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`) | `/api` | pick one adapter; `local-fs` is the $0 default |
| `ANALYST_DATABASE_URL` | `/analysis` | connection string for the read-only `analyst` role used by Claude sessions |
| `META_SYSTEM_USER_TOKEN` ☐ | `/ingest` | `ads_read` only; only if Plan A/B requires it |
| `META_AD_ACCOUNT_ID` | `/ingest` | `act_…` (an identifier, kept here for tidiness) |
| `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_PROJECT_ID`, `GOOGLE_ADS_MCP_OAUTH_CLIENT_ID`, `GOOGLE_ADS_MCP_OAUTH_CLIENT_SECRET` | `/ingest` | read-only scope |
| `POSTIZ_BASE_URL`, `POSTIZ_API_KEY` | `/api` | cloud vs self-host: URL only |
| `INBOUND_CAPTURE_SECRET` | `/api` | HMAC on bookmarklet/email-in endpoints |
| `API_LIMIT` | (Postiz's own env, not ours) | raise Postiz public-API rate limit when self-hosting ☐ |

**Explicit absences, by design:** no `ANTHROPIC_API_KEY` (Claude runs on the operator's subscription in their own session; a CI grep asserts the string never appears in the repo), no OAuth tokens for adopters' platforms in SandwichBoard's database (custody stays with each operator's Infisical), no secrets in `CLAUDE.md`, fixtures, or examples.
