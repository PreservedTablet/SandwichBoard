# 07 — Decision Record: Name, npm, License

**Name:** SandwichBoard, at `PreservedTablet/sandwichboard`.

**npm:** nothing is published in v1 — adoption is clone-and-self-host and `packages/core` is an internal workspace package. The unclaimed `sandwichboard` npm name may later receive a minimal redirect placeholder (a real package pointing at the repo — npm's dispute policy disallows empty squats); any future artifacts can also publish under the `@preservedtablet` scope. No action for the agent.

**License: FSL-1.1-Apache-2.0** (Functional Source License). Operational meaning, which the README's first screen must state in plain English: anyone may use, modify, and self-host SandwichBoard, including inside their commercial business; no one may offer SandwichBoard — or a substitute derived from it — as a commercial product or service; each release automatically becomes Apache-2.0 two years after that release's date.

**Phase 0 implementation:**
1. `LICENSE` = the canonical FSL-1.1-Apache-2.0 text fetched from fsl.software (Sentry's `getsentry/fsl.software` repo is the source of truth) ☐ — do not paraphrase license text. The license's copyright/Notice line must name a rights-holder (the "Licensor"). To keep personal names out of the git history, use a business entity or the `PreservedTablet` pseudonym — ⚠ STOP for the maintainer's exact wording. Whatever is named here is also the party the CLA assigns rights to and the seller in any future dual-license deal.
2. README first screen carries the plain-English summary above plus "human-in-the-loop by design: this tool will not astroturf or spend money autonomously." GitHub's license detector may show "Other" — expected, not a bug.
3. `CONTRIBUTING.md`: DCO sign-off plus a lightweight CLA assigning the named Licensor relicensing rights — required before accepting any outside PR, and cheap only if present from day one.
4. Boundary note: SandwichBoard consumes Postiz over HTTP as a separate service, so Postiz's AGPL imposes nothing on this codebase, and this license imposes nothing on Postiz.

**Repo hygiene at creation:** `SECURITY.md` with a disclosure email; branch protection on `main`; gitleaks + dependency scanning live before the first real commit.
