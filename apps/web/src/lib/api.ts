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
		}
	) {
		super(
			body.message ??
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
	configured: boolean;
	last_success_at: string | null;
	last_success_summary: SyncRunSummary | null;
	last_failure_at: string | null;
	last_failure_error: string | null;
}

export interface SyncStatus {
	data_through: string | null;
	unmatched_ads: number;
	open_deadletters: number;
	platforms: SyncPlatformStatus[];
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
		}
	};
}

export const api = createApi();
