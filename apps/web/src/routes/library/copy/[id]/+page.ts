import { createApi } from '$lib/api';
import { loaded } from '$lib/load-error';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => {
	const api = createApi(fetch);
	const variant = await loaded(api.getCopyVariant(params.id));
	return { variant };
};
