import Fastify, { type FastifyInstance } from 'fastify';

export interface BuildAppOptions {
	/** Pino level; tests pass 'silent'. */
	logLevel?: string;
}

/**
 * Constructs the Fastify app without reading any configuration — everything
 * environment-dependent is passed in by the caller (see src/server.ts).
 */
export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
	const app = Fastify({
		logger: { level: opts.logLevel ?? 'info' }
	});

	app.get('/healthz', async () => ({
		ok: true,
		service: 'sandwichboard-api',
		time: new Date().toISOString()
	}));

	return app;
}
