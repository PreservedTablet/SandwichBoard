import { z } from 'zod';

/**
 * Shared row + payload contracts for the creative library (docs/plan/02:
 * packages/core is "the single definition of every table row"). Row schemas
 * describe what the API serves (timestamps as ISO strings); create/update
 * schemas validate what clients send — zod at every boundary.
 *
 * Update schemas are written without defaults on purpose: a `.partial()` of
 * a defaulted field would silently reset absent keys on every PATCH.
 */

export const assetKinds = ['image', 'video', 'overlay_template'] as const;
export type AssetKind = (typeof assetKinds)[number];

export const copyVariantKinds = [
	'headline',
	'primary_text',
	'tagline',
	'description',
	'cta'
] as const;
export type CopyVariantKind = (typeof copyVariantKinds)[number];

export const creativeStatuses = ['draft', 'live', 'retired'] as const;
export type CreativeStatus = (typeof creativeStatuses)[number];

/**
 * Production lifecycle of an asset: the library holds planned work (briefs,
 * shot lists, reference frames) next to finished files, replacing any
 * separate production tracker. `ready` = the thing exists (even if its file
 * is not uploaded here yet); `planned`/`in_progress` = still being made.
 */
export const assetProductionStatuses = ['planned', 'in_progress', 'ready', 'archived'] as const;
export type AssetProductionStatus = (typeof assetProductionStatuses)[number];

const uuid = z.uuid();
const isoTimestamp = z.iso.datetime({ offset: true });
const tagList = z.array(z.string().trim().min(1).max(64)).max(32);
const title = z.string().trim().min(1).max(200);
const httpUrl = z.url({ protocol: /^https?$/ }).max(2048);
const angle = z.string().trim().min(1).max(100);
const notes = z.string().trim().min(1).max(5000);
const aspectRatio = z
	.string()
	.regex(/^\d+:\d+$/, 'aspect ratio must look like 4:5 or 9:16')
	.max(11);
/** Stable identifier from an external system (docs/import-format.md). */
const importRef = z.string().trim().min(1).max(100);
const landingPath = z
	.string()
	.trim()
	.regex(/^(\/|https?:\/\/)/, 'must be a /path or full http(s) URL')
	.max(300);

// ---------------------------------------------------------------------------
// assets
// ---------------------------------------------------------------------------
export const assetRowSchema = z.object({
	id: uuid,
	org_id: uuid,
	kind: z.enum(assetKinds),
	title,
	production_status: z.enum(assetProductionStatuses),
	storage_path: z.string().nullable(),
	storage_content_type: z.string().nullable(),
	storage_sha256: z.string().nullable(),
	external_url: z.string().nullable(),
	width: z.number().int().nullable(),
	height: z.number().int().nullable(),
	duration_s: z.number().nullable(),
	aspect_ratio: z.string().nullable(),
	angle: z.string().nullable(),
	tags: z.array(z.string()),
	source: z.string().nullable(),
	notes: z.string().nullable(),
	import_ref: z.string().nullable(),
	created_at: isoTimestamp,
	updated_at: isoTimestamp
});
export type AssetRow = z.infer<typeof assetRowSchema>;

export const assetCreateSchema = z.object({
	kind: z.enum(assetKinds),
	title,
	production_status: z.enum(assetProductionStatuses).default('ready'),
	external_url: httpUrl.optional(),
	width: z.number().int().positive().optional(),
	height: z.number().int().positive().optional(),
	duration_s: z.number().positive().optional(),
	aspect_ratio: aspectRatio.optional(),
	angle: angle.optional(),
	tags: tagList.default([]),
	source: z.string().trim().min(1).max(100).optional(),
	notes: notes.optional(),
	import_ref: importRef.optional()
});
export type AssetCreate = z.infer<typeof assetCreateSchema>;

// import_ref is provenance — settable at creation/import, not by PATCH.
export const assetUpdateSchema = z
	.object({
		kind: z.enum(assetKinds),
		title,
		production_status: z.enum(assetProductionStatuses),
		external_url: httpUrl.nullable(),
		width: z.number().int().positive().nullable(),
		height: z.number().int().positive().nullable(),
		duration_s: z.number().positive().nullable(),
		aspect_ratio: aspectRatio.nullable(),
		angle: angle.nullable(),
		tags: tagList,
		source: z.string().trim().min(1).max(100).nullable(),
		notes: notes.nullable()
	})
	.partial()
	.refine((patch) => Object.keys(patch).length > 0, {
		message: 'update must change at least one field'
	});
