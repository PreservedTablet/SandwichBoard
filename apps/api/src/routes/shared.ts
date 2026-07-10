import { z } from 'zod';
import type { OrgDb } from '../db/pool.js';
import type { StorageAdapter } from '@sandwichboard/core';
import type { FileTokenSigner } from '../lib/file-tokens.js';

/** Dependencies threaded into every route group by buildApp. */
export interface RouteDeps {
	db: OrgDb;
	storage: StorageAdapter;
	fileTokens: FileTokenSigner;
	/** Audit actor for this deployment; 'operator' until sessions exist. */
	actor: string;
}

export const uuidParamSchema = z.object({ id: z.uuid() });

/** `?tag=a&tag=b` arrives as string or string[]; normalize to string[]. */
export const tagFilterSchema = z
	.union([z.string().min(1).max(64), z.array(z.string().min(1).max(64)).max(16)])
	.optional()
	.transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]));

export const pageSchema = {
	limit: z.coerce.number().int().min(1).max(500).default(200),
	offset: z.coerce.number().int().min(0).default(0)
};

/** Escape LIKE wildcards in user search text; callers add their own %…%. */
export function escapeLike(text: string): string {
	return text.replace(/([\\%_])/g, '\\$1');
}

/**
 * Read a `settings` value inside an existing transaction.
 * Returns undefined when the key is unset for this org.
 */
export async function getSetting<T = unknown>(
	client: import('pg').PoolClient,
	orgId: string,
	key: string
): Promise<T | undefined> {
	const { rows } = await client.query<{ value: T }>(
		'select value from settings where org_id = $1 and key = $2',
		[orgId, key]
	);
	return rows[0]?.value;
}
