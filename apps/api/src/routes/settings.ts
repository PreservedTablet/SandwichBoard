import {
	SETTINGS_KEY_GATE_MIN_IMPRESSIONS,
	SETTINGS_KEY_GATE_MIN_SPEND_CENTS,
	SETTINGS_KEY_META_CONVERSION_ACTION_TYPES,
	SETTINGS_KEY_NAMING_PREFIX,
	isValidPrefix
} from '@sandwichboard/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../lib/audit.js';
import type { RouteDeps } from './shared.js';

/**
 * Org settings live as data in the `settings` table (docs/plan/03): the
 * naming prefix, the evidence-gate thresholds, the Meta conversion mapping.
 * Writable keys are whitelisted with per-key validation — this is
 * configuration-as-data, not a generic KV store.
 */

const gateThreshold = z.number().int().min(0).max(1_000_000_000);
const actionTypes = z.array(z.string().trim().min(1).max(200)).max(50);

const WRITABLE_KEYS: Record<string, (value: unknown) => string | null> = {
	[SETTINGS_KEY_NAMING_PREFIX]: (value) =>
		typeof value === 'string' && isValidPrefix(value)
			? null
			: 'must be 1-16 lowercase alphanumeric/hyphen characters, e.g. "fwt"',
	// Evidence gate (docs/plan/01): tunable thresholds, never magic numbers.
	// The leaderboard view falls back to 2500 / 1000 when these are unset.
	[SETTINGS_KEY_GATE_MIN_SPEND_CENTS]: (value) =>
		gateThreshold.safeParse(value).success
			? null
			: 'must be a non-negative integer number of cents, e.g. 2500',
	[SETTINGS_KEY_GATE_MIN_IMPRESSIONS]: (value) =>
		gateThreshold.safeParse(value).success
			? null
			: 'must be a non-negative integer impression count, e.g. 1000',
	// Which Meta Insights action_types count as a conversion — depends on
	// the operator's Pixel setup (docs/decisions/0005). Unset ⇒ conversions
	// ingest as 0 while metric_snapshots.raw keeps every action.
	[SETTINGS_KEY_META_CONVERSION_ACTION_TYPES]: (value) =>
		actionTypes.safeParse(value).success
			? null
			: 'must be an array of action_type strings, e.g. ["offsite_conversion.fb_pixel_lead"]'
};

const putBodySchema = z.object({ value: z.unknown() });
const keyParamSchema = z.object({
	key: z.enum(Object.keys(WRITABLE_KEYS) as [string, ...string[]])
});

export function registerSettingsRoutes(app: FastifyInstance, deps: RouteDeps): void {
	const { db, actor } = deps;

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
		// Audited like every decision-affecting change (CLAUDE.md): the
		// prefix is the metrics join key and the conversion mapping changes
		// what counts as a conversion — silent edits would make historical
		// numbers unexplainable.
		return db.tx(async (client) => {
			const before = await client.query<{ value: unknown }>(
				'select value from settings where org_id = $1 and key = $2',
				[db.orgId, key]
			);
			const { rows } = await client.query(
				`insert into settings (org_id, key, value) values ($1, $2, $3)
				 on conflict (org_id, key) do update set value = excluded.value
				 returning key, value, updated_at`,
				[db.orgId, key, JSON.stringify(value)]
			);
			await writeAudit(client, {
				orgId: db.orgId,
				actor,
				action: 'setting_changed',
				subjectTable: 'settings',
				payload: { key, from: before.rows[0]?.value ?? null, to: value }
			});
			return rows[0];
		});
	});
}
