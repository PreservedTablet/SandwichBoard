import { createApi } from '$lib/api';
import { loaded } from '$lib/load-error';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => {
	const api = createApi(fetch);
	const asset = await loaded(api.getAsset(params.id));
	return { asset };
};
