---
description: Weekly analysis — read the warehouse as analyst, write report + recommendations
---

Run SandwichBoard's analysis ritual.

1. Read `prompts/analyze.md` (the versioned contract — prompts are code)
   and follow it exactly.
2. Before querying: confirm this session has **no ad-platform MCP tools**
   (if it does, stop — the operator must relaunch with
   `claude --mcp-config mcp-draft.json --strict-mcp-config`), and that
   `ANALYST_DATABASE_URL` is set.
3. All database access goes through `psql "$ANALYST_DATABASE_URL"` — the
   analyst role is read-only plus inserts into `recommendations` and
   `audit_log`, enforced by the database, not by this prompt.
4. Deliverables: `reports/YYYY-MM-DD.md` (gitignored), `recommendations`
   rows whose evidence SQL re-computes to the cited values, and one
   `analyze_run_completed` audit row.
