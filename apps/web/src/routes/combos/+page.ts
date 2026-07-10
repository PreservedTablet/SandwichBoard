import { createApi } from '$lib/api';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const api = createApi(fetch);
	const status = url.searchParams.get('status');
	const qs = status ? `?status=${encodeURIComponent(status)}` : '';
	const { items } = await api.listCreatives(qs);
	return { creatives: items, activeStatus: status };
};
