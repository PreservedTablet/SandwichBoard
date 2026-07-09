import { z } from 'zod';

/**
 * The single configuration boundary of SandwichBoard.
 *
 * Every process reads configuration exclusively through `loadConfig()` here.
 * Values are injected as environment variables at process start (Infisical
 * `infisical run -- …` on the happy path, a gitignored `.env` as fallback).
 * No other file may read `process.env`; no file may import an Infisical SDK.
 * The public manifest of these variables lives in `config/variables.md`.
 */

export const storageDrivers = ['local-fs', 's3', 'supabase-storage'] as const;
export type StorageDriver = (typeof storageDrivers)[number];

const optionalSecret = z.string().min(1).optional();

const configSchema = z
	.object({
		NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

		// API server bind address (non-secret, sensible local defaults)
		API_HOST: z.string().min(1).default('127.0.0.1'),
		API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),

		// Privileged application role — injected into apps/api only, never the browser
		DATABASE_URL: z
			.string()
			.min(1)
			.refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
				message: 'must be a postgres:// or postgresql:// connection string'
			}),

		// Read-only analyst role used by Claude sessions (wired in Phase 3)
		ANALYST_DATABASE_URL: optionalSecret,

		// Storage adapter selection + per-driver settings
		STORAGE_DRIVER: z.enum(storageDrivers).default('local-fs'),
		STORAGE_LOCAL_PATH: z.string().min(1).default('data/storage'),
		S3_ENDPOINT: optionalSecret,
		S3_BUCKET: optionalSecret,
		S3_ACCESS_KEY: optionalSecret,
		S3_SECRET_KEY: optionalSecret,
		SUPABASE_URL: optionalSecret,
		SUPABASE_SERVICE_ROLE_KEY: optionalSecret,

		// Ingestion (Phase 2)
		META_SYSTEM_USER_TOKEN: optionalSecret,
		META_AD_ACCOUNT_ID: optionalSecret,
		GOOGLE_ADS_DEVELOPER_TOKEN: optionalSecret,
		GOOGLE_PROJECT_ID: optionalSecret,
		GOOGLE_ADS_MCP_OAUTH_CLIENT_ID: optionalSecret,
		GOOGLE_ADS_MCP_OAUTH_CLIENT_SECRET: optionalSecret,

		// Publishing rail (Phase 5)
		POSTIZ_BASE_URL: optionalSecret,
		POSTIZ_API_KEY: optionalSecret,

		// HMAC secret for capture endpoints (Phase 4)
		INBOUND_CAPTURE_SECRET: optionalSecret
	})
	.superRefine((cfg, ctx) => {
		if (cfg.STORAGE_DRIVER === 's3') {
			for (const key of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const) {
				if (!cfg[key]) {
					ctx.addIssue({
						code: 'custom',
						path: [key],
						message: 'required when STORAGE_DRIVER=s3'
					});
				}
			}
		}
		if (cfg.STORAGE_DRIVER === 'supabase-storage') {
			for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const) {
				if (!cfg[key]) {
					ctx.addIssue({
						code: 'custom',
						path: [key],
						message: 'required when STORAGE_DRIVER=supabase-storage'
					});
				}
			}
		}
	});

export type AppConfig = z.infer<typeof configSchema>;

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConfigError';
	}
}

/**
 * Parse and validate configuration from an environment map.
 * Throws `ConfigError` listing variable names and problems — never values.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
	const parsed = configSchema.safeParse(env);
	if (!parsed.success) {
		const lines = parsed.error.issues.map(
			(issue) => `  ${issue.path.join('.') || '(config)'}: ${issue.message}`
		);
		throw new ConfigError(
			`Invalid configuration (variable names only, values are never printed):\n${lines.join('\n')}`
		);
	}
	return parsed.data;
}

function hostOf(connectionString: string): string {
	try {
		return new URL(connectionString).hostname || 'unknown';
	} catch {
		return 'unparseable';
	}
}

/**
 * A log-safe summary of the active configuration: presence and coarse,
 * non-secret facts only. Safe to print at boot.
 */
export function redactedConfigSummary(cfg: AppConfig): Record<string, string> {
	const summary: Record<string, string> = {
		NODE_ENV: cfg.NODE_ENV,
		api: `${cfg.API_HOST}:${cfg.API_PORT}`,
		DATABASE_URL: `set (host: ${hostOf(cfg.DATABASE_URL)})`,
		ANALYST_DATABASE_URL: cfg.ANALYST_DATABASE_URL ? 'set' : 'not set',
		STORAGE_DRIVER: cfg.STORAGE_DRIVER,
		POSTIZ_BASE_URL: cfg.POSTIZ_BASE_URL ?? 'not set',
		POSTIZ_API_KEY: cfg.POSTIZ_API_KEY ? 'set' : 'not set',
		INBOUND_CAPTURE_SECRET: cfg.INBOUND_CAPTURE_SECRET ? 'set' : 'not set'
	};
	if (cfg.STORAGE_DRIVER === 'local-fs') {
		summary.STORAGE_LOCAL_PATH = cfg.STORAGE_LOCAL_PATH;
	}
	return summary;
}
