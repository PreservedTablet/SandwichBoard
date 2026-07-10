import { loadConfig, redactedConfigSummary } from '@sandwichboard/core';
import { buildApp } from './app.js';
import { createOrgDb } from './db/pool.js';
import { createStorageAdapter } from './storage/index.js';

const config = loadConfig();
const db = createOrgDb(config.DATABASE_URL, config.ORG_ID);
const storage = createStorageAdapter(config);
const app = buildApp({
	logLevel: config.NODE_ENV === 'test' ? 'silent' : 'info',
	deps: { db, storage }
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
