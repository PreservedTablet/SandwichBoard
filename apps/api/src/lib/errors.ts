import { AdNameError, UtmError } from '@sandwichboard/core';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { StorageKeyError } from '../storage/local-fs.js';

/**
 * One error boundary for every route — no silent catches (CLAUDE.md):
 * expected failures map to precise 4xx bodies, everything else is logged
 * with its stack and surfaces as a plain 500.
 */

interface PgErrorLike {
	code: string;
	message: string;
	detail?: string;
	constraint?: string;
	severity?: string;
}

function asPgError(err: unknown): PgErrorLike | null {
	if (
		typeof err === 'object' &&
		err !== null &&
		'code' in err &&
		typeof (err as { code: unknown }).code === 'string' &&
		'severity' in err
	) {
		return err as unknown as PgErrorLike;
	}
	return null;
}

export function registerErrorHandling(app: FastifyInstance): void {
	app.setNotFoundHandler(async (request, reply) => {
		return reply.status(404).send({ error: 'not_found', message: `no route ${request.url}` });
	});

	app.setErrorHandler(async (err, request, reply) => {
		if (err instanceof ZodError) {
			return reply.status(400).send({
				error: 'validation',
				issues: err.issues.map((issue) => ({
					path: issue.path.join('.'),
					message: issue.message
				}))
			});
		}

		if (err instanceof AdNameError || err instanceof UtmError || err instanceof StorageKeyError) {
			return reply.status(400).send({ error: 'invalid_input', message: err.message });
		}

		const pgErr = asPgError(err);
		if (pgErr) {
			switch (pgErr.code) {
				case '23505': // unique_violation
					return reply.status(409).send({
						error: 'conflict',
						message: pgErr.detail ?? `duplicate value (${pgErr.constraint ?? 'unique constraint'})`
					});
				case '23503': // foreign_key_violation — bad reference or still referenced
					return reply.status(409).send({
						error: 'reference_conflict',
						message: pgErr.detail ?? `foreign key violation (${pgErr.constraint ?? 'unknown'})`
					});
				case '23514': // check_violation
					return reply.status(400).send({
						error: 'check_violation',
						message: `check constraint failed (${pgErr.constraint ?? 'unknown'})`
					});
				case 'P0001': // raise exception — our triggers speak operator language
					return reply.status(400).send({ error: 'rule_violation', message: pgErr.message });
				default:
					break; // fall through to 500 below, logged
			}
		}

		// fastify-generated client errors (body limit, bad content type, …)
		if (typeof err === 'object' && err !== null && 'statusCode' in err) {
			const status = (err as { statusCode?: unknown }).statusCode;
			if (typeof status === 'number' && status >= 400 && status < 500) {
				return reply.status(status).send({
					error: 'request',
					message: err instanceof Error ? err.message : 'request error'
				});
			}
		}

		request.log.error({ err }, 'unhandled error');
		return reply.status(500).send({ error: 'internal', message: 'internal error (logged)' });
	});
}
