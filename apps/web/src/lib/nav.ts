import type { ResolvedPathname } from '$app/types';

/**
 * Append a query string to an already-`resolve()`d pathname without losing
 * the ResolvedPathname brand — `resolve()` itself types pathnames only, and
 * `svelte/no-navigation-without-resolve` (rightly) rejects raw strings.
 */
export function withQuery(path: ResolvedPathname, params: URLSearchParams): ResolvedPathname {
	const qs = params.size > 0 ? `?${params}` : '';
	return `${path}${qs}` as ResolvedPathname;
}