export type AssetUpdate = z.infer<typeof assetUpdateSchema>;

// ---------------------------------------------------------------------------
// copy_variants
// ---------------------------------------------------------------------------
export const copyVariantRowSchema = z.object({
	id: uuid,
	org_id: uuid,
	kind: z.enum(copyVariantKinds),
	body: z.string(),
	angle: z.string().nullable(),
	tone: z.string().nullable(),
	char_count: z.number().int(),
	tags: z.array(z.string()),
	notes: z.string().nullable(),
	import_ref: z.string().nullable(),
	created_at: isoTimestamp,
	updated_at: isoTimestamp
});
export type CopyVariantRow = z.infer<typeof copyVariantRowSchema>;

export const copyVariantCreateSchema = z.object({
	kind: z.enum(copyVariantKinds),
	body: z.string().trim().min(1).max(5000),
	angle: angle.optional(),
	tone: z.string().trim().min(1).max(100).optional(),
	tags: tagList.default([]),
	notes: notes.optional(),
	import_ref: importRef.optional()
});
export type CopyVariantCreate = z.infer<typeof copyVariantCreateSchema>;

export const copyVariantUpdateSchema = z
	.object({
		kind: z.enum(copyVariantKinds),
		body: z.string().trim().min(1).max(5000),
		angle: angle.nullable(),
		tone: z.string().trim().min(1).max(100).nullable(),
		tags: tagList,
		notes: notes.nullable()
	})
	.partial()
	.refine((patch) => Object.keys(patch).length > 0, {
		message: 'update must change at least one field'
	});
export type CopyVariantUpdate = z.infer<typeof copyVariantUpdateSchema>;

// ---------------------------------------------------------------------------
// creatives — a tested asset × copy combination
// ---------------------------------------------------------------------------
export const creativeRowSchema = z.object({
	id: uuid,
	org_id: uuid,
	short_code: z.string(),
	asset_id: uuid.nullable(),
	headline_id: uuid.nullable(),
	primary_text_id: uuid.nullable(),
	cta_id: uuid.nullable(),
	angle: z.string().nullable(),
	status: z.enum(creativeStatuses),
	landing_path: z.string().nullable(),
	notes: z.string().nullable(),
	created_at: isoTimestamp,
	updated_at: isoTimestamp
});
export type CreativeRow = z.infer<typeof creativeRowSchema>;

export const creativeCreateSchema = z
	.object({
		asset_id: uuid.optional(),
		headline_id: uuid.optional(),
		primary_text_id: uuid.optional(),
		cta_id: uuid.optional(),
		angle: angle.optional(),
		landing_path: landingPath.optional(),
		notes: z.string().trim().min(1).max(2000).optional(),
		status: z.enum(creativeStatuses).default('draft')
	})
	.refine((combo) => combo.asset_id || combo.headline_id || combo.primary_text_id || combo.cta_id, {
		message: 'a combo needs at least one component (asset or copy piece)'
	});
export type CreativeCreate = z.infer<typeof creativeCreateSchema>;

/** List/detail shape the API serves: creative row + joined component summaries. */
export const creativeListItemSchema = creativeRowSchema.extend({
	asset_title: z.string().nullable(),
	asset_kind: z.enum(assetKinds).nullable(),
	asset_storage_path: z.string().nullable(),
	headline_body: z.string().nullable(),
	primary_text_body: z.string().nullable(),
	cta_body: z.string().nullable()
});
export type CreativeListItem = z.infer<typeof creativeListItemSchema>;

// Components and short_code are immutable (migration 0002 enforces it in the
// database); a PATCH may only touch bookkeeping.
export const creativeUpdateSchema = z
	.object({
		angle: angle.nullable(),
		landing_path: landingPath.nullable(),
		notes: z.string().trim().min(1).max(2000).nullable(),
		status: z.enum(creativeStatuses)
	})
	.partial()
	.refine((patch) => Object.keys(patch).length > 0, {
		message: 'update must change at least one field'
	});
export type CreativeUpdate = z.infer<typeof creativeUpdateSchema>;
