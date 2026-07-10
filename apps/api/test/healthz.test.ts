import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('GET /healthz', () => {
	it('responds ok without touching configuration or the database', async () => {
		const app = buildApp({ logLevel: 'silent' });
		const res = await app.inject({ method: 'GET', url: '/healthz' });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.ok).toBe(true);
		expect(body.service).toBe('sandwichboard-api');
		await app.close();
	});
});
