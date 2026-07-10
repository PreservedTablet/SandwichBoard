import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { StorageAdapter, StorageObjectStat } from '@sandwichboard/core';

export class StorageKeyError extends Error {
	constructor(key: string, reason: string) {
		super(`invalid storage key ${JSON.stringify(key)}: ${reason}`);
		this.name = 'StorageKeyError';
	}
}

// Forward-slash relative paths; each segment starts alphanumeric. No leading
// slash, no dotfiles, no '..', no empty segments.
const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/;

export function assertSafeKey(key: string): void {
	if (key.length === 0 || key.length > 512) {
		throw new StorageKeyError(key, 'must be 1-512 characters');
	}
	if (!KEY_PATTERN.test(key)) {
		throw new StorageKeyError(
			key,
			'must be a relative forward-slash path of alphanumeric/._- segments'
		);
	}
	if (key.split('/').some((segment) => segment === '..' || segment.includes('..'))) {
		throw new StorageKeyError(key, 'path traversal is not allowed');
	}
}

export class LocalFsStorage implements StorageAdapter {
	readonly driver = 'local-fs' as const;
	readonly #root: string;

	constructor(rootDir: string) {
		this.#root = resolve(rootDir);
	}

	#pathFor(key: string): string {
		assertSafeKey(key);
		const abs = resolve(this.#root, key);
		if (!abs.startsWith(this.#root + sep)) {
			throw new StorageKeyError(key, 'resolves outside the storage root');
		}
		return abs;
	}

	async put(key: string, body: Buffer | Readable): Promise<void> {
		const path = this.#pathFor(key);
		await mkdir(dirname(path), { recursive: true });
		if (Buffer.isBuffer(body)) {
			await writeFile(path, body);
		} else {
			await pipeline(body, createWriteStream(path));
		}
	}

	async getStream(key: string): Promise<Readable> {
		const path = this.#pathFor(key);
		await stat(path); // throws ENOENT for missing objects before a stream errors lazily
		return createReadStream(path);
	}

	async exists(key: string): Promise<boolean> {
		return (await this.stat(key)) !== null;
	}

	async stat(key: string): Promise<StorageObjectStat | null> {
		const path = this.#pathFor(key);
		try {
			const s = await stat(path);
			if (!s.isFile()) return null;
			return { size: s.size, modifiedAt: s.mtime };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw err;
		}
	}

	async delete(key: string): Promise<void> {
		const path = this.#pathFor(key);
		await rm(path, { force: true });
	}
}
