# 0001 — License text and Licensor

- **Date:** 2026-07-09
- **Status:** accepted
- **Resolves:** the ☐ canonical-license-text item and the ⚠ STOP Licensor-wording item from `docs/plan/07-NAME-AND-LICENSE.md`.

## Decision

1. **Licensor:** `PreservedTablet` — the GitHub organization that owns the repository. Maintainer's wording ("for now"); revisit if a business entity is formed, since whatever is named here is also the party the CONTRIBUTING.md CLA assigns rights to and the seller in any future dual-license deal. Notice line: `Copyright 2026 PreservedTablet`.
2. **License text:** fetched verbatim from the source of truth on 2026-07-09. Only the two Notice placeholders (`${year}`, `${licensor name}`) were filled; no other character changed.

## Drift found at fetch time (why the LICENSE says "FSL-1.1-ALv2")

The plan docs (researched 2026-07-08) refer to the license as **FSL-1.1-Apache-2.0**. As of fetch time, fsl.software has renamed that variant to **FSL-1.1-ALv2**: `https://fsl.software/FSL-1.1-Apache-2.0.template.md` now redirects to `https://fsl.software/FSL-1.1-ALv2.template.md`, whose title is "Functional Source License, Version 1.1, ALv2 Future License" and abbreviation `FSL-1.1-ALv2`.

The terms are unchanged — same grant, same Competing Use restriction, same irrevocable Apache License 2.0 grant on the second anniversary of each release. Only the identifier differs (consistent with Apache Software Foundation trademark policy on third-party license names).

**Resolution:** the committed `LICENSE` is the current canonical FSL-1.1-ALv2 text, per 07's instruction to use the source of truth and never paraphrase. The plain-English operational summary in `07` (and required on the README first screen) remains accurate as written. Where plan docs say "FSL-1.1-Apache-2.0", read "FSL-1.1-ALv2"; the plan docs themselves are left as authored.

## Also in this change

`docs/plan/03-DATA-MODEL.md`'s `audit_log` example actor was originally a personal first name; it was replaced with `'operator'` before first commit, per the no-personal-identifiers rule (06 CLAUDE.md draft; Phase 0 acceptance grep; threat T4 "every commit is forever"). This record states the fact without repeating the literal so the acceptance grep stays clean.
