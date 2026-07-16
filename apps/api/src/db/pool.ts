import pg from 'pg';

/**
 * Org-scoped database access. Every statement runs inside a transaction that
 * has `app.org_id` set (transaction-local), so the FORCEd RLS policies
 * (migrations 0001–0006) see the right tenant. Two belts: every query also
 * scopes by org_id explicitly, and — since 0006 forces RLS — the policies
 * bind the app connection too, not just the analyst role. One honest
 * caveat: a SUPERUSER connection bypasses RLS no matter what (Postgres
 * semantics), so deployments wanting the second belt must point
 * DATABASE_URL at a non-superuser role; the explicit WHERE clauses hold
 * either way.
 */
export interface OrgDb {
	readonly orgId: string;
	/** Run `fn` inside an org-scoped transaction. */
	tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
	/** One-shot convenience wrapper around `tx`. */
	query<R extends pg.QueryResultRow = pg.QueryResultRow>(
		sql: string,
		params?: unknown[]
	): Promise<pg.QueryResult<R>>;
	end(): Promise<void>;
}

export function createOrgDb(connectionString: string, orgId: string): OrgDb {
	const pool = new pg.Pool({ connectionString, max: 10 });

	async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
		const client = await pool.connect();
		try {
			await client.query('begin');
			await client.query("select set_config('app.org_id', $1, true)", [orgId]);
			const result = await fn(client);
			await client.query('commit');
			return result;
		} catch (err) {
			await client.query('rollback').catch(() => undefined);
			throw err;
		} finally {
			client.release();
		}
	}

	return {
		orgId,
		tx,
		query: (sql, params) => tx((client) => client.query(sql, params)),
		end: () => pool.end()
	};
}
