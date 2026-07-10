import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import {
	childProcessEnv,
	metaAdAccountSchema,
	metaAdSchema,
	metaCampaignSchema,
	metaInsightsResponseSchema,
	type MetaAd,
	type MetaAdAccount,
	type MetaCampaign,
	type MetaInsightsRow
} from '@sandwichboard/core';
import type { z } from 'zod';

const execFileAsync = promisify(execFile);

/**
 * Read-only Meta access for the manual range sync, behind one interface so
 * tests (and a hypothetical Plan B) swap implementations freely
 * (docs/plan/02 decision 5). The real implementation shells out to Meta's
 * official Ads CLI (`meta-ads==1.1.0`) — auth model and full command
 * contract verified in docs/decisions/0005.
 */
export interface MetaConnector {
	/** Auth preflight + account facts (name, currency, timezone). */
	getAccountInfo(): Promise<MetaAdAccount>;
	listCampaigns(): Promise<MetaCampaign[]>;
	listAds(): Promise<MetaAd[]>;
	/** Daily rows for one ad, `since`..`until` inclusive (YYYY-MM-DD). */
	getAdInsightsDaily(adId: string, since: string, until: string): Promise<MetaInsightsRow[]>;
}

export type MetaCliErrorKind =
	| 'auth' // bad/expired token — never retried, aborts the run
	| 'not-installed' // the CLI binary is missing from this machine
	| 'timeout'
	| 'invocation' // nonzero exit for any other reason (network, 5xx, …)
	| 'output'; // exit 0 but unusable stdout (bad JSON, wrong shape, paging overflow)

export class MetaCliError extends Error {
	constructor(
		message: string,
		readonly kind: MetaCliErrorKind,
		readonly detail?: string
	) {
		super(message);
		this.name = 'MetaCliError';
	}
}

// The Insights fields the warehouse normalizes (packages/core/src/meta.ts);
// ctr/cpc/cpm are computed by the views, never fetched.
const INSIGHTS_FIELDS =
	'ad_id,ad_name,spend,impressions,clicks,actions,action_values,video_thruplay_watched_actions';
const CAMPAIGN_FIELDS = 'id,name,objective,status,daily_budget';
const AD_FIELDS = 'id,name,adset_id,campaign_id,effective_status';

// One page must always be enough: a 90-day backfill at time_increment=1 is
// 90 rows per ad, and this deployment's account holds tens of ads. If a
// response ever paginates (or a list comes back at the ceiling), the run
// fails loudly rather than silently truncating the warehouse.
const PAGE_LIMIT = 500;

