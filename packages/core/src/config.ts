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

		// Tenancy scope for this deployment. v1 is single-operator: every row
		// the API reads/writes carries this org_id (docs/plan/03 keeps the
		// column so multi-tenancy is a retrofit-free future). The nil-UUID
		// default is fine for any solo deployment.
		ORG_ID: z.uuid().default('00000000-0000-0000-0000-000000000000'),

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

		// Guards POST /internal/* (the dashboard's "Sync now" and future
		// internal commands). Unset ⇒ those endpoints answer 503, loudly.
		INTERNAL_API_TOKEN: optionalSecret,

		// Ingestion (Phase 2). The Meta sync shells out to Meta's official
		// Ads CLI (`meta`, PyPI package meta-ads — docs/decisions/0005);
		// META_ADS_CLI_BIN overrides where to find it.
		META_SYSTEM_USER_TOKEN: optionalSecret,
		META_AD_ACCOUNT_ID: optionalSecret,
		META_ADS_CLI_BIN: z.string().min(1).default('meta'),
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

/**
 * OS plumbing (not configuration) for spawning pinned external CLIs: the
 * child gets PATH/HOME so its interpreter resolves, plus exactly the
 * credentials the caller passes — never the parent's full environment.
 * Lives here because this module is the single reader of `process.env`
 * (CLAUDE.md hard rule); these two names are deliberately not part of the
 * variable manifest.
 */
export function childProcessEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const passthrough: Record<string, string> = {};
	if (env.PATH) passthrough.PATH = env.PATH;
	if (env.HOME) passthrough.HOME = env.HOME;
	return passthrough;
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
		ORG_ID: cfg.ORG_ID,
		DATABASE_URL: `set (host: ${hostOf(cfg.DATABASE_URL)})`,
		ANALYST_DATABASE_URL: cfg.ANALYST_DATABASE_URL ? 'set' : 'not set',
		INTERNAL_API_TOKEN: cfg.INTERNAL_API_TOKEN ? 'set' : 'not set',
		META_SYSTEM_USER_TOKEN: cfg.META_SYSTEM_USER_TOKEN ? 'set' : 'not set',
		META_AD_ACCOUNT_ID: cfg.META_AD_ACCOUNT_ID ? 'set' : 'not set',
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
