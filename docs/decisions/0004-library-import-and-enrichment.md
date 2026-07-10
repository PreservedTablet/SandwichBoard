# 0004 — Library import path and schema enrichment

Date: 2026-07-10. Scope: closing Phase 1's ⚠ STOP (seed import) after the
maintainer supplied their production-tracker export, and the schema
additions that came out of studying it.

## The portability decision

The maintainer's export turned out to be a **production tracker** (mostly
planned, not-yet-made assets), built by an earlier tool they explicitly do
not want this project modeled on — and they flagged that an importer wired
to that spreadsheet's headers would make SandwichBoard _less_ portable.
Agreed. Resolution:

- The repo ships **`pnpm import:library`**, a generic importer for
  SandwichBoard's own documented exchange format
  (`docs/import-format.md`): plain CSVs whose columns are the library's own
  fields. Any adopter reshapes whatever they are leaving behind into that
  format once. Validation is all-or-nothing with `file:line` errors, all
  writes are one transaction, re-runs are idempotent (skip by `import_ref`
  or by identical content), `--dry-run` previews, every run writes an
  `audit_log` row.
- Converting the maintainer's specific tracker into the exchange format was
  done **outside the repo** as a one-time session task; the reviewed output
  CSVs live in gitignored/local space (suggested `data/import/`) and were
  handed back to the maintainer to re-run at home. No legacy tracker's
  vocabulary, headers, or content exists anywhere in the tree — also a hard
  requirement because the export contains operator-identifying content that
  must never reach a public repo.
- The tiny RFC 4180 CSV reader is hand-rolled (~60 lines + tests) rather
  than a dependency; the dialect is ours, so we control it.

## Schema enrichment (migration 0003)

Studying the real inventory showed what the draft DDL (docs/plan/03)
missed for a library that _replaces_ a production tracker:

1. **`assets.production_status`** (`planned | in_progress | ready |
archived`, default `ready`) — the library now holds briefs, shot lists,
   and reference frames next to finished files, so "what exists vs what's
   pending" is a filter chip with counts, not a second spreadsheet. This is
   the tracker's core function, absorbed.
2. **`assets.angle`**, **`assets.aspect_ratio`**, **`assets.notes`** —
   strategy angle parity with copy/creatives; placement geometry (`4:5`,
   `9:16`) as a queryable fact; briefs/hooks/production details in notes.
3. **`assets.import_ref` / `copy_variants.import_ref`** (partial unique per
   org) — provenance from any prior system and the idempotency key for
   re-imports. Settable at create/import; never via PATCH.
4. **`assets.storage_sha256`** — computed while streaming uploads; enables
   "do I already have this file?" dedupe across a messy collection.
5. **`copy_variants.notes`** — parity.
6. **`creatives.landing_path`** — where a combo points when launched
   (`/path` or full URL); a full URL pre-fills the UTM panel's destination.
   Complements Phase 2's campaign-level targeting.

Deliberately _not_ added: a `role` enum for character-refs/b-roll (tags
like `character-ref`, `b-roll` already model arbitrary facets and stay
operator-defined); width/height auto-extraction (would need a media
dependency for marginal gain).

## Conversion mapping (recorded for reproducibility)

Applied in-session to the tracker export; the durable artifacts are the
reviewed exchange-format CSVs, not this mapping:

- Stills / character refs / b-roll frames → `image`; videos / b-roll clips
  → `video`. Tracker status → `planned`/`in_progress`/`ready`.
- Letter angles → words: A→`cost`, B→`new-homeowner`, C→`privacy`,
  D→`local-seasonal`, plus `lender`, `brand-trust`, `search`; multi-letter
  cells take the first, raw value preserved in notes.
- Wave/Season → tags (`evergreen`, `spring`, `local`, …); concrete
  city landing paths → city tags; every row tagged `tracker-import`.
- Overlay/hook text → deduped `tagline` copy variants (16 from 17
  candidates); placeholders ("(text in image)", "Avatar narration", "See
  …") excluded. Landing targets, unparseable formats/lengths, cross-refs,
  and tracker notes preserved verbatim in `notes`.
- Rows whose copy lives in other sheets (Meta ad copy angles, the Google
  RSA, organic scripts, community post) were **skipped with reasons** — the
  plan's "RSA copy" expectation is still open until that text is supplied
  as real copy rows or pasted via the UI.
- One personal-name parenthetical was dropped from a video title during
  conversion (CLAUDE.md: no personal names).

## Phase 1 ⚠ STOP — closed

Import demonstrated against the real inventory: 40 assets + 16 taglines
created, dry-run rolled back cleanly, immediate re-run skipped all 56 rows
(idempotent), audit rows written, library UI renders the imported
collection with production-status counts. The 0003 STOP disposition is
superseded by this entry.
