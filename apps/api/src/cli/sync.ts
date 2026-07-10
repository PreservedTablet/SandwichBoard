import { pathToFileURL } from 'node:url';
import { loadConfig } from '@sandwichboard/core';
import { MetaCliConnector } from '../connectors/meta-cli.js';
import { createOrgDb } from '../db/pool.js';
import { IngestConfigError, runMetaSync } from '../ingest/meta-sync.js';

/**
 * `pnpm sync` — the manual range sync (docs/plan/06 Phase 2). A plain
 * command a human runs; range-based catch-up makes any cadence correct, so
 * the repo ships no scheduler. Operators who want cadence wrap THIS command
 * in their own cron/systemd timer (docs/plan/06 appendix).
 */

async function main(): Promise<void> {
	const config = loadConfig();
	if (!config.META_SYSTEM_USER_TOKEN || !config.META_AD_ACCOUNT_ID) {
		console.error(
			'Meta ingestion is not configured: set META_SYSTEM_USER_TOKEN and META_AD_ACCOUNT_ID\n' +
				'(Infisical /ingest — credential steps in docs/decisions/0005-meta-ingestion.md).'
		);
		process.exitCode = 1;
		return;
	}

	const db = createOrgDb(config.DATABASE_URL, config.ORG_ID);
	try {
		const summary = await runMetaSync({
			db,
			connector: new MetaCliConnector({
				bin: config.META_ADS_CLI_BIN,
				accessToken: config.META_SYSTEM_USER_TOKEN,
				adAccountId: config.META_AD_ACCOUNT_ID
			}),
			actor: 'ingest-job',
			trigger: 'cli'
		});
		console.log(
			`meta sync ${summary.range.since} → ${summary.range.until} ` +
				`(watermark ${summary.watermark ?? 'none — backfill'})\n` +
				`  account: ${summary.account.label} [${summary.account.currency ?? '?'} ${summary.account.timezone ?? '?'}]\n` +
				`  campaigns: ${summary.campaigns_synced}, ads: ${summary.ads_synced} ` +
				`(${summary.ads_matched} matched, ${summary.ads_unmatched} unmatched)\n` +
				`  snapshot rows upserted: ${summary.snapshot_rows_upserted}, deadletters: ${summary.deadletters}\n` +
				`  ${summary.duration_ms}ms — audit_log has the same summary`
		);
		if (summary.ads_unmatched > 0) {
			console.log(
				`  ⚠ ${summary.ads_unmatched} ad(s) did not match a creative — see v_unmatched_ads`
			);
		}
		if (summary.deadletters > 0) {
			console.log(`  ⚠ ${summary.deadletters} row(s) deadlettered — see ingest_deadletter`);
		}
	} finally {
		await db.end();
	}
}

const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	main().catch((err) => {
		if (err instanceof IngestConfigError) {
			console.error(err.message);
		} else {
			console.error(err instanceof Error ? err.message : err);
		}
		process.exitCode = 1;
	});
}
