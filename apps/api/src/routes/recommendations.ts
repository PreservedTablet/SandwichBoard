import {
	RECOMMENDATION_TRANSITIONS,
	recommendationStatuses,
	recommendationUpdateSchema,
	type RecommendationStatus
} from '@sandwichboard/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../lib/audit.js';
import { pageSchema, uuidParamSchema, type RouteDeps } from './shared.js';

/**
 * The operator's side of the analysis loop (docs/plan/06 Phase 3): list
 * what /analyze proposed, record verdicts. Rows are CREATED by the analyst
 * database role inside a Claude session — there is deliberately no POST
 * here, and rationale/evidence are immutable (trigger-enforced), so the
 * API surface is exactly: read, and change status/outcome_note. Verdicts
 * feed the next run, so every one is audited.
 */

const listQuerySchema = z.object({
	status: z.enum(recommendationStatuses).optional(),
	run_id: z.uuid().optional(),
	...pageSchema
});

const COLUMNS = `
	r.id, r.org_id, r.run_id, r.kind, r.subject_creative_id, r.rationale,
	r.evidence, r.status, r.outcome_note, r.created_at, r.updated_at,
	c.short_code as subject_short_code, c.status as subject_creative_status`;

const FROM = `
	from recommendations r
	left join creatives c on c.id = r.subject_creative_id`;

export function registerRecommendationRoutes(app: FastifyInstance, deps: RouteDeps): void {
	const { db, actor } = deps;

	app.get('/api/recommendations', async (request) => {
		const query = listQuerySchema.parse(request.query);
		const where: string[] = ['r.org_id = $1'];
		const params: unknown[] = [db.orgId];
		if (query.status) {
			params.push(query.status);
			where.push(`r.status = $${params.length}`);
		}
		if (query.run_id) {
			params.push(query.run_id);
			where.push(`r.run_id = $${params.length}`);
		}
		params.push(query.limit, query.offset);
		const { rows } = await db.query(
			`select ${COLUMNS} ${FROM} where ${where.join(' and ')}
			 order by r.created_at desc limit $${params.length - 1} offset $${params.length}`,
			params
		);
		return { items: rows };
	});

	app.get('/api/recommendations/:id', async (request, reply) => {
		const { id } = uuidParamSchema.parse(request.params);
		const { rows } = await db.query(`select ${COLUMNS} ${FROM} where r.org_id = $1 and r.id = $2`, [
			db.orgId,
			id
		]);
		if (!rows[0]) {
			return reply.status(404).send({ error: 'not_found', message: 'recommendation not found' });
		}
		return rows[0];
	});

	app.patch('/api/recommendations/:id', async (request, reply) => {
		const { id } = uuidParamSchema.parse(request.params);
		const patch = recommendationUpdateSchema.parse(request.body);

		const result = await db.tx(async (client) => {
			const current = await client.query<{ status: RecommendationStatus; kind: string }>(
				'select status, kind from recommendations where org_id = $1 and id = $2 for update',
				[db.orgId, id]
			);
			if (!current.rows[0]) return { kind: 'not_found' as const };
			const from = current.rows[0].status;

			if (patch.status && patch.status !== from) {
				if (!RECOMMENDATION_TRANSITIONS[from].includes(patch.status)) {
					return { kind: 'bad_transition' as const, from };
				}
			}

			const sets: string[] = [];
			const params: unknown[] = [db.orgId, id];
			for (const [column, value] of Object.entries(patch)) {
				params.push(value);
				sets.push(`${column} = $${params.length}`);
			}
			await client.query(
				`update recommendations set ${sets.join(', ')} where org_id = $1 and id = $2`,
				params
			);

			if (patch.status && patch.status !== from) {
				// The verdict is what next week's run scores itself against —
				// and accepted scale/budget recommendations are money-adjacent.
				await writeAudit(client, {
					orgId: db.orgId,
					actor,
					action: 'recommendation_status_changed',
					subjectTable: 'recommendations',
					subjectId: id,
					payload: {
						kind: current.rows[0].kind,
						from,
						to: patch.status,
						outcome_note: patch.outcome_note ?? null
					}
				});
			}
			return { kind: 'ok' as const };
		});

		if (result.kind === 'not_found') {
			return reply.status(404).send({ error: 'not_found', message: 'recommendation not found' });
		}
		if (result.kind === 'bad_transition') {
			return reply.status(409).send({
				error: 'invalid_transition',
				message: `cannot move a recommendation from ${result.from} to ${patch.status} — allowed: ${
					RECOMMENDATION_TRANSITIONS[result.from].join(', ') || '(none, terminal)'
				}`
			});
		}
		const { rows } = await db.query(`select ${COLUMNS} ${FROM} where r.org_id = $1 and r.id = $2`, [
			db.orgId,
			id
		]);
		return rows[0];
	});
}
