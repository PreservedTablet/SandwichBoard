import { createApi } from '$lib/api';
import { loaded } from '$lib/load-error';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	const api = createApi(fetch);
	const [{ items: assets }, { items: variants }] = await loaded(
		Promise.all([api.listAssets(), api.listCopyVariants()])
	);
	return {
		assets,
		headlines: variants.filter((variant) => variant.kind === 'headline'),
		primaryTexts: variants.filter((variant) => variant.kind === 'primary_text'),
		ctas: variants.filter((variant) => variant.kind === 'cta')
	};
};
