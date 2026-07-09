import type { Readable } from 'node:stream';
import type { StorageDriver } from './config.js';

/**
 * File storage sits behind this tiny adapter (docs/plan/02). Drivers live in
 * `apps/api/src/storage/*` so that `@sandwichboard/core` stays free of
 * platform SDKs; this file defines the contract only.
 *
 * Keys are forward-slash relative paths (`assets/originals/abc.jpg`).
 * Drivers must reject traversal and absolute keys.
 */
export interface StorageObjectStat {
	size: number;
	modifiedAt: Date;
}

export interface StorageAdapter {
	readonly driver: StorageDriver;
	put(key: string, body: Buffer | Readable, opts?: { contentType?: string }): Promise<void>;
	getStream(key: string): Promise<Readable>;
	exists(key: string): Promise<boolean>;
	/** Returns null when the object does not exist. */
	stat(key: string): Promise<StorageObjectStat | null>;
	/** Deleting a missing key is a no-op, not an error. */
	delete(key: string): Promise<void>;
}
