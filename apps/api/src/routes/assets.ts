import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import {
	assetCreateSchema,
	assetKinds,
	assetProductionStatuses,
	assetUpdateSchema
} from '@sandwichboard/core';
import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { FILE_TOKEN_TTL_SECONDS } from '../lib/file-tokens.js';
import {
	escapeLike,
	pageSchema,
	tagFilterSchema,
	uuidParamSchema,
	type RouteDeps
} from './shared.js';

/**
 * Uploads stream straight through the storage adapter; reads go through
 * short-lived HMAC-tokenized URLs (docs/plan/06 Phase 1) so the web app
 * never needs storage credentials and nothing serves unauthenticated files.
 */

// Generous enough for stills and short verticals; large video stays wherever
// it lives and is referenced by external_url (docs/plan/01).
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

// Content types we are willing to store and how to serve them back. SVG is
// deliberately attachment-only: it executes script when rendered inline.
const CONTENT_TYPES: Record<string, { ext: string; inline: boolean }> = {
	'image/png': { ext: '.png', inline: true },
	'image/jpeg': { ext: '.jpg', inline: true },
	'image/webp': { ext: '.webp', inline: true },
	'image/gif': { ext: '.gif', inline: true },
	'image/avif': { ext: '.avif', inline: true },
	'image/svg+xml': { ext: '.svg', inline: false },
	'video/mp4': { ext: '.mp4', inline: true },
	'video/webm': { ext: '.webm', inline: true },
	'video/quicktime': { ext: '.mov', inline: true },
	'application/pdf': { ext: '.pdf', inline: true },
	'application/octet-stream': { ext: '.bin', inline: false }
};

const listQuerySchema = z.object({
	kind: z.enum(assetKinds).optional(),
	production_status: z.enum(assetProductionStatuses).optional(),
	tag: tagFilterSchema,
	q: z.string().trim().min(1).max(200).optional(),
	...pageSchema
});

const fileQuerySchema = z.object({
	exp: z.coerce.number().int(),
	sig: z.string().min(1).max(128)
});

function byteLimit(maxBytes: number): Transform {
	let seen = 0;
	return new Transform({
		transform(chunk: Buffer, _enc, done) {
			seen += chunk.length;
			if (seen > maxBytes) {
				done(Object.assign(new Error(`upload exceeds ${maxBytes} bytes`), { statusCode: 413 }));
				return;
			}
			done(null, chunk);
		}
	});
}

const ASSET_COLUMNS =
	'id, org_id, kind, title, production_status, storage_path, storage_content_type, storage_sha256, external_url, width, height, duration_s::float8 as duration_s, aspect_ratio, angle, tags, source, notes, import_ref, created_at, updated_at';

