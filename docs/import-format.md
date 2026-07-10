# Library import format

`pnpm import:library <file.csv> [more.csv…] [--dry-run]` bulk-loads the
creative library from CSVs in SandwichBoard's **own** exchange format. This
is the portable on-ramp from whatever spreadsheet you are leaving behind:
reshape your data into these columns once (by hand, with a throwaway script,
or by asking your AI session to do it), review the result, import. The
importer deliberately knows nothing about any other tool's layout — legacy
trackers get converted _to_ this format, never wired _into_ the codebase.

Suggested location for import files: `data/import/` — the whole `data/`
tree is gitignored, so operator content never lands in the public repo.
Relative paths resolve from the repo root. Use `:local` scripts with a
`.env` fallback (`pnpm import:library:local …`), or Infisical injection as
usual: `infisical run --env=dev --path=/api -- pnpm import:library …`.

## Rules

- First row is the header. Column order is free; unknown columns are
  ignored; header names are case-insensitive.
- A file with a `body` column imports **copy variants**; a file with a
  `title` column imports **assets**. One entity type per file.
- Standard CSV quoting (RFC 4180): quote fields containing commas, quotes,
  or newlines; escape quotes by doubling (`""`).
- Every row is validated before anything is written; any invalid row aborts
  the entire run with `file:line` errors. All writes happen in a single
  transaction.
- **Idempotent:** a row whose `import_ref` already exists is skipped, as is
  an identical row (same kind + title for assets, same kind + body for
  copy). Re-running an import never duplicates and never overwrites edits
  made in the app. `--dry-run` executes fully, reports, and rolls back.
- Each run writes one `audit_log` row (`library_imported`) with counts.

## Asset files

| Column              | Required | Values                                                                                    |
| ------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `kind`              | yes      | `image` \| `video` \| `overlay_template`                                                  |
| `title`             | yes      | up to 200 chars                                                                           |
| `production_status` | no       | `planned` \| `in_progress` \| `ready` \| `archived` (default `ready`)                     |
| `angle`             | no       | strategy angle, e.g. `cost`, `new-homeowner`, `privacy`, `local-seasonal`, `lender`       |
| `aspect_ratio`      | no       | `4:5`, `9:16`, `1:1`, …                                                                   |
| `width`, `height`   | no       | pixels (integers)                                                                         |
| `duration_s`        | no       | seconds (number)                                                                          |
| `tags`              | no       | comma-separated inside one (quoted) cell, e.g. `"spring, denver, b-roll"`                 |
| `source`            | no       | where it comes from / how it's made, e.g. `photo-shoot-jun26`, a generation-tool pipeline |
| `external_url`      | no       | http(s) URL when the file lives elsewhere; upload files through the UI after import       |
| `notes`             | no       | free text — briefs, hooks, production details                                             |
| `import_ref`        | no       | stable ID from the previous system; enables idempotent re-import and provenance           |

## Copy files

| Column       | Required | Values                                                              |
| ------------ | -------- | ------------------------------------------------------------------- |
| `kind`       | yes      | `headline` \| `primary_text` \| `tagline` \| `description` \| `cta` |
| `body`       | yes      | the copy text itself (not a pointer to it), up to 5000 chars        |
| `angle`      | no       | as above                                                            |
| `tone`       | no       | e.g. `practical`, `warm`, `funny`                                   |
| `tags`       | no       | as above                                                            |
| `notes`      | no       | free text                                                           |
| `import_ref` | no       | as above                                                            |

## Example

`data/import/assets.csv`:

```csv
import_ref,kind,title,production_status,angle,aspect_ratio,tags,source,notes
EX-01,image,Porch drill still,ready,cost,4:5,"porch, drill, evergreen",photo-shoot-jun26,
EX-02,video,Split-screen concept,planned,cost,9:16,"evergreen",gen-pipeline,"Brief: old way vs neighbor's way"
```

`data/import/copy.csv`:

```csv
import_ref,kind,body,angle,tags
EX-01:hook,tagline,You bought it for one project.,cost,"evergreen"
,cta,Start your circle,,
```
