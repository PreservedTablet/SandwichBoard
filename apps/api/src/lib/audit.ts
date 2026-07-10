import type pg from 'pg';

/**
 * audit_log writer (CLAUDE.md: every money- or publish-adjacent action).
 * In Phase 1 that means creative lifecycle events — the creative is the
 * object every later spend row joins through. Always called inside the same
 * transaction as the change it records: no change without its audit row.
 */
export interface AuditEntry {
	orgId: string;
	actor: string; // 'operator' until sessions exist (single-operator v1)
	action: string;
	subjectTable?: string;
	subjectId?: string;
	payload?: Record<string, unknown>;
}

export async function writeAudit(client: pg.PoolClient, entry: AuditEntry): Promise<void> {
	await client.query(
		`insert into audit_log (org_id, actor, action, subject_table, subject_id, payload)
		 values ($1, $2, $3, $4, $5, $6)`,
		[
			entry.orgId,
			entry.actor,
			entry.action,
			entry.subjectTable ?? null,
			entry.subjectId ?? null,
			entry.payload ? JSON.stringify(entry.payload) : null
		]
	);
}