export function registerAssetRoutes(app: FastifyInstance, deps: RouteDeps): void {
	const { db, storage, fileTokens } = deps;

	app.get('/api/assets', async (request) => {
		const query = listQuerySchema.parse(request.query);
		const where: string[] = ['org_id = $1'];
		const params: unknown[] = [db.orgId];
		if (query.kind) {
			params.push(query.kind);
			where.push(`kind = $${params.length}`);
		}
		if (query.production_status) {
			params.push(query.production_status);
			where.push(`production_status = $${params.length}`);
		}
		if (query.tag.length > 0) {
			params.push(query.tag);
			where.push(`tags @> $${params.length}::text[]`);
		}
		if (query.q) {
			params.push(`%${escapeLike(query.q)}%`);
			where.push(`title ilike $${params.length}`);
		}
		params.push(query.limit, query.offset);
		const { rows } = await db.query(
			`select ${ASSET_COLUMNS} from assets where ${where.join(' and ')}
			 order by created_at desc limit $${params.length - 1} offset $${params.length}`,
			params
		);
		return { items: rows };
	});

	app.post('/api/assets', async (request, reply) => {
		const body = assetCreateSchema.parse(request.body);
		const { rows } = await db.query(
			`insert into assets (org_id, kind, title, production_status, external_url, width, height,
			                     duration_s, aspect_ratio, angle, tags, source, notes, import_ref)
			 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
			 returning ${ASSET_COLUMNS}`,
			[
				db.orgId,
				body.kind,
				body.title,
				body.production_status,
				body.external_url ?? null,
				body.width ?? null,
				body.height ?? null,
				body.duration_s ?? null,
				body.aspect_ratio ?? null,
				body.angle ?? null,
				body.tags,
				body.source ?? null,
				body.notes ?? null,
				body.import_ref ?? null
			]
		);
		return reply.status(201).send(rows[0]);
	});

	app.get('/api/assets/:id', async (request, reply) => {
		const { id } = uuidParamSchema.parse(request.params);
		const { rows } = await db.query(
			`select ${ASSET_COLUMNS} from assets where org_id = $1 and id = $2`,
			[db.orgId, id]
		);
		if (!rows[0]) return reply.status(404).send({ error: 'not_found', message: 'asset not found' });
		return rows[0];
	});

	app.patch('/api/assets/:id', async (request, reply) => {
		const { id } = uuidParamSchema.parse(request.params);
		const patch = assetUpdateSchema.parse(request.body);
		const sets: string[] = [];
		const params: unknown[] = [db.orgId, id];
		for (const [column, value] of Object.entries(patch)) {
			params.push(value);
			sets.push(`${column} = $${params.length}`);
		}
		const { rows } = await db.query(
			`update assets set ${sets.join(', ')} where org_id = $1 and id = $2 returning ${ASSET_COLUMNS}`,
			params
		);
		if (!rows[0]) return reply.status(404).send({ error: 'not_found', message: 'asset not found' });
		return rows[0];
	});

	app.delete('/api/assets/:id', async (request, reply) => {
		const { id } = uuidParamSchema.parse(request.params);
		const deleted = await db.tx(async (client) => {
			const { rows } = await client.query<{ storage_path: string | null }>(
				'delete from assets where org_id = $1 and id = $2 returning storage_path',
				[db.orgId, id]
			);
			return rows[0];
		});
		if (!deleted) return reply.status(404).send({ error: 'not_found', message: 'asset not found' });
		if (deleted.storage_path) await storage.delete(deleted.storage_path);
		return reply.status(204).send();
	});

	// Raw-body upload: fetch(url, { method: 'PUT', body: file, headers:
	// { 'content-type': file.type } }) — no multipart dependency needed.
	app.put('/api/assets/:id/file', async (request, reply) => {
		const { id } = uuidParamSchema.parse(request.params);
		const contentType = (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
		const spec = CONTENT_TYPES[contentType];
		if (!spec) {
			return reply.status(415).send({
				error: 'unsupported_media_type',
				message: `content-type ${JSON.stringify(contentType)} not accepted — one of: ${Object.keys(CONTENT_TYPES).join(', ')}`
			});
		}
		const declared = Number(request.headers['content-length'] ?? '0');
		if (declared > MAX_UPLOAD_BYTES) {
			return reply
				.status(413)
				.send({ error: 'too_large', message: `upload exceeds ${MAX_UPLOAD_BYTES} bytes` });
		}

		const existing = await db.query<{ storage_path: string | null }>(
			'select storage_path from assets where org_id = $1 and id = $2',
			[db.orgId, id]
		);
		if (!existing.rows[0]) {
			return reply.status(404).send({ error: 'not_found', message: 'asset not found' });
		}

		const key = `assets/${id}/original${spec.ext}`;
		const body = request.body as Readable;
		// Hash while streaming: the digest enables "do I already have this
		// file?" dedupe across a messy asset collection.
		const hash = createHash('sha256');
		const hashTap = new Transform({
			transform(chunk: Buffer, _enc, done) {
				hash.update(chunk);
				done(null, chunk);
			}
		});
		await storage.put(key, body.pipe(byteLimit(MAX_UPLOAD_BYTES)).pipe(hashTap), { contentType });

		const previous = existing.rows[0].storage_path;
		if (previous && previous !== key) await storage.delete(previous);

		const { rows } = await db.query(
			`update assets set storage_path = $3, storage_content_type = $4, storage_sha256 = $5
			 where org_id = $1 and id = $2 returning ${ASSET_COLUMNS}`,
			[db.orgId, id, key, contentType, hash.digest('hex')]
		);
		return rows[0];
	});

	// Issue a short-lived tokenized URL for the asset's stored file.
	app.get('/api/assets/:id/file-url', async (request, reply) => {
		const { id } = uuidParamSchema.parse(request.params);
		const { rows } = await db.query<{ storage_path: string | null }>(
			'select storage_path from assets where org_id = $1 and id = $2',
			[db.orgId, id]
		);
		if (!rows[0]) return reply.status(404).send({ error: 'not_found', message: 'asset not found' });
		if (!rows[0].storage_path) {
			return reply.status(404).send({ error: 'no_file', message: 'asset has no stored file' });
		}
		const { exp, sig } = fileTokens.issue(id);
		return {
			url: `/api/assets/${id}/file?exp=${exp}&sig=${encodeURIComponent(sig)}`,
			expires_at: new Date(exp * 1000).toISOString(),
			ttl_seconds: FILE_TOKEN_TTL_SECONDS
		};
	});

	// The tokenized read itself. Token → 403 on any mismatch or expiry.
	app.get('/api/assets/:id/file', async (request, reply) => {
		const { id } = uuidParamSchema.parse(request.params);
		const { exp, sig } = fileQuerySchema.parse(request.query);
		if (!fileTokens.verify(id, exp, sig)) {
			return reply
				.status(403)
				.send({ error: 'invalid_token', message: 'file token invalid or expired' });
		}
		const { rows } = await db.query<{
			storage_path: string | null;
			storage_content_type: string | null;
		}>('select storage_path, storage_content_type from assets where org_id = $1 and id = $2', [
			db.orgId,
			id
		]);
		if (!rows[0]?.storage_path) {
			return reply.status(404).send({ error: 'no_file', message: 'asset has no stored file' });
		}
		const contentType = rows[0].storage_content_type ?? 'application/octet-stream';
		const spec = CONTENT_TYPES[contentType];
		const stream = await storage.getStream(rows[0].storage_path);
		return reply
			.header('content-type', contentType)
			.header('x-content-type-options', 'nosniff')
			.header('content-disposition', spec?.inline ? 'inline' : 'attachment')
			.header('cache-control', 'private, max-age=60')
			.send(stream);
	});
}
