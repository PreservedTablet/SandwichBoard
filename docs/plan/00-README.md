# SandwichBoard — Plan Document Set

**SandwichBoard** lives at `PreservedTablet/sandwichboard`. It is an open(source-available), self-hostable marketing operations system, built first for FriendsWithTools: a creative library, a cross-platform performance warehouse, an AI analysis loop, and a human-approved publishing rail. Stack: pnpm monorepo, SvelteKit 2/Svelte 5, Fastify 5, vanilla Postgres. Four principles govern everything: **deterministic plumbing, AI judgment, human trigger, bring-your-own everything** (each deployment brings its own Infisical project for secrets, its own Claude subscription for AI runs, and its own scheduler if it wants one — the repo ships none of the three).

**What this is not:** an autoposter, an astroturf engine, or an autonomous ad manager. Nothing spends money and nothing posts publicly without explicit one-tap approval. Reddit participation is disclosed-founder only.

## Document map

| Doc | Contents |
|---|---|
| `01-PRODUCT-BRIEF.md` | Scope contract: v1 in/out, principles, success metrics — read first |
| `02-ARCHITECTURE.md` | Components, data flow, locked design decisions |
| `03-DATA-MODEL.md` | Postgres schema draft, ad-naming convention, UTM scheme |
| `04-INTEGRATIONS.md` | Meta, Google, Postiz, Reddit, Infisical — contracts and variable manifest |
| `05-SECURITY.md` | Threat model and required controls — shapes Phase 0 |
| `06-BUILD-PLAN.md` | Phased execution with acceptance criteria, guardrails, draft CLAUDE.md |
| `07-NAME-AND-LICENSE.md` | Decision record: name, npm stance, license implementation |

## Decisions (all final)

Name **SandwichBoard**; nothing publishes to npm in v1. License **FSL-1.1-Apache-2.0** — implementation notes in `07`. Secrets via **Infisical** injection; code reads `process.env` only. **Manual-first**: no shipped schedulers of any kind. Meta ingestion **Plan A** (official `@meta/ads-cli` inside the manual sync; Plan B fallback requires the maintainer's approval). **Postiz self-hosted** (`gitroomhq/postiz-app`, AGPL-3.0, docker compose) on the home server behind Cloudflare Tunnel. **Postgres-first**: vanilla Postgres + pluggable storage adapter; the reference deployment is a Postgres container beside Postiz on the home server.

**Pre-build tasks (maintainer, outside the repo — no agent):** apply for Google Ads API Basic Access (wording in `04`); create the Infisical project + machine identity; begin the Meta app Pages/IG-publishing permission path (gates Phase 5 channels); optionally request Reddit Data API free tier (nothing depends on it).

## How to trigger the build

1. Commit this doc set to `docs/plan/`; add `LICENSE` (FSL-1.1-Apache-2.0, see `07`).
2. Confirm subscription auth: `env | grep -i anthropic` must return nothing (a stray `ANTHROPIC_API_KEY` silently switches Claude Code to API billing).
3. Kickoff prompt from the repo root: *"You are building SandwichBoard in this repository (`PreservedTablet/sandwichboard`). Read every file in docs/plan/ completely. Then execute Phase 0 of docs/plan/06-BUILD-PLAN.md exactly, stopping at each ⚠ STOP marker for my confirmation. Do not begin Phase 1 until Phase 0 acceptance criteria are demonstrated with command output."*
4. One phase per session; `/clear` between phases and point the agent at the next phase section.

## Verify-at-build-time register

Facts researched 2026-07-08; beta integrations drift. Re-verify each ☐ against primary docs before writing dependent code and record answers in `docs/decisions/`: ☐ Meta CLI auth model, ☐ Meta MCP beta pricing status, ☐ Postiz current API surface + rate-limit env var, ☐ Reddit RSS availability from the home server's egress IP, ☐ F5Bot service status, ☐ Infisical CLI machine-identity flow + current GitHub Action name.
