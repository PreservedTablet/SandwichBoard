import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createOrgDb, type OrgDb } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { LocalFsStorage } from '../src/storage/local-fs.js';

/**
 * Integration tests for the creative-library API against a real Postgres.
 * TEST_DATABASE_URL must point at a disposable database (CI provides a
 * postgres service container; locally, docs/setup.md's dev database or any
 * scratch instance works). Skipped — loudly — when the variable is unset.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ORG = '00000000-0000-0000-0000-000000000000';

const PNG_1PX = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
	'base64'
);

describe.skipIf(!TEST_DATABASE_URL)('creative library API (integration)', () => {
	let app: FastifyInstance;
	let db: OrgDb;
	let storageDir: string;

	beforeAll(async () => {
		await runMigrations(TEST_DATABASE_URL!);
		db = createOrgDb(TEST_DATABASE_URL!, ORG);
		// The delete guard (migration 0002) protects non-draft combos even from
		// the owner role; demote leftovers from a previous run before wiping.
		await db.query(`update creatives set status = 'draft' where status <> 'draft'`);
		await db.query('delete from creatives');
		await db.query('delete from copy_variants');
		await db.query('delete from assets');
		await db.query('delete from settings');
		await db.query('delete from audit_log');
		storageDir = await mkdtemp(join(tmpdir(), 'sb-storage-'));
		app = buildApp({ logLevel: 'silent', deps: { db, storage: new LocalFsStorage(storageDir) } });
	});

	afterAll(async () => {
		await app?.close();
		await db?.end();
		if (storageDir) await rm(storageDir, { recursive: true, force: true });
	});

	// Shared fixtures created along the way.
	let assetId: string;
	let headlineId: string;
	let primaryTextId: string;
	let ctaId: string;
	let creativeId: string;
	let shortCode: string;

	describe('settings', () => {
		it('rejects an invalid naming prefix', async () => {
			const res = await app.inject({
				method: 'PUT',
				url: '/api/settings/naming_prefix',
				payload: { value: 'FWT!' }
			});
			expect(res.statusCode).toBe(400);
		});

		it('rejects keys outside the whitelist', async () => {
			const res = await app.inject({
				method: 'PUT',
				url: '/api/settings/random_key',
				payload: { value: 'x' }
			});
			expect(res.statusCode).toBe(400);
		});

		it('stores a valid prefix and lists it back', async () => {
			const put = await app.inject({
				method: 'PUT',
				url: '/api/settings/naming_prefix',
				payload: { value: 'fwt' }
			});
			expect(put.statusCode).toBe(200);
			expect(put.json().value).toBe('fwt');

			const list = await app.inject({ method: 'GET', url: '/api/settings' });
			expect(list.json().items).toMatchObject([{ key: 'naming_prefix', value: 'fwt' }]);
		});
	});

	describe('assets', () => {
		it('creates and lists with tag/kind filters', async () => {
			const created = await app.inject({
				method: 'POST',
				url: '/api/assets',
				payload: {
					kind: 'image',
					title: 'Porch drill still',
					tags: ['porch', 'drill', 'denver'],
					source: 'photo-shoot-jun26'
				}
			});
			expect(created.statusCode).toBe(201);
			assetId = created.json().id;

			await app.inject({
				method: 'POST',
				url: '/api/assets',
				payload: { kind: 'video', title: 'Ladder handoff brief', tags: ['ladder'] }
			});

			const byTag = await app.inject({ method: 'GET', url: '/api/assets?tag=porch&tag=drill' });
			expect(byTag.json().items).toHaveLength(1);
			expect(byTag.json().items[0].id).toBe(assetId);

			const byKind = await app.inject({ method: 'GET', url: '/api/assets?kind=video' });
			expect(byKind.json().items).toHaveLength(1);

			const byQ = await app.inject({ method: 'GET', url: '/api/assets?q=porch%20drill' });
			expect(byQ.json().items).toHaveLength(1);
		});

		it('rejects invalid payloads with issue paths', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/assets',
				payload: { kind: 'gif', title: '' }
			});
			expect(res.statusCode).toBe(400);
			expect(res.json().error).toBe('validation');
		});

		it('patches without clobbering absent fields', async () => {
			const res = await app.inject({
				method: 'PATCH',
				url: `/api/assets/${assetId}`,
				payload: { width: 1200, height: 1500 }
			});
			expect(res.statusCode).toBe(200);
			expect(res.json()).toMatchObject({ width: 1200, height: 1500, title: 'Porch drill still' });
			expect(res.json().tags).toEqual(['porch', 'drill', 'denver']);
		});

		it('uploads a file and serves it back only with a valid token', async () => {
			const up = await app.inject({
				method: 'PUT',
				url: `/api/assets/${assetId}/file`,
				payload: PNG_1PX,
				headers: { 'content-type': 'image/png', 'content-length': String(PNG_1PX.length) }
			});
			expect(up.statusCode).toBe(200);
			expect(up.json().storage_path).toBe(`assets/${assetId}/original.png`);
			expect(up.json().storage_content_type).toBe('image/png');

			const urlRes = await app.inject({ method: 'GET', url: `/api/assets/${assetId}/file-url` });
			expect(urlRes.statusCode).toBe(200);
			const { url } = urlRes.json();

			const file = await app.inject({ method: 'GET', url });
			expect(file.statusCode).toBe(200);
			expect(file.headers['content-type']).toBe('image/png');
			expect(file.headers['x-content-type-options']).toBe('nosniff');
			expect(file.rawPayload.equals(PNG_1PX)).toBe(true);

			const tampered = await app.inject({
				method: 'GET',
				url: url.replace(/sig=./, 'sig=!')
			});
			expect(tampered.statusCode).toBe(403);

			const expired = await app.inject({
				method: 'GET',
				url: url.replace(/exp=\d+/, 'exp=1000000000')
			});
			expect(expired.statusCode).toBe(403);
		});

		it('rejects unsupported upload content types', async () => {
			const res = await app.inject({
				method: 'PUT',
				url: `/api/assets/${assetId}/file`,
				payload: '<html></html>',
				headers: { 'content-type': 'text/html' }
			});
			expect(res.statusCode).toBe(415);
		});
	});

	describe('copy variants', () => {
		it('creates the pieces and filters by kind', async () => {
			const mk = async (kind: string, body: string) => {
				const res = await app.inject({
					method: 'POST',
					url: '/api/copy-variants',
					payload: { kind, body, angle: 'meet-neighbors', tags: ['circle'] }
				});
				expect(res.statusCode).toBe(201);
				return res.json();
			};
			const headline = await mk('headline', 'Borrow the drill. Meet the neighbors.');
			headlineId = headline.id;
			expect(headline.char_count).toBe('Borrow the drill. Meet the neighbors.'.length);
			primaryTextId = (
				await mk('primary_text', 'Every garage on your block has the tool you need.')
			).id;
			ctaId = (await mk('cta', 'Start your circle')).id;

			const headlines = await app.inject({
				method: 'GET',
				url: '/api/copy-variants?kind=headline'
			});
			expect(headlines.json().items).toHaveLength(1);
		});
	});

	describe('creatives (combos)', () => {
		it('creates a combo, DB assigns a 5-char base36 short_code, audit row written', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/creatives',
				payload: {
					asset_id: assetId,
					headline_id: headlineId,
					primary_text_id: primaryTextId,
					cta_id: ctaId,
					angle: 'meet-neighbors'
				}
			});
			expect(res.statusCode).toBe(201);
			const row = res.json();
			creativeId = row.id;
			shortCode = row.short_code;
			expect(shortCode).toMatch(/^[0-9a-z]{5}$/);
			expect(row.asset_title).toBe('Porch drill still');
			expect(row.headline_body).toContain('Borrow the drill');

			const audit = await db.query(
				`select action, payload from audit_log where subject_table = 'creatives' and subject_id = $1`,
				[creativeId]
			);
			expect(audit.rows.map((r) => r.action)).toContain('creative_created');
		});

		it('rejects an empty combo and mismatched component kinds', async () => {
			const empty = await app.inject({
				method: 'POST',
				url: '/api/creatives',
				payload: { angle: 'save-money' }
			});
			expect(empty.statusCode).toBe(400);

			const crossKind = await app.inject({
				method: 'POST',
				url: '/api/creatives',
				payload: { cta_id: headlineId }
			});
			expect(crossKind.statusCode).toBe(400);
			expect(crossKind.json().message).toMatch(/cta copy_variant/);
		});

		it('blocks deleting an asset referenced by a combo', async () => {
			const res = await app.inject({ method: 'DELETE', url: `/api/assets/${assetId}` });
			expect(res.statusCode).toBe(409);
		});

		it('PATCH may only touch bookkeeping; status changes are audited', async () => {
			const component = await app.inject({
				method: 'PATCH',
				url: `/api/creatives/${creativeId}`,
				payload: { headline_id: ctaId }
			});
			expect(component.statusCode).toBe(400);

			const status = await app.inject({
				method: 'PATCH',
				url: `/api/creatives/${creativeId}`,
				payload: { status: 'live', notes: 'launched in denver test' }
			});
			expect(status.statusCode).toBe(200);
			expect(status.json().status).toBe('live');

			const audit = await db.query(
				`select payload from audit_log
				 where subject_table = 'creatives' and subject_id = $1 and action = 'creative_status_changed'`,
				[creativeId]
			);
			expect(audit.rows[0]?.payload).toMatchObject({ from: 'draft', to: 'live' });
		});

		it('refuses to delete a live combo', async () => {
			const res = await app.inject({ method: 'DELETE', url: `/api/creatives/${creativeId}` });
			expect(res.statusCode).toBe(400);
			expect(res.json().message).toMatch(/only draft creatives/);
		});
	});

	describe('ad-name composition (the acceptance loop)', () => {
		it('composes prefix|campaign|code|vN, parses it back, and builds the UTM set', async () => {
			const res = await app.inject({
				method: 'GET',
				url: `/api/creatives/${creativeId}/ad-name?campaign_slug=denver-circle&version=2&platform=meta&medium=paid&base_url=${encodeURIComponent('https://friendswithtools.example/invite?ref=ad')}`
			});
			expect(res.statusCode).toBe(200);
			const body = res.json();
			expect(body.ad_name).toBe(`fwt|denver-circle|${shortCode}|v2`);
			expect(body.round_trip_ok).toBe(true);
			expect(body.parts).toEqual({
				prefix: 'fwt',
				campaignSlug: 'denver-circle',
				shortCode,
				version: 2
			});
			expect(body.utm_query).toBe(
				`utm_source=meta&utm_medium=paid&utm_campaign=denver-circle&utm_content=${shortCode}`
			);
			const url = new URL(body.url);
			expect(url.searchParams.get('ref')).toBe('ad');
			expect(url.searchParams.get('utm_content')).toBe(shortCode);
		});

		it('409s with guidance when the naming prefix is unset', async () => {
			await db.query('delete from settings where key = $1', ['naming_prefix']);
			const res = await app.inject({
				method: 'GET',
				url: `/api/creatives/${creativeId}/ad-name?campaign_slug=denver-circle`
			});
			expect(res.statusCode).toBe(409);
			expect(res.json().error).toBe('naming_prefix_not_set');
			await app.inject({
				method: 'PUT',
				url: '/api/settings/naming_prefix',
				payload: { value: 'fwt' }
			});
		});

		it('rejects an invalid campaign slug', async () => {
			const res = await app.inject({
				method: 'GET',
				url: `/api/creatives/${creativeId}/ad-name?campaign_slug=Denver%20Circle`
			});
			expect(res.statusCode).toBe(400);
		});
	});

	describe('v_unmatched_ads (acceptance)', () => {
		it('exists and is empty', async () => {
			const res = await db.query('select count(*)::int as n from v_unmatched_ads');
			expect(res.rows[0]).toEqual({ n: 0 });
		});
	});
});

describe.skipIf(TEST_DATABASE_URL)('creative library API', () => {
	it('is skipped because TEST_DATABASE_URL is unset', () => {
		expect(TEST_DATABASE_URL).toBeUndefined();
	});
});
