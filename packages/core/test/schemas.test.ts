import { describe, expect, it } from 'vitest';
import {
	assetCreateSchema,
	assetUpdateSchema,
	copyVariantCreateSchema,
	creativeCreateSchema,
	creativeUpdateSchema
} from '../src/schemas.js';

describe('assetCreateSchema', () => {
	it('applies defaults and trims', () => {
		const parsed = assetCreateSchema.parse({ kind: 'image', title: '  Porch drill still  ' });
		expect(parsed.tags).toEqual([]);
		expect(parsed.title).toBe('Porch drill still');
	});

	it('rejects unknown kinds and non-http external urls', () => {
		expect(assetCreateSchema.safeParse({ kind: 'gif', title: 'x' }).success).toBe(false);
		expect(
			assetCreateSchema.safeParse({ kind: 'image', title: 'x', external_url: 'ftp://a.example/f' })
				.success
		).toBe(false);
	});
});

describe('assetUpdateSchema', () => {
	it('rejects an empty patch', () => {
		expect(assetUpdateSchema.safeParse({}).success).toBe(false);
	});

	it('does not invent defaults for absent keys', () => {
		const parsed = assetUpdateSchema.parse({ title: 'New title' });
		expect(Object.keys(parsed)).toEqual(['title']);
	});

	it('allows explicit nulls to clear optional fields', () => {
		expect(assetUpdateSchema.parse({ source: null })).toEqual({ source: null });
	});
});

describe('copyVariantCreateSchema', () => {
	it('requires a non-empty body', () => {
		expect(copyVariantCreateSchema.safeParse({ kind: 'headline', body: '   ' }).success).toBe(
			false
		);
	});
});

describe('creativeCreateSchema', () => {
	const id = '3b1c8a52-0000-4000-8000-000000000001';

	it('accepts any single component and defaults status to draft', () => {
		const parsed = creativeCreateSchema.parse({ headline_id: id });
		expect(parsed.status).toBe('draft');
	});

	it('rejects an empty combo', () => {
		const result = creativeCreateSchema.safeParse({ angle: 'save-money' });
		expect(result.success).toBe(false);
	});
});

describe('creativeUpdateSchema', () => {
	it('permits only bookkeeping fields', () => {
		expect(creativeUpdateSchema.safeParse({ status: 'live' }).success).toBe(true);
		expect(
			creativeUpdateSchema.safeParse({ headline_id: '3b1c8a52-0000-4000-8000-000000000001' })
				.success
		).toBe(false);
		expect(creativeUpdateSchema.safeParse({}).success).toBe(false);
	});
});
