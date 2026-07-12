import type {
	AssetRow,
	CopyVariantRow,
	CreativeListItem,
	AdNameParts,
	UtmParams
} from '@sandwichboard/core';

/**
 * Thin client for apps/api. Always same-origin `/api/*`: the vite dev server
 * proxies to the API locally and a reverse proxy does it in production
 * (docs/plan/02) — the web app reads no configuration at all.
 */

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly body: {
			error?: string;
			message?: string;
			issues?: { path: string; message: string }[];
			/** file:line validation problems (CSV ingestion). */
			problems?: string[];
		}
	) {
		super(
			body.message ??
				body.problems?.join('\n') ??
				body.issues?.map((issue) => `${issue.path}: ${issue.message}`).join('; ') ??
				`request failed (${status})`
		);
		this.name = 'ApiError';
	}
}

type Fetch = typeof fetch;

async function request<T>(
	fetchFn: Fetch,
	method: string,
	path: string,
	body?: unknown
): Promise<T> {
	const res = await fetchFn(path, {
		method,
		headers: body === undefined ? undefined : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	if (res.status === 204) return undefined as T;
	const json = (await res.json()) as T;
	if (!res.ok) throw new ApiError(res.status, json as ApiError['body']);
	return json;
}

export interface AdNameResponse {
	ad_name: string;
	parts: AdNameParts;
	round_trip_ok: boolean;
	utm_params: UtmParams;
	utm_query: string;
	url: string | null;
}

export interface SettingRow {
	key: string;
	value: unknown;
	updated_at: string;
}

/** Summary of one sync run (audit payload / POST /internal/ingest/meta). */
export interface SyncRunSummary {
	platform: string;
	trigger: 'api' | 'cli';
	account: {
		external_account_id: string;
		label: string;
		currency: string | null;
		timezone: string | null;
	};
	range: { since: string; until: string };
	watermark: string | null;
	campaigns_synced: number;
	ads_synced: number;
	ads_matched: number;
	ads_unmatched: number;
	snapshot_rows_upserted: number;
	deadletters: number;
	duration_ms: number;
}

export interface SyncPlatformStatus {
	platform: string;
	method: 'sync' | 'csv-upload';
	configured: boolean;
	data_through: string | null;
	last_success_at: string | null;
	last_success_summary: SyncRunSummary | GoogleCsvSummary | null;
	last_failure_at: string | null;
	last_failure_error: string | null;
}

export interface SyncStatus {
	data_through: string | null;
	unmatched_ads: number;
	open_deadletters: number;
	platforms: SyncPlatformStatus[];
}

/** Summary of one Google CSV upload (audit payload / ingest response). */
export interface GoogleCsvSummary {
	platform: string;
	trigger: 'api' | 'cli';
	account: { external_account_id: string; label: string };
	range: { since: string; until: string };
	rows: number;
	campaigns_synced: number;
	ads_synced: number;
	ads_matched: number;
	ads_unmatched: number;
	snapshot_rows_upserted: number;
	filename: string | null;
	duration_ms: number;
}

export type LeaderboardPlatform = 'all' | 'meta' | 'google' | 'tiktok' | 'reddit_ads';

export interface LeaderboardRow {
	creative_id: string;
	short_code: string;
	creative_status: string;
	angle: string | null;
	platform: string;
	ad_count: number;
	days_with_delivery: number;
	first_date: string;
	last_date: string;
	spend_cents: number;
	impressions: number;
	clicks: number;
	conversions: number;
	conversion_value_cents: number | null;
	ctr: number | null;
	cpc_cents: number | null;
	cpm_cents: number | null;
	cpa_cents: number | null;
}

export interface DailyRow {
	creative_id: string;
	date: string;
	spend_cents: number;
	impressions: number;
	clicks: number;
}

export interface UnmatchedAdRow {
	ad_entity_id: string;
	platform: string;
	external_ad_id: string;
	ad_name: string;
	first_seen: string;
	match_failure_code: string;
	match_failure_reason: string | null;
	account_label: string;
	campaign_name: string | null;
}

export interface DeadletterRow {
	id: string;
	platform: string;
	payload: Record<string, unknown>;
	error: string;
	created_at: string;
	resolved: boolean;
}

export function createApi(fetchFn: Fetch = fetch) {
	return {
		listSettings: () => request<{ items: SettingRow[] }>(fetchFn, 'GET', '/api/settings'),
		putSetting: (key: string, value: unknown) =>
			request<SettingRow>(fetchFn, 'PUT', `/api/settings/${key}`, { value }),

		listAssets: (query = '') =>
			request<{ items: AssetRow[] }>(fetchFn, 'GET', `/api/assets${query}`),
		getAsset: (id: string) => request<AssetRow>(fetchFn, 'GET', `/api/assets/${id}`),
		createAsset: (body: unknown) => request<AssetRow>(fetchFn, 'POST', '/api/assets', body),
		updateAsset: (id: string, patch: unknown) =>
			request<AssetRow>(fetchFn, 'PATCH', `/api/assets/${id}`, patch),
		deleteAsset: (id: string) => request<void>(fetchFn, 'DELETE', `/api/assets/${id}`),
		getAssetFileUrl: (id: string) =>
			request<{ url: string; expires_at: string }>(fetchFn, 'GET', `/api/assets/${id}/file-url`),
		uploadAssetFile: async (id: string, file: File): Promise<AssetRow> => {
			const res = await fetchFn(`/api/assets/${id}/file`, {
				method: 'PUT',
				headers: { 'content-type': file.type || 'application/octet-stream' },
				body: file
			});
			const json = await res.json();
			if (!res.ok) throw new ApiError(res.status, json);
			return json as AssetRow;
		},

		listCopyVariants: (query = '') =>
			request<{ items: CopyVariantRow[] }>(fetchFn, 'GET', `/api/copy-variants${query}`),
		getCopyVariant: (id: string) =>
			request<CopyVariantRow>(fetchFn, 'GET', `/api/copy-variants/${id}`),
		createCopyVariant: (body: unknown) =>
			request<CopyVariantRow>(fetchFn, 'POST', '/api/copy-variants', body),
		updateCopyVariant: (id: string, patch: unknown) =>
			request<CopyVariantRow>(fetchFn, 'PATCH', `/api/copy-variants/${id}`, patch),
		deleteCopyVariant: (id: string) => request<void>(fetchFn, 'DELETE', `/api/copy-variants/${id}`),

		listCreatives: (query = '') =>
			request<{ items: CreativeListItem[] }>(fetchFn, 'GET', `/api/creatives${query}`),
		getCreative: (id: string) => request<CreativeListItem>(fetchFn, 'GET', `/api/creatives/${id}`),
		createCreative: (body: unknown) =>
			request<CreativeListItem>(fetchFn, 'POST', '/api/creatives', body),
		updateCreative: (id: string, patch: unknown) =>
			request<CreativeListItem>(fetchFn, 'PATCH', `/api/creatives/${id}`, patch),
		deleteCreative: (id: string) => request<void>(fetchFn, 'DELETE', `/api/creatives/${id}`),
		adName: (id: string, params: URLSearchParams) =>
			request<AdNameResponse>(fetchFn, 'GET', `/api/creatives/${id}/ad-name?${params}`),

		syncStatus: () => request<SyncStatus>(fetchFn, 'GET', '/api/sync/status'),

		leaderboard: (platform: LeaderboardPlatform) =>
			request<{ platform: string; items: LeaderboardRow[]; combos_below_gate: number }>(
				fetchFn,
				'GET',
				`/api/metrics/leaderboard?platform=${platform}`
			),
		metricsDaily: (platform: LeaderboardPlatform, days = 30) =>
			request<{ items: DailyRow[] }>(
				fetchFn,
				'GET',
				`/api/metrics/daily?platform=${platform}&days=${days}`
			),
		unmatchedAds: () =>
			request<{ items: UnmatchedAdRow[] }>(fetchFn, 'GET', '/api/metrics/unmatched'),
		deadletters: (resolved = false) =>
			request<{ items: DeadletterRow[] }>(
				fetchFn,
				'GET',
				`/api/metrics/deadletters?resolved=${resolved}`
			),
		setDeadletterResolved: (id: string, resolved: boolean) =>
			request<{ id: string; resolved: boolean }>(
				fetchFn,
				'PATCH',
				`/api/metrics/deadletters/${id}`,
				{ resolved }
			),

		// /internal/* is a command surface guarded by a bearer token the
		// operator pastes once per browser session (docs/decisions/0005).
		runMetaSync: async (internalToken: string): Promise<SyncRunSummary> => {
			const res = await fetchFn('/internal/ingest/meta', {
				method: 'POST',
				headers: { authorization: `Bearer ${internalToken}` }
			});
			const json = await res.json();
			if (!res.ok) throw new ApiError(res.status, json);
			return json as SyncRunSummary;
		},
		ingestGoogleCsv: async (
			internalToken: string,
			params: { externalAccountId: string; label?: string; filename?: string },
			csvText: string
		): Promise<GoogleCsvSummary> => {
			const qs = new URLSearchParams({ external_account_id: params.externalAccountId });
			if (params.label) qs.set('label', params.label);
			if (params.filename) qs.set('filename', params.filename);
			const res = await fetchFn(`/internal/ingest/google-csv?${qs}`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${internalToken}`,
					'content-type': 'text/csv'
				},
				body: csvText
			});
			const json = await res.json();
			if (!res.ok) throw new ApiError(res.status, json);
			return json as GoogleCsvSummary;
		}
	};
}

export const api = createApi();
