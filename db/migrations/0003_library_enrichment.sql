-- 0003_library_enrichment: the columns a tracker-replacing library needs
-- (docs/decisions/0004). Runner wraps each migration in a transaction.
--
-- assets gain a production lifecycle: the library holds planned work
-- (briefs, shot lists, reference frames) next to finished files, so the
-- operator's "what exists / what's pending" question is a filter, not a
-- separate spreadsheet. `ready` is the default because anything created by
-- uploading a file is already made; importers and brief entry set `planned`.
alter table assets
	add column production_status text not null default 'ready'
		check (production_status in ('planned', 'in_progress', 'ready', 'archived')),
	add column angle text,
	add column aspect_ratio text check (aspect_ratio ~ '^[0-9]+:[0-9]+$'),
	add column notes text,
	add column import_ref text,
	add column storage_sha256 text check (storage_sha256 ~ '^[0-9a-f]{64}$');

create index assets_org_production_status on assets (org_id, production_status);

-- Provenance + idempotency key for bulk imports: rows carried in from an
-- external system keep that system's identifier, and re-imports become
-- no-ops instead of duplicates.
create unique index assets_org_import_ref on assets (org_id, import_ref)
	where import_ref is not null;

alter table copy_variants
	add column notes text,
	add column import_ref text;

create unique index copy_variants_org_import_ref on copy_variants (org_id, import_ref)
	where import_ref is not null;

-- Where a combo points when launched: pairs with the UTM builder so the
-- tagged destination is one click, and keeps landing strategy queryable.
alter table creatives
	add column landing_path text check (landing_path ~ '^(/|https?://)');
