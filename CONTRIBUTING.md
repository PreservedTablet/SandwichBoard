# Contributing to SandwichBoard

Thanks for your interest. SandwichBoard is maintained by **PreservedTablet**
(the Licensor named in [LICENSE](LICENSE)). Two lightweight legal
requirements apply to every outside contribution, both from day one
(docs/plan/07):

## 1. DCO sign-off

Every commit must carry a Developer Certificate of Origin sign-off
(<https://developercertificate.org/>):

```sh
git commit -s -m "feat: …"
```

The `-s` flag adds `Signed-off-by: Your Name <email>` attesting you have the
right to submit the work under this repository's license.

## 2. Contributor license grant (CLA)

By submitting a contribution you agree that:

1. You license your contribution to PreservedTablet under the repository's
   current license (FSL-1.1-ALv2), **and**
2. You grant PreservedTablet a perpetual, worldwide, non-exclusive,
   royalty-free, irrevocable right to **relicense** your contribution —
   including under the license's future Apache-2.0 grant, any later version
   of the FSL, or a commercial license.

This keeps the project's license workable long-term (the FSL's two-year
Apache-2.0 conversion requires a single rights-holder). If you can't agree,
open an issue to discuss instead of a PR.

## Development

```sh
corepack enable                 # pnpm 10 (pinned in package.json)
pnpm install
pnpm test && pnpm lint && pnpm typecheck && pnpm build
```

- **Pre-commit hooks** run gitleaks + lint-staged. Install
  [gitleaks](https://github.com/gitleaks/gitleaks#installing) locally; the
  hook refuses to run without it (CI runs the identical scan either way).
- **Conventional commits** (`feat:`, `fix:`, `chore:`, `docs:` …).
- **Schema changes** are new files in `db/migrations/` applied by
  `pnpm db:migrate` — never edit an applied migration.
- **Configuration** is read only by `packages/core/src/config.ts`. Don't
  read `process.env` anywhere else; don't import Infisical SDKs.
- **No new dependencies** without checking `packages/core` first and noting
  the rationale in the PR body.
- **Never commit** secrets, real account IDs, or operator-specific
  identifiers. CI runs gitleaks and a forbidden-string gate; the repo also
  never gains scheduled CI triggers.
- Read `CLAUDE.md` and `docs/plan/` before nontrivial work — the plan set is
  the spec.
