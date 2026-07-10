import { SETTINGS_KEY_NAMING_PREFIX, isValidPrefix } from '@sandwichboard/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RouteDeps } from './shared.js';

/**
 * Org settings live as data in the `settings` table (docs/plan/03): the
 * naming prefix, later the evidence-gate thresholds. Writable keys are
 * whitelisted with per-key validation — this is configuration-as-data, not
 * a generic KV store.
 */
const WRITABLE_KEYS: Record<string, (value: unknown) => string | null> = {
	[SETTINGS_KEY_NAMING_PREFIX]: (value) =>
		typeof value === 'string' && isValidPrefix(value)
			? null
			: 'must be 1-16 lowercase alphanumeric/hyphen characters, e.g. "fwt"'
};

const putBodySchema = z.object({ value: z.unknown() });
const keyParamSchema = z.object({
	key: z.enum(Object.keys(WRITABLE_KEYS) as [string, ...string[]])
});

export function registerSettingsRoutes(app: FastifyInstance, deps: RouteDeps): void {
	const { db } = deps;

	app.get('/api/settings', async () => {
		const { rows } = await db.query(
			'select key, value, updated_at from settings where org_id = $1 order by key',
			[db.orgId]
		);
		return { items: rows };
	});

	app.put('/api/settings/:key', async (request, reply) => {
		const { key } = keyParamSchema.parse(request.params);
		const { value } = putBodySchema.parse(request.body);
		const problem = WRITABLE_KEYS[key]!(value);
		if (problem) {
			return reply.status(400).send({ error: 'invalid_setting', message: `${key}: ${problem}` });
		}
		const { rows } = await db.query(
			`insert into settings (org_id, key, value) values ($1, $2, $3)
			 on conflict (org_id, key) do update set value = excluded.value
			 returning key, value, updated_at`,
			[db.orgId, key, JSON.stringify(value)]
		);
		return rows[0];
	});
}
