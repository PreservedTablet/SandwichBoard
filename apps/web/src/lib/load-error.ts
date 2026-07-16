import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api';

/**
 * Adapt load-time failures into SvelteKit's error flow so the root
 * +error.svelte shows the real status and message instead of a redacted
 * "500 Internal Error": an ApiError keeps its status (a deleted combo is a
 * 404, not a crash), and a network-level failure — the API restarting is a
 * normal state for a single-instance self-hosted stack — reads as 503 with
 * a hint instead of an opaque TypeError.
 */
export async function loaded<T>(promise: Promise<T>): Promise<T> {
	try {
		return await promise;
	} catch (err) {
		if (err instanceof ApiError) {
			error(err.status >= 400 && err.status <= 599 ? err.status : 500, err.message);
		}
		if (err instanceof TypeError) {
			error(503, 'API unreachable — is apps/api running? (`pnpm dev` boots both apps)');
		}
		throw err;
	}
}
