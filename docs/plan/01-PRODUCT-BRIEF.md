# 01 — Product Brief

## Problem

FriendsWithTools marketing currently runs on a Google Sheets tracker, scattered creative assets (17 photo stills, 8 video concepts as Scalemo.ai briefs, Canva overlays, Google RSA copy), and manual per-platform bookkeeping. Three costs: (1) no single source of truth for which asset × copy combination is winning, (2) performance data lives inside each platform's UI and never cross-pollinates, (3) organic community participation (especially Reddit) is high-value but slow and easy to drop.

## Users

One operator: a solo founder marketing their own business (reference deployment: FriendsWithTools). Design single-tenant, but keep the schema multi-tenant-ready (an `org_id` column everywhere, RLS from day one) because the open-source release will attract other solo founders — that is the audience paid competitors (Motion, Smartly, Triple Whale) price out.

## V1 scope — IN

1. **Creative Library.** Every image, video, tagline, and copy variant registered with tags, stored via the storage adapter (local disk by default; S3-compatible or Supabase Storage optional; large video may stay wherever it lives, referenced by URL). Combos ("creative" = asset + copy + angle) are first-class rows with canonical IDs.
2. **Naming convention + UTM scheme.** Deterministic ad names and UTMs encode the creative ID, so platform metric rows join back to combos without any platform-side custom fields. This convention is the load-bearing wall of the whole system (spec in `03`).
3. **Metrics spine.** On-demand snapshots of spend, impressions, clicks, CTR, CPC, CPM, conversions per ad from Meta (automated pull) and Google (automated-or-CSV in v1), normalized into one table. The sync is a **manually invoked, range-based catch-up** — it pulls everything since the last snapshot, so irregular cadence is the designed-for case, not an error state.
4. **Combo leaderboard.** Which combinations win, per platform and overall, gated by minimum-evidence thresholds (see Success metrics) so a $6 fluke never outranks a $150 workhorse.
5. **Analysis loop.** A Claude Code slash command (`/analyze`) that reads the warehouse and writes (a) a weekly markdown report and (b) structured rows in a `recommendations` table — every recommendation citing the metric rows that justify it. Claude proposes; nothing executes.
6. **Scout inbox → draft → approval → publish.** Capture interesting Reddit threads / content opportunities into an inbox (capture mechanisms in `04` — deliberately not dependent on Reddit's gated Data API), Claude drafts a disclosed-founder reply or an own-brand post in the FWT voice, the operator approves or edits, approved items publish through Postiz to FWT-owned channels (FB Page, IG, TikTok, Reddit) or are hand-posted.
7. **Audit log.** Every write that touches money or public posting is a row: who/what/when/payload/outcome.

## V1 scope — OUT (explicitly deferred)

Autonomous budget changes or campaign creation without approval; multi-armed-bandit auto-optimization (sub-$500/mo spend cannot feed it — revisit at ~$3k/mo); TikTok/Snap/Reddit *paid* (add via Pipeboard when spend justifies a third party in the auth path); automatic video generation (keep generating Scalemo briefs as artifacts; a "brief generator" button is a v1.1 nicety); comment/DM inbox management; competitor ad-library scraping; any undisclosed or automated organic posting to communities.

## Operating principles

1. **Deterministic plumbing, AI judgment, human trigger.** ETL is plain code on a schedule — no LLM in the ingestion path (cheaper, testable, no hallucinated numbers). LLMs read the warehouse and draft; a human clicks the button that spends or publishes.
2. **Disclosed founder, always.** Every community reply identifies the operator as the founder. The system makes genuine participation *faster*, not fake participation possible. This is a product feature, not just ethics: FWT sells neighborhood trust.
3. **Evidence-gated conclusions.** No "winner" label below minimum spend/impression thresholds. The report says "insufficient data" more often than it says "scale this."
4. **Own the data.** Postgres you control, exportable, no vendor-proprietary state. Third-party auth brokers only when a first-party path doesn't exist.
5. **Boring writes.** Any write to an ad platform is created PAUSED where the platform supports it, is never auto-retried on error, and requires explicit confirmation (inherited from ad-ops best practice; enforced in agent guardrails, `06`).
6. **Bring-your-own everything.** Secrets live in the operator's own Infisical project and are injected at process start — SandwichBoard's code and database never store platform credentials for anyone. AI runs happen in the operator's own Claude Code session on their own subscription — the project contains no Anthropic API key and makes no Anthropic API calls. Nothing is scheduled: every job (sync, analyze, draft) is a command a human runs; operators who want automation wrap those same commands in their own cron. This is what makes the project safely open-sourceable: adopters bring accounts, we ship logic.

## Success metrics (90 days post-build)

- Weekly marketing admin time drops from current state to **≤ 2 hours/week** (tracking, analysis, and posting combined).
- **100% of live ads** conform to the naming convention and auto-join to a creative row (measured: after each sync, the unmatched-ads list is empty or explicitly triaged before the next sync).
- Leaderboard evidence gate: a combo is rankable only after **≥ $25 spend and ≥ 1,000 impressions** on a platform (tunable constants, not magic numbers in code).
- **≥ 3 disclosed-founder Reddit replies/week** drafted-and-approved through the pipeline, at < 5 minutes of operator-time each.
- Zero incidents: no unapproved publish, no unapproved spend change, no secret in git history (CI-enforced).
