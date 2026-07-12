/**
 * The operator's INTERNAL_API_TOKEN for POST /internal/* commands
 * (docs/decisions/0005 decision 2): pasted once, kept for this browser
 * session only — sessionStorage, never localStorage, never a cookie.
 */

const KEY = 'sandwichboard.internal_api_token';

export function getInternalToken(): string {
	return sessionStorage.getItem(KEY) ?? '';
}

export function storeInternalToken(token: string): void {
	sessionStorage.setItem(KEY, token);
}

export function clearInternalToken(): void {
	sessionStorage.removeItem(KEY);
}
