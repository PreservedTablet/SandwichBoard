import { loadConfig, redactedConfigSummary } from '@sandwichboard/core';
import { buildApp } from './app.js';
import { MetaCliConnector } from './connectors/meta-cli.js';
import { createOrgDb } from './db/pool.js';
import { runMetaSync } from './ingest/meta-sync.js';
import { createStorageAdapter } from './storage/index.js';

const config = loadConfig();
const db = createOrgDb(config.DATABASE_URL, config.ORG_ID);
const storage = createStorageAdapter(config);

// Meta ingestion is wired only when its credentials are configured; the
// endpoint answers 503 with setup guidance otherwise (docs/decisions/0005).
const metaConfigured = Boolean(config.META_SYSTEM_USER_TOKEN && config.META_AD_ACCOUNT_ID);
const app = buildApp({
	logLevel: config.NODE_ENV === 'test' ? 'silent' : 'info',
	deps: {
		db,
		storage,
		internalToken: config.INTERNAL_API_TOKEN,
		runMetaSync: metaConfigured
			? () =>
					runMetaSync({
						db,
						connector: new MetaCliConnector({
							bin: config.META_ADS_CLI_BIN,
							accessToken: config.META_SYSTEM_USER_TOKEN!,
							adAccountId: config.META_AD_ACCOUNT_ID!
						}),
						actor: 'ingest-job',
						trigger: 'api'
					})
			: undefined
	}
});

app.log.info({ config: redactedConfigSummary(config) }, 'configuration loaded (redacted summary)');

const close = async (signal: string) => {
	app.log.info({ signal }, 'shutting down');
	await app.close();
	await db.end();
	process.exit(0);
};
process.on('SIGINT', () => void close('SIGINT'));
process.on('SIGTERM', () => void close('SIGTERM'));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