// The CLI prints machine-readable-ish errors to stderr; these mark auth
// failures (Marketing API OAuthException / error code 190, or the CLI's own
// missing-token message), which retrying cannot fix.
const AUTH_ERROR_PATTERN = /OAuthException|\bcode[":\s]+190\b|Set the ACCESS_TOKEN/i;

export interface MetaCliConnectorOptions {
	/** CLI binary (config META_ADS_CLI_BIN; default 'meta' on PATH). */
	bin: string;
	/** System-user token, ads_read scope (config META_SYSTEM_USER_TOKEN). */
	accessToken: string;
	/** act_… id (config META_AD_ACCOUNT_ID). */
	adAccountId: string;
	/** Per-invocation timeout; a stuck CLI must not wedge a manual sync. */
	timeoutMs?: number;
	/** Backoff schedule between retries of transient failures. */
	retryDelaysMs?: readonly number[];
}

export class MetaCliConnector implements MetaConnector {
	private readonly timeoutMs: number;
	private readonly retryDelaysMs: readonly number[];

	constructor(private readonly opts: MetaCliConnectorOptions) {
		this.timeoutMs = opts.timeoutMs ?? 120_000;
		this.retryDelaysMs = opts.retryDelaysMs ?? [2_000, 4_000];
	}

	async getAccountInfo(): Promise<MetaAdAccount> {
		// `adaccount get` prints an array of one (docs/decisions/0005).
		const parsed = await this.invokeJson(
			['ads', 'adaccount', 'get'],
			metaAdAccountSchema.array().min(1)
		);
		return parsed[0]!;
	}

	async listCampaigns(): Promise<MetaCampaign[]> {
		const campaigns = await this.invokeJson(
			['ads', 'campaign', 'list', '--limit', String(PAGE_LIMIT), '--fields', CAMPAIGN_FIELDS],
			metaCampaignSchema.array()
		);
		this.assertUnderPageLimit('campaign list', campaigns.length);
		return campaigns;
	}

	async listAds(): Promise<MetaAd[]> {
		const ads = await this.invokeJson(
			['ads', 'ad', 'list', '--limit', String(PAGE_LIMIT), '--fields', AD_FIELDS],
			metaAdSchema.array()
		);
		this.assertUnderPageLimit('ad list', ads.length);
		return ads;
	}

	async getAdInsightsDaily(adId: string, since: string, until: string): Promise<MetaInsightsRow[]> {
		const response = await this.invokeJson(
			[
				'ads',
				'insights',
				'get',
				'--ad-id',
				adId,
				'--since',
				since,
				'--until',
				until,
				'--time-increment',
				'daily',
				'--limit',
				String(PAGE_LIMIT),
				'--fields',
				INSIGHTS_FIELDS
			],
			metaInsightsResponseSchema
		);
		if (response.paging?.next) {
			throw new MetaCliError(
				`insights for ad ${adId} paginated beyond one page (${response.data.length} rows, limit ${PAGE_LIMIT}) — refusing to silently truncate`,
				'output'
			);
		}
		return response.data;
	}

	private assertUnderPageLimit(what: string, count: number): void {
		if (count >= PAGE_LIMIT) {
			throw new MetaCliError(
				`${what} returned ${count} rows, the single-page ceiling — later rows may exist; refusing to silently truncate`,
				'output'
			);
		}
	}

	private async invokeJson<S extends z.ZodType>(args: string[], schema: S): Promise<z.infer<S>> {
		const stdout = await this.invoke(args);
		let json: unknown;
		try {
			json = JSON.parse(stdout);
		} catch {
			throw new MetaCliError(
				`meta ${args.join(' ')} printed non-JSON output`,
				'output',
				stdout.slice(0, 2000)
			);
		}
		const parsed = schema.safeParse(json);
		if (!parsed.success) {
			throw new MetaCliError(
				`meta ${args.join(' ')} output did not match the recorded contract (docs/decisions/0005): ${parsed.error.issues
					.slice(0, 3)
					.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
					.join('; ')}`,
				'output'
			);
		}
		return parsed.data;
	}

	/**
	 * Run the CLI once per attempt, retrying transient failures with backoff.
	 * Reads only — the never-auto-retry guardrail binds platform writes,
	 * which this connector cannot perform.
	 */
	private async invoke(args: string[]): Promise<string> {
		const fullArgs = ['--output', 'json', '--no-input', '--no-color', ...args];
		let lastError: MetaCliError | undefined;
		for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
			if (attempt > 0) {
				await new Promise((resolveDelay) =>
					setTimeout(resolveDelay, this.retryDelaysMs[attempt - 1])
				);
			}
			try {
				return await this.invokeOnce(fullArgs);
			} catch (err) {
				if (!(err instanceof MetaCliError)) throw err;
				if (err.kind === 'auth' || err.kind === 'not-installed' || err.kind === 'output') {
					throw err; // retrying cannot change these
				}
				lastError = err;
			}
		}
		throw lastError!;
	}

	private async invokeOnce(args: string[]): Promise<string> {
		try {
			const { stdout } = await execFileAsync(this.opts.bin, args, {
				timeout: this.timeoutMs,
				maxBuffer: 64 * 1024 * 1024,
				// Deterministic child environment: exactly the credentials from
				// config plus PATH/HOME so the interpreter resolves — never the
				// operator's full shell env, and a neutral cwd so the CLI's
				// .env-file discovery cannot pick up strays from the repo
				// (docs/decisions/0005 decision 1).
				cwd: tmpdir(),
				env: {
					...childProcessEnv(),
					ACCESS_TOKEN: this.opts.accessToken,
					AD_ACCOUNT_ID: this.opts.adAccountId
				}
			});
			return stdout;
		} catch (err) {
			throw this.classify(err, args);
		}
	}

	private classify(err: unknown, args: string[]): MetaCliError {
		const e = err as NodeJS.ErrnoException & {
			killed?: boolean;
			signal?: string;
			code?: string | number;
			stdout?: string;
			stderr?: string;
		};
		const command = `${this.opts.bin} ${args.join(' ')}`;
		if (e.code === 'ENOENT') {
			return new MetaCliError(
				`Meta Ads CLI not found at ${JSON.stringify(this.opts.bin)} — install the pinned version (uv tool install 'meta-ads==1.1.0', Python ≥3.12) or set META_ADS_CLI_BIN (docs/setup.md)`,
				'not-installed'
			);
		}
		if (e.killed || e.signal === 'SIGTERM') {
			return new MetaCliError(`${command} timed out after ${this.timeoutMs}ms`, 'timeout');
		}
		const detail = [e.stderr, e.stdout].filter(Boolean).join('\n').trim();
		if (AUTH_ERROR_PATTERN.test(detail)) {
			return new MetaCliError(
				`Meta rejected the credentials (check META_SYSTEM_USER_TOKEN — ads_read system-user token, docs/decisions/0005)`,
				'auth',
				detail.slice(0, 2000)
			);
		}
		return new MetaCliError(
			`${command} failed (exit ${String(e.code ?? 'unknown')})`,
			'invocation',
			detail.slice(0, 2000)
		);
	}
}
