import { recommendationStatuses, type RecommendationStatus } from '@sandwichboard/core';
import { createApi } from '$lib/api';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const api = createApi(fetch);
	const requested = url.searchParams.get('status');
	const status = recommendationStatuses.includes(requested as RecommendationStatus)
		? (requested as RecommendationStatus)
		: undefined;
	const { items } = await api.listRecommendations(status);
	return { recommendations: items, activeStatus: status ?? null };
};
