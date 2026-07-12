# /analyze — weekly performance analysis (v1)

You are running SandwichBoard's analysis ritual inside the operator's own
Claude Code session. You read the metrics warehouse through the
**database-enforced read-only `analyst` role** and produce two artifacts:
a markdown report and `recommendations` rows. Nothing you write executes
anything — a human accepts or rejects every proposal on the dashboard.

## Session preconditions (check before touching data)

1. This session must have **no ad-platform MCP attached** (hard rule,
   CLAUDE.md). If any Meta/Google ads tools are available, STOP and tell
   the operator to restart with
   `claude --mcp-config mcp-draft.json --strict-mcp-config`.
2. `ANALYST_DATABASE_URL` must be present in the environment (injected via
   `infisical run --env=<env> --path=/analysis -- claude …`). Connect with
   `psql "$ANALYST_DATABASE_URL"`. If a probe query returns zero rows from
   a table you expect populated, the session's org context is missing —
   run `select set_config('app.org_id', '<ORG_ID>', false);` first (RLS
   scopes every query to the org; the recommended connection string sets
   it automatically — docs/setup.md).
3. The analyst role can SELECT everything and INSERT only into
   `recommendations` and `audit_log`. If any other write seems necessary,
   that is a design signal to report, never to work around.

## Inputs (query these; do not invent)

```sql
-- freshness: how old is the data you are analyzing?
select platform, max(date) as data_through from metric_snapshots s
join ad_entities e on e.id = s.ad_entity_id group by platform;

-- the evidence-gated leaderboard (per platform + 'all' rollup)
select * from v_combo_leaderboard order by platform, spend_cents desc;

-- daily series for trends (last 30 days)
select * from v_combo_daily where date > current_date - interval '30 days'
order by short_code, platform, date;

-- combos with delivery that sit below the gate (insufficient data)
select short_code, platform, sum(spend_cents) spend_cents, sum(impressions) impressions
from v_combo_daily group by 1, 2
except
select short_code, platform, spend_cents, impressions from v_combo_leaderboard;

-- hygiene: convention violations and ingest failures
select * from v_unmatched_ads;
select count(*) from ingest_deadletter where not resolved;

-- the current gate thresholds (defaults 2500 / 1000 when unset)
select key, value from settings
where key in ('evidence_gate_min_spend_cents', 'evidence_gate_min_impressions');

-- last run's advice and what the operator did with it — score it honestly
select id, run_id, kind, rationale, status, outcome_note, created_at
from recommendations order by created_at desc limit 50;
```

## Rules of judgment

- **"Insufficient data" is a first-class conclusion.** Expect to say it
  more often than "scale this". A combo below the evidence gate gets
  _observations_, never a verdict.
- **Every `scale` or `pause` must cite the gate being met** — name the
  combo's spend and impressions against the thresholds in its evidence.
- **Every number in the report must be reproducible**: the report's
  appendix lists every SQL query used, and each evidence claim embeds the
  exact SQL that recomputes its value (CLAUDE.md hard rule).
- **Respect platform budget floors when proposing** `budget_shift`
  (≈$5/day Meta ad set, ≈$10/day Google, ≈$20/day TikTok campaign) — a
  proposal below floor is not actionable.
- Proposals only. No budget change, launch, or pause happens here; even an
  accepted recommendation requires fresh explicit confirmation in whatever
  session executes it (docs/plan/06 guardrails).
- Freshness first: if `data_through` is older than 7 days, open the report
  by saying so and recommend a sync before trusting conclusions.
- Score last week honestly: for each prior recommendation with a verdict,
  note whether the data since supports or contradicts it. If accepted
  advice underperformed rejected advice, say that plainly.

## Output 1 — the report

Write `reports/YYYY-MM-DD.md` (today's date; the directory is gitignored —
reports contain real spend data and never belong in a public repo):

```markdown
# SandwichBoard analysis — YYYY-MM-DD

## TL;DR ← 3-5 sentences, verdicts first, staleness disclosed

## Data window ← platforms, data_through dates, gate thresholds used

## Leaderboard ← gated combos, per platform + all; what is winning and why you believe it

## Below the gate ← combos with delivery but insufficient evidence; what would change that

## Last run scored ← prior recommendations vs what the data did since

## Hygiene ← unmatched ads, open deadletters, anything smelling wrong

## Recommendations ← one section per rec, mirroring the inserted rows

## Appendix — SQL ← every query used, verbatim, so any number can be re-run
```

## Output 2 — `recommendations` rows

One run_id for the whole invocation (`select gen_random_uuid();` once).
For each recommendation:

```sql
insert into recommendations (org_id, run_id, kind, subject_creative_id, rationale, evidence)
values (
  current_setting('app.org_id')::uuid,
  '<run_id>',
  'scale',                    -- scale | pause | new_variant | budget_shift | investigate
  '<creative uuid or NULL>',  -- from creatives via short_code
  'One paragraph a human can act on without opening the report.',
  '{
    "window": {"since": "…", "until": "…"},
    "gate": {"min_spend_cents": 2500, "min_impressions": 1000, "met": true},
    "claims": [
      {"label": "spend_cents (all platforms)", "value": 4984,
       "sql": "select spend_cents from v_combo_leaderboard where short_code = ''roawf'' and platform = ''all''"}
    ]
  }'::jsonb
);
```

Every `claims[].sql` must return exactly `claims[].value` when re-run —
that is the acceptance test of this whole harness. Finish by leaving the
run's trace:

```sql
insert into audit_log (org_id, actor, action, subject_table, payload)
values (current_setting('app.org_id')::uuid, 'claude-analyze', 'analyze_run_completed',
        'recommendations',
        '{"run_id": "<run_id>", "report": "reports/YYYY-MM-DD.md", "recommendations": <n>}'::jsonb);
```

Then tell the operator: report path, how many recommendations, and that
verdicts happen at `/recommendations` on the dashboard
(`pnpm analyze:open` prints the report).
