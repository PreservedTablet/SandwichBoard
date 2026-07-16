// Internal single-operator dashboard: render fully client-side so every data
// fetch is a plain same-origin `/api/*` call (vite proxy in dev, reverse
// proxy in production) and the web server needs no configuration at all.
export const ssr = false;

import { createApi, type SyncStatus } from '$lib/api';
import type { LayoutLoad } from './$types';

/**
 * Sync status feeds the staleness banner on every page. It loads here — in
 * the invalidation graph, keyed 'app:sync-status' — so mutations that change
 * it (CSV ingest, deadletter resolve, Sync now) refresh the banner via
 * invalidate/invalidateAll instead of leaving it stale until a hard reload.
 * Failures never throw: a broken API turns into a banner message, not a
 * dead app shell.
 */
export const load: LayoutLoad = async ({ fetch, depends }) => {
	depends('app:sync-status');
	const api = createApi(fetch);
	try {
		return { syncStatus: (await api.syncStatus()) as SyncStatus | null, syncStatusError: null };
	} catch (err) {
		return {
			syncStatus: null,
			syncStatusError: err instanceof Error ? err.message : 'failed to load sync status'
		};
	}
};
