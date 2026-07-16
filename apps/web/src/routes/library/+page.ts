import { createApi } from '$lib/api';
import { loaded } from '$lib/load-error';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const api = createApi(fetch);
	const query = new URLSearchParams();
	const kind = url.searchParams.get('kind');
	if (kind) query.set('kind', kind);
	for (const tag of url.searchParams.getAll('tag')) query.append('tag', tag);
	const qs = query.size > 0 ? `?${query}` : '';
	const { items } = await loaded(api.listAssets(qs));
	return {
		assets: items,
		activeKind: kind,
		activeTags: url.searchParams.getAll('tag'),
		// Production-status filtering happens client-side so the chip counts
		// always reflect the whole (kind/tag-filtered) set.
		activeStatus: url.searchParams.get('status')
	};
};
