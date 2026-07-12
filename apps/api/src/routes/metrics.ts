import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../lib/audit.js';
import { pageSchema, uuidParamSchema, type RouteDeps } from './shared.js';

/**
 * Read endpoints over the metrics spine (docs/plan/06 Phase 2 Session 2b):
 * the evidence-gated leaderboard, daily series for sparklines, and the two
 * problem lists (unmatched ads, deadletters). All numbers come straight
 * from the views/tables — the API adds filtering, never arithmetic.
 */

const platformFilterSchema = z.object({
	// 'all' selects the leaderboard's cross-platform rollup rows.
	platform: z.enum(['all', 'meta', 'google', 'tiktok', 'reddit_ads']).default('all')
});

const dailyQuerySchema = platformFilterSchema.extend({
	days: z.coerce.number().int().min(1).max(365).default(30)
});

const deadletterListSchema = z.object({
	resolved: z
		.enum(['true', 'false'])
		.default('false')
		.transform((v) => v === 'true'),
	...pageSchema
});

const deadletterPatchSchema = z.object({ resolved: z.boolean() });

export function registerMetricsRoutes(app: FastifyInstance, deps: RouteDeps): void {
	const { db, actor } = deps;

	app.get('/api/metrics/leaderboard', async (request) => {
		const { platform } = platformFilterSchema.parse(request.query);
		return db.tx(async (client) => {
			const { rows } = await client.query(
				`select creative_id, short_code, creative_status, angle, platform,
				        ad_count::int as ad_count, days_with_delivery::int as days_with_delivery,
				        to_char(first_date, 'YYYY-MM-DD') as first_date,
				        to_char(last_date, 'YYYY-MM-DD') as last_date,
				        spend_cents::bigint::int as spend_cents, impressions::bigint::int as impressions,
				        clicks::bigint::int as clicks, conversions::float8 as conversions,
				        conversion_value_cents::int as conversion_value_cents,
				        ctr::float8 as ctr, cpc_cents::float8 as cpc_cents, cpm_cents::float8 as cpm_cents,
				        cpa_cents::float8 as cpa_cents
				 from v_combo_leaderboard
				 where org_id = $1 and platform = $2
				 order by spend_cents desc, short_code`,
				[db.orgId, platform]
			);
			// "Insufficient data" is a first-class conclusion (docs/plan/01):
			// say how many combos have delivery but sit below the gate.
			const withData = await client.query<{ n: number }>(
				platform === 'all'
					? `select count(distinct creative_id)::int as n from v_combo_daily where org_id = $1`
					: `select count(distinct creative_id)::int as n from v_combo_daily where org_id = $1 and platform = $2`,
				platform === 'all' ? [db.orgId] : [db.orgId, platform]
			);
			return {
				platform,
				items: rows,
				combos_below_gate: Math.max(0, withData.rows[0]!.n - rows.length)
			};
		});
	});

	// Daily series for the leaderboard sparklines (spend/CTR, last N days).
	app.get('/api/metrics/daily', async (request) => {
		const { platform, days } = dailyQuerySchema.parse(request.query);
		const { rows } =
			platform === 'all'
				? await db.query(
						`select creative_id, to_char(date, 'YYYY-MM-DD') as date,
						        sum(spend_cents)::bigint::int as spend_cents,
						        sum(impressions)::bigint::int as impressions,
						        sum(clicks)::bigint::int as clicks
						 from v_combo_daily
						 where org_id = $1 and date > current_date - ($2 || ' days')::interval
						 group by creative_id, date order by creative_id, date`,
						[db.orgId, days]
					)
				: await db.query(
						`select creative_id, to_char(date, 'YYYY-MM-DD') as date,
						        spend_cents::bigint::int as spend_cents,
						        impressions::bigint::int as impressions,
						        clicks::bigint::int as clicks
						 from v_combo_daily
						 where org_id = $1 and platform = $2 and date > current_date - ($3 || ' days')::interval
						 order by creative_id, date`,
						[db.orgId, platform, days]
					);
		return { platform, days, items: rows };
	});

	app.get('/api/metrics/unmatched', async () => {
		const { rows } = await db.query(
			`select ad_entity_id, platform, external_ad_id, ad_name,
			        to_char(first_seen, 'YYYY-MM-DD') as first_seen,
			        match_failure_code, match_failure_reason, account_label, campaign_name
			 from v_unmatched_ads where org_id = $1
			 order by first_seen desc, external_ad_id`,
			[db.orgId]
		);
		return { items: rows };
	});

	app.get('/api/metrics/deadletters', async (request) => {
		const query = deadletterListSchema.parse(request.query);
		const { rows } = await db.query(
			`select id, platform, payload, error, created_at, resolved
			 from ingest_deadletter
			 where org_id = $1 and resolved = $2
			 order by created_at desc limit $3 offset $4`,
			[db.orgId, query.resolved, query.limit, query.offset]
		);
		return { items: rows };
	});

	app.patch('/api/metrics/deadletters/:id', async (request, reply) => {
		const { id } = uuidParamSchema.parse(request.params);
		const { resolved } = deadletterPatchSchema.parse(request.body);
		const updated = await db.tx(async (client) => {
			const { rows } = await client.query<{ id: string; resolved: boolean }>(
				`update ingest_deadletter set resolved = $3
				 where org_id = $1 and id = $2 returning id, resolved`,
				[db.orgId, id, resolved]
			);
			if (!rows[0]) return null;
			await writeAudit(client, {
				orgId: db.orgId,
				actor,
				action: resolved ? 'deadletter_resolved' : 'deadletter_reopened',
				subjectTable: 'ingest_deadletter',
				subjectId: id
			});
			return rows[0];
		});
		if (!updated) {
			return reply.status(404).send({ error: 'not_found', message: 'deadletter not found' });
		}
		return updated;
	});
}
