import { loadConfig, redactedConfigSummary } from '@sandwichboard/core';
import { buildApp } from './app.js';

const config = loadConfig();
const app = buildApp({ logLevel: config.NODE_ENV === 'test' ? 'silent' : 'info' });

app.log.info({ config: redactedConfigSummary(config) }, 'configuration loaded (redacted summary)');

const close = async (signal: string) => {
	app.log.info({ signal }, 'shutting down');
	await app.close();
	process.exit(0);
};
process.on('SIGINT', () => void close('SIGINT'));
process.on('SIGTERM', () => void close('SIGTERM'));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
