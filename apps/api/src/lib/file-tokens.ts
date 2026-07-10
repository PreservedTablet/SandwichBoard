import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived tokenized read URLs for stored files (docs/plan/06 Phase 1).
 *
 * The signing secret is generated per process on purpose: tokens are fetched
 * within minutes by the page that requested them, v1 runs a single API
 * instance (docs/plan/02), and a restart invalidating outstanding tokens
 * merely makes the UI request a fresh URL. Nothing to configure, nothing to
 * leak, no new secret in the manifest.
 */
export const FILE_TOKEN_TTL_SECONDS = 300;

export class FileTokenSigner {
	readonly #secret = randomBytes(32);

	#sign(assetId: string, exp: number): string {
		return createHmac('sha256', this.#secret).update(`${assetId}\n${exp}`).digest('base64url');
	}

	issue(
		assetId: string,
		ttlSeconds: number = FILE_TOKEN_TTL_SECONDS
	): { exp: number; sig: string } {
		const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
		return { exp, sig: this.#sign(assetId, exp) };
	}

	verify(assetId: string, exp: number, sig: string): boolean {
		if (!Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000)) {
			return false;
		}
		const expected = Buffer.from(this.#sign(assetId, exp));
		const given = Buffer.from(sig);
		return expected.length === given.length && timingSafeEqual(expected, given);
	}
}
