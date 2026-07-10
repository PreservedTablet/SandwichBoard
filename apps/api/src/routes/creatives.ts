import {
	SETTINGS_KEY_NAMING_PREFIX,
	appendUtmToUrl,
	buildAdName,
	buildUtmParams,
	creativeCreateSchema,
	creativeStatuses,
	creativeUpdateSchema,
	isValidCampaignSlug,
	parseAdName,
	utmMediums,
	utmQueryString
} from '@sandwichboard/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../lib/audit.js';
import { pageSchema, getSetting, uuidParamSchema, type RouteDeps } from './shared.js';

/**
 * Creatives are the combos (docs/plan/03): asset × copy pieces under an
 * immutable short_code. Creating one is money-adjacent — the code ends up in
 * live ad names — so lifecycle events write audit_log in the same
 * transaction.
 */

const listQuerySchema = z.object({
	status: z.enum(creativeStatuses).optional(),
	...pageSchema
});

const JOINED_COLUMNS = `
	c.id, c.org_id, c.short_code, c.asset_id, c.headline_id, c.primary_text_id,
	c.cta_id, c.angle, c.status, c.notes, c.created_at, c.updated_at,
	a.title as asset_title, a.kind as asset_kind, a.storage_path as asset_storage_path,
	h.body as headline_body, p.body as primary_text_body, t.body as cta_body`;

const JOINED_FROM = `
	from creatives c
	left join assets a on a.id = c.asset_id
	left join copy_variants h on h.id = c.headline_id
	left join copy_variants p on p.id = c.primary_text_id
	left join copy_variants t on t.id = c.cta_id`;

const adNameQuerySchema = z.object({
	campaign_slug: z
		.string()
		.trim()
		.refine(isValidCampaignSlug, 'must be lowercase alphanumerics joined by single hyphens'),
	version: z.coerce.number().int().min(1).max(999999).default(1),
	platform: z.string().trim().min(1).max(32).default('meta'),
	medium: z.enum(utmMediums).default('paid'),
	base_url: z
		.url({ protocol: /^https?$/ })
		.max(2048)
		.optional()
});

