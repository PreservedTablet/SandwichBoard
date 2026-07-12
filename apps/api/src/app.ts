import Fastify, { type FastifyInstance } from 'fastify';
import type { StorageAdapter } from '@sandwichboard/core';
import type { OrgDb } from './db/pool.js';
import type { MetaSyncSummary } from './ingest/meta-sync.js';
import { registerErrorHandling } from './lib/errors.js';
import { FileTokenSigner } from './lib/file-tokens.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerCopyVariantRoutes } from './routes/copy-variants.js';
import { registerCreativeRoutes } from './routes/creatives.js';
import { registerInternalRoutes } from './routes/internal.js';
import { registerMetricsRoutes } from './routes/metrics.js';
import { registerRecommendationRoutes } from './routes/recommendations.js';
import { registerSettingsRoutes } from './routes/settings.js';
import type { RouteDeps } from './routes/shared.js';

export interface AppDeps {
	db: OrgDb;
	storage: StorageAdapter;
	/** Guards POST /internal/*; unset ⇒ those endpoints answer 503. */
	internalToken?: string;
	/** Present when Meta ingestion is configured (docs/decisions/0005). */
	runMetaSync?: () => Promise<MetaSyncSummary>;
}

export interface BuildAppOptions {
	/** Pino level; tests pass 'silent'. */
	logLevel?: string;
	/**
	 * Everything environment-dependent, constructed by the caller
	 * (src/server.ts from config; tests from fixtures). Without deps the app
	 * serves /healthz only — it never reads configuration itself.
	 */
	deps?: AppDeps;
}

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
	const app = Fastify({
		logger: { level: opts.logLevel ?? 'info' }
	});

	app.get('/healthz', async () => ({
		ok: true,
		service: 'sandwichboard-api',
		time: new Date().toISOString()
	}));

	if (opts.deps) {
		registerErrorHandling(app);

		// Non-JSON bodies (file uploads) pass through as raw streams; routes
		// that want them read request.body as a Readable.
		app.addContentTypeParser('*', (_request, payload, done) => {
			done(null, payload);
		});

		const deps: RouteDeps = {
			db: opts.deps.db,
			storage: opts.deps.storage,
			fileTokens: new FileTokenSigner(),
			actor: 'operator'
		};
		registerSettingsRoutes(app, deps);
		registerAssetRoutes(app, deps);
		registerCopyVariantRoutes(app, deps);
		registerCreativeRoutes(app, deps);
		registerMetricsRoutes(app, deps);
		registerRecommendationRoutes(app, deps);
		registerInternalRoutes(app, {
			...deps,
			internalToken: opts.deps.internalToken,
			runMetaSync: opts.deps.runMetaSync
		});
	}

	return app;
}
