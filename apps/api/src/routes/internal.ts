import { createHash, timingSafeEqual } from 'node:crypto';
import { META_PLATFORM } from '@sandwichboard/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { MetaCliError } from '../connectors/meta-cli.js';
import {
	IngestConfigError,
	SyncAlreadyRunningError,
	type MetaSyncSummary
} from '../ingest/meta-sync.js';
import type { RouteDeps } from './shared.js';

/**
 * `/internal/*` — commands, not CRUD (docs/plan/06 Phase 2). Guarded by a
 * bearer token from config (INTERNAL_API_TOKEN, constant-time compared);
 * unset ⇒ 503 naming the variable, never a silently open endpoint
 * (docs/decisions/0005 decision 2). `/api/sync/status` is a plain read like
 * the rest of `/api` — the staleness banner polls it.
 */

export interface IngestRouteDeps extends RouteDeps {
	/** From config INTERNAL_API_TOKEN; undefined ⇒ /internal/* answers 503. */
	internalToken?: string;
	/** Wired when Meta ingestion is configured; undefined ⇒ 503 on trigger. */
	runMetaSync?: () => Promise<MetaSyncSummary>;
}

function bearerToken(request: FastifyRequest): string | undefined {
	const header = request.headers.authorization;
	if (typeof header !== 'string') return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	return match?.[1];
}

function tokenMatches(presented: string, expected: string): boolean {
	// Hash both sides so timingSafeEqual gets equal lengths.
	const a = createHash('sha256').update(presented).digest();
	const b = createHash('sha256').update(expected).digest();
	return timingSafeEqual(a, b);
}

export function registerInternalRoutes(app: FastifyInstance, deps: IngestRouteDeps): void {
	const { db } = deps;

	const requireInternalToken = (
		request: FastifyRequest,
		reply: FastifyReply
	): FastifyReply | null => {
		if (!deps.internalToken) {
			return reply.status(503).send({
				error: 'internal_token_not_configured',
				message:
					'set INTERNAL_API_TOKEN (config/variables.md) to enable /internal/* commands — unset means disabled, never open'
			});
		}
		const presented = bearerToken(request);
		if (!presented || !tokenMatches(presented, deps.internalToken)) {
			return reply.status(401).send({
				error: 'unauthorized',
				message: 'missing or wrong bearer token (INTERNAL_API_TOKEN)'
			});
		}
		return null;
	};

	app.post('/internal/ingest/meta', async (request, reply) => {
		const denied = requireInternalToken(request, reply);
		if (denied) return denied;

		if (!deps.runMetaSync) {
			return reply.status(503).send({
				error: 'meta_not_configured',
				message:
					'set META_SYSTEM_USER_TOKEN and META_AD_ACCOUNT_ID (Infisical /ingest — docs/decisions/0005) to enable Meta ingestion'
			});
		}

		try {
			return await deps.runMetaSync();
		} catch (err) {
			if (err instanceof IngestConfigError) {
				return reply.status(409).send({ error: err.code, message: err.message });
			}
			if (err instanceof SyncAlreadyRunningError) {
				return reply.status(409).send({ error: 'sync_already_running', message: err.message });
			}
			if (err instanceof MetaCliError) {
				const status = err.kind === 'not-installed' ? 503 : 502;
				return reply.status(status).send({
					error: `meta_cli_${err.kind.replace(/-/g, '_')}`,
					message: err.message
				});
			}
			throw err; // error boundary logs and answers 500
		}
	});

	// Read-only facts for the dashboard: last run per platform (from
	// audit_log — the run's own record), freshest snapshot date, and the
	// open-problem counts. Staleness is computed client-side from these.
	app.get('/api/sync/status', async () => {
		const [lastSuccess, lastFailure, dataThrough, unmatched, openDeadletters] = await db.tx(
			async (client) => {
				const success = await client.query<{ at: string; payload: MetaSyncSummary }>(
					`select at, payload from audit_log
					 where org_id = $1 and action = 'meta_sync_completed'
					 order by at desc limit 1`,
					[db.orgId]
				);
				const failure = await client.query<{ at: string; payload: { error?: string } }>(
					`select at, payload from audit_log
					 where org_id = $1 and action = 'meta_sync_failed'
					 order by at desc limit 1`,
					[db.orgId]
				);
				const through = await client.query<{ data_through: string | null }>(
					`select to_char(max(date), 'YYYY-MM-DD') as data_through
					 from metric_snapshots where org_id = $1`,
					[db.orgId]
				);
				const unmatchedCount = await client.query<{ n: number }>(
					'select count(*)::int as n from v_unmatched_ads where org_id = $1',
					[db.orgId]
				);
				const openCount = await client.query<{ n: number }>(
					'select count(*)::int as n from ingest_deadletter where org_id = $1 and not resolved',
					[db.orgId]
				);
				return [
					success.rows[0] ?? null,
					failure.rows[0] ?? null,
					through.rows[0]?.data_through ?? null,
					unmatchedCount.rows[0]!.n,
					openCount.rows[0]!.n
				] as const;
			}
		);

		return {
			data_through: dataThrough,
			unmatched_ads: unmatched,
			open_deadletters: openDeadletters,
			platforms: [
				{
					platform: META_PLATFORM,
					configured: Boolean(deps.runMetaSync),
					last_success_at: lastSuccess?.at ?? null,
					last_success_summary: lastSuccess?.payload ?? null,
					last_failure_at: lastFailure?.at ?? null,
					last_failure_error: lastFailure?.payload?.error ?? null
				}
			]
		};
	});
}
