import { createHash, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import { GOOGLE_PLATFORM, META_PLATFORM } from '@sandwichboard/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MetaCliError } from '../connectors/meta-cli.js';
import { GoogleCsvValidationError, ingestGoogleCsv } from '../ingest/google-csv.js';
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

const googleCsvQuerySchema = z.object({
	external_account_id: z.string().trim().min(1).max(32),
	label: z.string().trim().min(1).max(200).optional(),
	filename: z.string().trim().min(1).max(300).optional()
});

const MAX_CSV_BYTES = 20 * 1024 * 1024;

async function readRawBody(request: FastifyRequest, maxBytes: number): Promise<string> {
	const body = request.body as Readable | undefined;
	if (!body || typeof (body as Readable).on !== 'function') {
		// JSON content types are parsed before they get here; a CSV upload
		// must arrive as a raw text/csv (or octet-stream) body.
		throw new GoogleCsvValidationError([
			'send the CSV file as the raw request body with content-type text/csv'
		]);
	}
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of body) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
		total += buf.length;
		if (total > maxBytes) {
			throw new GoogleCsvValidationError([
				`file exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB — split the export by date range`
			]);
		}
		chunks.push(buf);
	}
	return Buffer.concat(chunks).toString('utf8');
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

	// Google CSV upload — the tokenless universal fallback/backfill
	// (docs/plan/06 Session 2b): raw text/csv body, account id in the query.
	app.post('/internal/ingest/google-csv', async (request, reply) => {
		const denied = requireInternalToken(request, reply);
		if (denied) return denied;

		const query = googleCsvQuerySchema.parse(request.query);
		try {
			const csvText = await readRawBody(request, MAX_CSV_BYTES);
			return await ingestGoogleCsv(
				{ db, actor: deps.actor, trigger: 'api' },
				{
					csvText,
					externalAccountId: query.external_account_id,
					accountLabel: query.label,
					filename: query.filename
				}
			);
		} catch (err) {
			if (err instanceof GoogleCsvValidationError) {
				return reply.status(400).send({ error: 'csv_invalid', problems: err.problems });
			}
			if (err instanceof IngestConfigError) {
				return reply.status(409).send({ error: err.code, message: err.message });
			}
			if (err instanceof SyncAlreadyRunningError) {
				return reply.status(409).send({ error: 'sync_already_running', message: err.message });
			}
			throw err;
		}
	});

	// Read-only facts for the dashboard: last run per platform (from
	// audit_log — the run's own record), freshest snapshot date per
	// platform, and the open-problem counts. Staleness is computed
	// client-side from these.
	app.get('/api/sync/status', async () => {
		return db.tx(async (client) => {
			const lastAudit = async (action: string) => {
				const { rows } = await client.query<{ at: string; payload: Record<string, unknown> }>(
					`select at, payload from audit_log
					 where org_id = $1 and action = $2
					 order by at desc limit 1`,
					[db.orgId, action]
				);
				return rows[0] ?? null;
			};
			const dataThrough = async (platform?: string) => {
				const { rows } = await client.query<{ data_through: string | null }>(
					platform
						? `select to_char(max(s.date), 'YYYY-MM-DD') as data_through
						   from metric_snapshots s join ad_entities e on e.id = s.ad_entity_id
						   where s.org_id = $1 and e.platform = $2`
						: `select to_char(max(date), 'YYYY-MM-DD') as data_through
						   from metric_snapshots where org_id = $1`,
					platform ? [db.orgId, platform] : [db.orgId]
				);
				return rows[0]?.data_through ?? null;
			};

			const [metaSuccess, metaFailure, googleSuccess] = await Promise.all([
				lastAudit('meta_sync_completed'),
				lastAudit('meta_sync_failed'),
				lastAudit('google_csv_ingested')
			]);
			const [overallThrough, metaThrough, googleThrough] = await Promise.all([
				dataThrough(),
				dataThrough(META_PLATFORM),
				dataThrough(GOOGLE_PLATFORM)
			]);
			const unmatched = await client.query<{ n: number }>(
				'select count(*)::int as n from v_unmatched_ads where org_id = $1',
				[db.orgId]
			);
			const openDeadletters = await client.query<{ n: number }>(
				'select count(*)::int as n from ingest_deadletter where org_id = $1 and not resolved',
				[db.orgId]
			);

			return {
				data_through: overallThrough,
				unmatched_ads: unmatched.rows[0]!.n,
				open_deadletters: openDeadletters.rows[0]!.n,
				platforms: [
					{
						platform: META_PLATFORM,
						method: 'sync',
						configured: Boolean(deps.runMetaSync),
						data_through: metaThrough,
						last_success_at: metaSuccess?.at ?? null,
						last_success_summary: metaSuccess?.payload ?? null,
						last_failure_at: metaFailure?.at ?? null,
						last_failure_error: (metaFailure?.payload as { error?: string } | null)?.error ?? null
					},
					{
						// CSV upload needs no platform credentials, so google is
						// always available; the live GAQL path arrives with the
						// developer token (docs/decisions/0006).
						platform: GOOGLE_PLATFORM,
						method: 'csv-upload',
						configured: true,
						data_through: googleThrough,
						last_success_at: googleSuccess?.at ?? null,
						last_success_summary: googleSuccess?.payload ?? null,
						last_failure_at: null,
						last_failure_error: null
					}
				]
			};
		});
	});
}