export function registerCreativeRoutes(app: FastifyInstance, deps: RouteDeps): void {
	const { db, actor } = deps;

	app.get('/api/creatives', async (request) => {
		const query = listQuerySchema.parse(request.query);
		const where: string[] = ['c.org_id = $1'];
		const params: unknown[] = [db.orgId];
		if (query.status) {
			params.push(query.status);
			where.push(`c.status = $${params.length}`);
		}
		params.push(query.limit, query.offset);
		const { rows } = await db.query(
			`select ${JOINED_COLUMNS} ${JOINED_FROM} where ${where.join(' and ')}
			 order by c.created_at desc limit $${params.length - 1} offset $${params.length}`,
			params
		);
		return { items: rows };
	});

	app.post('/api/creatives', async (request, reply) => {
		const body = creativeCreateSchema.parse(request.body);
		const created = await db.tx(async (client) => {
			const { rows } = await client.query(
				`insert into creatives (org_id, asset_id, headline_id, primary_text_id, cta_id, angle, notes, status)
				 values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
				[
					db.orgId,
					body.asset_id ?? null,
					body.headline_id ?? null,
					body.primary_text_id ?? null,
					body.cta_id ?? null,
					body.angle ?? null,
					body.notes ?? null,
					body.status
				]
			);
			const row = rows[0] as { id: string; short_code: string };
			await writeAudit(client, {
				orgId: db.orgId,
				actor,
				action: 'creative_created',
				subjectTable: 'creatives',
				subjectId: row.id,
				payload: {
					short_code: row.short_code,
					asset_id: body.asset_id ?? null,
					headline_id: body.headline_id ?? null,
					primary_text_id: body.primary_text_id ?? null,
					cta_id: body.cta_id ?? null,
					status: body.status
				}
			});
			return row;
		});
		const { rows } = await db.query(
			`select ${JOINED_COLUMNS} ${JOINED_FROM} where c.org_id = $1 and c.id = $2`,
			[db.orgId, created.id]
		);
		return reply.status(201).send(rows[0]);
	});

	app.get('/api/creatives/:id', async (request, reply) => {
		const { id } = uuidParamSchema.parse(request.params);
		const { rows } = await db.query(
			`select ${JOINED_COLUMNS} ${JOINED_FROM} where c.org_id = $1 and c.id = $2`,
			[db.orgId, id]
		);
		if (!rows[0]) {
			return reply.status(404).send({ error: 'not_found', message: 'creative not found' });
		}
		return rows[0];
	});

	app.patch('/api/creatives/:id', async (request, reply) => {
		const { id } = uuidParamSchema.parse(request.params);
		const patch = creativeUpdateSchema.parse(request.body);
		const updated = await db.tx(async (client) => {
			const current = await client.query<{ status: string; short_code: string }>(
				'select status, short_code from creatives where org_id = $1 and id = $2 for update',
				[db.orgId, id]
			);
			if (!current.rows[0]) return null;

			const sets: string[] = [];
			const params: unknown[] = [db.orgId, id];
			for (const [column, value] of Object.entries(patch)) {
				params.push(value);
				sets.push(`${column} = $${params.length}`);
			}
			const { rows } = await client.query(
				`update creatives set ${sets.join(', ')} where org_id = $1 and id = $2 returning *`,
				params
			);
			const from = current.rows[0].status;
			if (patch.status && patch.status !== from) {
				await writeAudit(client, {
					orgId: db.orgId,
					actor,
					action: 'creative_status_changed',
					subjectTable: 'creatives',
					subjectId: id,
					payload: { short_code: current.rows[0].short_code, from, to: patch.status }
				});
			}
			return rows[0] as { id: string };
		});
		if (!updated) {
			return reply.status(404).send({ error: 'not_found', message: 'creative not found' });
		}
		const { rows } = await db.query(
			`select ${JOINED_COLUMNS} ${JOINED_FROM} where c.org_id = $1 and c.id = $2`,
			[db.orgId, id]
		);
		return rows[0];
	});

	app.delete('/api/creatives/:id', async (request, reply) => {
		const { id } = uuidParamSchema.parse(request.params);
		const deleted = await db.tx(async (client) => {
			// The delete guard (migration 0002) raises unless status='draft'.
			const { rows } = await client.query<{ short_code: string }>(
				'delete from creatives where org_id = $1 and id = $2 returning short_code',
				[db.orgId, id]
			);
			if (!rows[0]) return null;
			await writeAudit(client, {
				orgId: db.orgId,
				actor,
				action: 'creative_deleted',
				subjectTable: 'creatives',
				subjectId: id,
				payload: { short_code: rows[0].short_code }
			});
			return rows[0];
		});
		if (!deleted) {
			return reply.status(404).send({ error: 'not_found', message: 'creative not found' });
		}
		return reply.status(204).send();
	});

	// Canonical ad name + UTM set for launching this combo in a campaign.
	// The name is built and then parsed back — the response carries the proof
	// that the convention round-trips (Phase 1 acceptance).
	app.get('/api/creatives/:id/ad-name', async (request, reply) => {
		const { id } = uuidParamSchema.parse(request.params);
		const query = adNameQuerySchema.parse(request.query);

		const context = await db.tx(async (client) => {
			const { rows } = await client.query<{ short_code: string }>(
				'select short_code from creatives where org_id = $1 and id = $2',
				[db.orgId, id]
			);
			if (!rows[0]) return { creative: undefined, prefix: undefined };
			const prefix = await getSetting<string>(client, db.orgId, SETTINGS_KEY_NAMING_PREFIX);
			return { creative: rows[0], prefix };
		});

		if (!context.creative) {
			return reply.status(404).send({ error: 'not_found', message: 'creative not found' });
		}
		if (context.prefix === undefined) {
			return reply.status(409).send({
				error: 'naming_prefix_not_set',
				message: `set the "${SETTINGS_KEY_NAMING_PREFIX}" setting first (PUT /api/settings/${SETTINGS_KEY_NAMING_PREFIX}) — the prefix is per-org data, never a constant`
			});
		}

		const adName = buildAdName({
			prefix: context.prefix,
			campaignSlug: query.campaign_slug,
			shortCode: context.creative.short_code,
			version: query.version
		});
		const parsed = parseAdName(adName, { expectedPrefix: context.prefix });
		if (!parsed.ok || buildAdName(parsed.parts) !== adName) {
			// Should be unreachable: builder output must always parse.
			throw new Error(`ad name ${JSON.stringify(adName)} failed its own round-trip`);
		}

		const utmParams = buildUtmParams({
			platform: query.platform,
			medium: query.medium,
			campaignSlug: query.campaign_slug,
			shortCode: context.creative.short_code
		});

		return {
			ad_name: adName,
			parts: parsed.parts,
			round_trip_ok: true,
			utm_params: utmParams,
			utm_query: utmQueryString(utmParams),
			url: query.base_url ? appendUtmToUrl(query.base_url, utmParams) : null
		};
	});
}
