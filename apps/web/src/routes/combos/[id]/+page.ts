import { createApi } from '$lib/api';
import { loaded } from '$lib/load-error';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => {
	const api = createApi(fetch);
	const creative = await loaded(api.getCreative(params.id));
	return { creative };
};
