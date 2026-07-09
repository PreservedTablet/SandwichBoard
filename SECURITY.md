# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through **GitHub's private
vulnerability reporting** on this repository (Security tab → "Report a
vulnerability"). You'll get an acknowledgment within a week, usually much
faster. Please do not open public issues for security reports.

## Scope and posture

SandwichBoard is a single-operator, self-hosted system. The full threat
model lives in [docs/plan/05-SECURITY.md](docs/plan/05-SECURITY.md). The
short version of what the design guarantees:

- **No stored platform credentials.** All secrets live in the operator's own
  Infisical project and reach processes only as env vars at start; the
  database stores no one's tokens.
- **No autonomous spend or publishing.** Every money- or publish-adjacent
  action passes a human approval gate and is written to `audit_log`.
- **Untrusted content is quarantined.** Sessions that read scout content
  (Reddit threads, alert emails) never have ad-platform write access
  (`mcp-draft.json` vs `mcp-manage.json` separation).
- **Supply-chain hygiene.** Committed lockfile, 72h release cooldown,
  postinstall allow-listing, SHA-pinned CI actions; gitleaks, osv-scanner,
  and a dependency audit run on every push.

## Known non-goals (v1)

Documented honestly (docs/plan/05): no SSO/multi-user RBAC (single
allow-listed operator), no SOC2-style logging pipeline (the `audit_log`
table suffices), no WAF tuning beyond Cloudflare defaults, no
encryption-at-rest beyond what the chosen Postgres/storage host provides.
