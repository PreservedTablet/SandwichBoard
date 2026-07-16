# SandwichBoard — agent rules

## Project

Marketing ops for FriendsWithTools: creative library, metrics warehouse, analysis, human-approved publishing. Read docs/plan/ before nontrivial work. Stack: pnpm monorepo, SvelteKit 2/Svelte 5, Fastify 5, vanilla Postgres (any provider via DATABASE_URL), vitest.

## Hard rules

- NEVER attach an ad-platform MCP and scout/untrusted content in the same session. Draft/analyze sessions use mcp-draft.json only (`claude --mcp-config mcp-draft.json --strict-mcp-config`); interactive campaign management uses mcp-manage.json (`claude --mcp-config mcp-manage.json --strict-mcp-config`). `--strict-mcp-config` is part of the rule — without it, user-scope MCP servers (possibly ad-platform ones) leak into the session. Never mix them.
- NEVER publish (`type:"now"`), change budgets, or create campaigns without explicit human confirmation in this session. Writes create PAUSED objects. Failed writes are reported, never retried.
- NEVER introduce an Anthropic API key or any Anthropic API call — all AI work happens in the operator's own Claude Code session on their subscription. CI enforces this with a grep gate.
- NEVER add schedulers: no schedule triggers in CI, no cron manifests, no background intervals. Every job is a human-invoked command; sync-type commands must be watermark/range idempotent so irregular invocation is safe.
- Configuration reaches code exclusively through packages/core/src/config.ts reading process.env (Infisical-injected at process start). No other file reads env; no Infisical SDK imports in app logic; no hardcoded values.
- NEVER commit secrets, real account IDs, or operator-specific identifiers (personal names, Infisical workspace ids, emails). Roles are "maintainer" (repo decisions) and "operator" (deployments); deployment specifics live in Infisical and gitignored local files. Fixtures are synthetic — tests build their own inline; real exports stay in gitignored data/.
- GitHub settings: only features free for public repos; never enable paid or metered products.
- Every money- or publish-adjacent action writes audit_log.
- Every number in analysis output must be reproducible via an included SQL query.
- Errors: no silent catches; deadletter + surface, per FWT error-handling standards.

## Conventions

- Ad names: {prefix}|{campaign_slug}|{short_code}|v{n} (prefix from settings) — builder/parser in packages/core only; never hand-construct.
- Conventional commits; schema changes via SQL migration files + pnpm db:migrate only, never dashboard/ad-hoc edits. Never edit an applied migration; add a new one.
- TypeScript strict; zod at every boundary; no new deps without checking packages/core first and noting rationale in the PR body.

## Session ritual

Start: read this file + the current phase in docs/plan/06-BUILD-PLAN.md. End: show acceptance-criteria evidence, update docs/decisions/ if a ☐ item was resolved.
