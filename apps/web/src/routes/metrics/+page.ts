import { createApi, type LeaderboardPlatform } from '$lib/api';
import { loaded } from '$lib/load-error';
import type { PageLoad } from './$types';

const PLATFORMS: LeaderboardPlatform[] = ['all', 'meta', 'google'];

export const load: PageLoad = async ({ fetch, url }) => {
	const api = createApi(fetch);
	const requested = url.searchParams.get('platform');
	const platform: LeaderboardPlatform = PLATFORMS.includes(requested as LeaderboardPlatform)
		? (requested as LeaderboardPlatform)
		: 'all';
	const [leaderboard, daily, unmatched, deadletters, status] = await loaded(
		Promise.all([
			api.leaderboard(platform),
			api.metricsDaily(platform, 30),
			api.unmatchedAds(),
			api.deadletters(false),
			api.syncStatus()
		])
	);
	return { platform, leaderboard, daily, unmatched, deadletters, status };
};
