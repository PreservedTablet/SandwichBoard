import {
	copyVariantCreateSchema,
	copyVariantKinds,
	copyVariantUpdateSchema
} from '@sandwichboard/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
	escapeLike,
	pageSchema,
	tagFilterSchema,
	uuidParamSchema,
	type RouteDeps
} from './shared.js';

const listQuerySchema = z.object({
	kind: z.enum(copyVariantKinds).optional(),
	tag: tagFilterSchema,
	q: z.string().trim().min(1).max(200).optional(),
	...pageSchema
});

const COPY_COLUMNS =
	'id, org_id, kind, body, angle, tone, char_count, tags, created_at, updated_at';

export function registerCopyVariantRoutes(app: FastifyInstance, deps: RouteDeps): void {
	const { db } = deps;

	app.get('/api/copy-variants', async (request) => {
		const query = listQuerySchema.parse(request.query);
		const where: string[] = ['org_id = $1'];
		const params: unknown[] = [db.orgId];
		if (query.kind) {
			params.push(query.kind);
			where.push(`kind = $${params.length}`);
		}
		if (query.tag.length > 0) {
			params.push(query.tag);
			where.push(`tags @> $${params.length}::text[]`);
		}
		if (query.q) {
			params.push(`%${escapeLike(query.q)}%`);
			where.push(`body ilike $${params.length}`);
		}
		params.push(query.limit, query.offset);
		const { rows } = await db.query(
			`select ${COPY_COLUMNS} from copy_variants where ${where.join(' and ')}
			 order by kind, created_at desc limit $${params.length - 1} offset $${params.length}`,
			params
		);
		return { items: rows };
	});

	app.post('/api/copy-variants', async (request, reply) => {
		const body = copyVariantCreateSchema.parse(request.body);
		const { rows } = await db.query(
			`insert into copy_variants (org_id, kind, body, angle, tone, tags)
			 values ($1, $2, $3, $4, $5, $6) returning ${COPY_COLUMNS}`,
			[db.orgId, body.kind, body.body, body.angle ?? null, body.tone ?? null, body.tags]
		);
		return reply.status(201).send(rows[0]);
	});

	app.get('/api/copy-variants/:id', async (request, reply) => {
		const { id } = uuidParamSchema.parse(request.params);
		const { rows } = await db.query(
			`select ${COPY_COLUMNS} from copy_variants where org_id = $1 and id = $2`,
			[db.orgId, id]
		);
		if (!rows[0]) {
			return reply.status(404).send({ error: 'not_found', message: 'copy variant not found' });
		}
		return rows[0];
	});

	app.patch('/api/copy-variants/:id', async (request, reply) => {
		const { id } = uuidParamSchema.parse(request.params);
		const patch = copyVariantUpdateSchema.parse(request.body);
		const sets: string[] = [];
		const params: unknown[] = [db.orgId, id];
		for (const [column, value] of Object.entries(patch)) {
			params.push(value);
			sets.push(`${column} = $${params.length}`);
		}
		const { rows } = await db.query(
			`update copy_variants set ${sets.join(', ')}
			 where org_id = $1 and id = $2 returning ${COPY_COLUMNS}`,
			params
		);
		if (!rows[0]) {
			return reply.status(404).send({ error: 'not_found', message: 'copy variant not found' });
		}
		return rows[0];
	});

	app.delete('/api/copy-variants/:id', async (request, reply) => {
		const { id } = uuidParamSchema.parse(request.params);
		const { rowCount } = await db.query('delete from copy_variants where org_id = $1 and id = $2', [
			db.orgId,
			id
		]);
		if (rowCount === 0) {
			return reply.status(404).send({ error: 'not_found', message: 'copy variant not found' });
		}
		return reply.status(204).send();
	});
}
