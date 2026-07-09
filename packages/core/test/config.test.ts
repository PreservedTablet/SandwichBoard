import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, redactedConfigSummary } from '../src/config.js';

const minimalEnv = {
	DATABASE_URL: 'postgres://app:hunter2@localhost:5432/sandwichboard'
};

describe('loadConfig', () => {
	it('loads with only DATABASE_URL set and applies defaults', () => {
		const cfg = loadConfig({ ...minimalEnv });
		expect(cfg.NODE_ENV).toBe('development');
		expect(cfg.API_HOST).toBe('127.0.0.1');
		expect(cfg.API_PORT).toBe(3000);
		expect(cfg.STORAGE_DRIVER).toBe('local-fs');
		expect(cfg.STORAGE_LOCAL_PATH).toBe('data/storage');
	});

	it('coerces API_PORT from string', () => {
		const cfg = loadConfig({ ...minimalEnv, API_PORT: '4100' });
		expect(cfg.API_PORT).toBe(4100);
	});

	it('rejects a missing DATABASE_URL and names the variable', () => {
		expect(() => loadConfig({})).toThrowError(ConfigError);
		expect(() => loadConfig({})).toThrowError(/DATABASE_URL/);
	});

	it('rejects a non-postgres DATABASE_URL', () => {
		expect(() => loadConfig({ DATABASE_URL: 'mysql://nope:3306/x' })).toThrowError(/postgres:\/\//);
	});

	it('never echoes provided values in error messages', () => {
		const secretValue = 'super-secret-value-abc123';
		try {
			loadConfig({ DATABASE_URL: secretValue, POSTIZ_API_KEY: secretValue });
			expect.unreachable('should have thrown');
		} catch (err) {
			expect(String(err)).not.toContain(secretValue);
		}
	});

	it('requires S3 settings when STORAGE_DRIVER=s3', () => {
		expect(() => loadConfig({ ...minimalEnv, STORAGE_DRIVER: 's3' })).toThrowError(/S3_BUCKET/);
	});

	it('requires Supabase settings when STORAGE_DRIVER=supabase-storage', () => {
		expect(() => loadConfig({ ...minimalEnv, STORAGE_DRIVER: 'supabase-storage' })).toThrowError(
			/SUPABASE_SERVICE_ROLE_KEY/
		);
	});

	it('accepts a fully-specified s3 configuration', () => {
		const cfg = loadConfig({
			...minimalEnv,
			STORAGE_DRIVER: 's3',
			S3_ENDPOINT: 'http://localhost:9000',
			S3_BUCKET: 'sandwichboard',
			S3_ACCESS_KEY: 'minio',
			S3_SECRET_KEY: 'minio-secret'
		});
		expect(cfg.STORAGE_DRIVER).toBe('s3');
	});
});

describe('redactedConfigSummary', () => {
	it('reports presence without leaking secret values', () => {
		const cfg = loadConfig({
			...minimalEnv,
			POSTIZ_BASE_URL: 'http://localhost:5000',
			POSTIZ_API_KEY: 'postiz-key-value',
			INBOUND_CAPTURE_SECRET: 'capture-secret-value'
		});
		const summary = redactedConfigSummary(cfg);
		const rendered = JSON.stringify(summary);
		expect(rendered).not.toContain('hunter2');
		expect(rendered).not.toContain('postiz-key-value');
		expect(rendered).not.toContain('capture-secret-value');
		expect(summary.DATABASE_URL).toContain('host: localhost');
		expect(summary.POSTIZ_API_KEY).toBe('set');
		expect(summary.INBOUND_CAPTURE_SECRET).toBe('set');
	});
});
