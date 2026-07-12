import { describe, expect, it } from 'vitest';
import { configReadiness } from '../src/config.js';

const byFeature = (env: NodeJS.ProcessEnv) =>
	new Map(configReadiness(env).map((f) => [f.feature, f]));

describe('configReadiness', () => {
	it('reports the bare minimum: database required, optional features quiet', () => {
		const features = byFeature({ DATABASE_URL: 'postgres://x@localhost/db' });
		expect(features.get('core api + database')!.status).toBe('ready');
		expect(features.get('storage (local-fs)')!.status).toBe('ready');
		expect(features.get('meta ingestion (Phase 2)')!.status).toBe('not_configured');
		expect(features.get('postiz publishing (Phase 5)')!.status).toBe('not_configured');
	});

	it('flags the missing database by name', () => {
		const core = byFeature({}).get('core api + database')!;
		expect(core.status).toBe('incomplete');
		expect(core.missing).toEqual(['DATABASE_URL']);
	});

	it('distinguishes partially configured features and names what is missing', () => {
		const features = byFeature({
			DATABASE_URL: 'postgres://x@localhost/db',
			META_SYSTEM_USER_TOKEN: 'FAKE'
		});
		const meta = features.get('meta ingestion (Phase 2)')!;
		expect(meta.status).toBe('incomplete');
		expect(meta.missing).toEqual(['META_AD_ACCOUNT_ID']);
	});

	it('checks driver-specific storage variables', () => {
		const s3 = byFeature({
			DATABASE_URL: 'postgres://x@localhost/db',
			STORAGE_DRIVER: 's3',
			S3_ENDPOINT: 'http://localhost:9000',
			S3_BUCKET: 'b'
		}).get('storage (s3)')!;
		expect(s3.status).toBe('incomplete');
		expect(s3.missing).toEqual(['S3_ACCESS_KEY', 'S3_SECRET_KEY']);
	});

	it('never includes values — names only', () => {
		const features = configReadiness({
			DATABASE_URL: 'postgres://secret-host/db',
			META_SYSTEM_USER_TOKEN: 'SUPER_SECRET_VALUE'
		});
		const serialized = JSON.stringify(features);
		expect(serialized).not.toContain('SUPER_SECRET_VALUE');
		expect(serialized).not.toContain('secret-host');
	});
});
