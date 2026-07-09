import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFsStorage, StorageKeyError } from '../src/storage/local-fs.js';
import { createStorageAdapter } from '../src/storage/index.js';

let root: string;
let storage: LocalFsStorage;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'sandwichboard-storage-'));
	storage = new LocalFsStorage(root);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) {
		chunks.push(Buffer.from(chunk as Buffer));
	}
	return Buffer.concat(chunks);
}

describe('LocalFsStorage', () => {
	it('round-trips a buffer', async () => {
		const body = Buffer.from('sandwich contents');
		await storage.put('assets/originals/demo.txt', body);

		expect(await storage.exists('assets/originals/demo.txt')).toBe(true);
		const s = await storage.stat('assets/originals/demo.txt');
		expect(s?.size).toBe(body.length);

		const roundTripped = await readAll(await storage.getStream('assets/originals/demo.txt'));
		expect(roundTripped.equals(body)).toBe(true);
	});

	it('round-trips a stream', async () => {
		await storage.put(
			'assets/streamed.bin',
			Readable.from([Buffer.from('abc'), Buffer.from('def')])
		);
		const roundTripped = await readAll(await storage.getStream('assets/streamed.bin'));
		expect(roundTripped.toString()).toBe('abcdef');
	});

	it('stat returns null and exists false for missing keys', async () => {
		expect(await storage.stat('nope/missing.txt')).toBeNull();
		expect(await storage.exists('nope/missing.txt')).toBe(false);
	});

	it('delete is idempotent', async () => {
		await storage.put('a/b.txt', Buffer.from('x'));
		await storage.delete('a/b.txt');
		await storage.delete('a/b.txt'); // second delete: no throw
		expect(await storage.exists('a/b.txt')).toBe(false);
	});

	it.each([
		'../escape.txt',
		'a/../../escape.txt',
		'/etc/passwd',
		'a//b.txt',
		'.hidden',
		'a/.hidden/b.txt',
		'',
		'a/b..txt/c'
	])('rejects unsafe key %j', async (key) => {
		await expect(storage.put(key, Buffer.from('x'))).rejects.toBeInstanceOf(StorageKeyError);
	});
});

describe('createStorageAdapter', () => {
	it('builds the local-fs driver from config shape', () => {
		const adapter = createStorageAdapter({
			STORAGE_DRIVER: 'local-fs',
			STORAGE_LOCAL_PATH: root
		});
		expect(adapter.driver).toBe('local-fs');
	});

	it('refuses unimplemented drivers loudly', () => {
		expect(() =>
			createStorageAdapter({ STORAGE_DRIVER: 's3', STORAGE_LOCAL_PATH: root })
		).toThrowError(/not yet implemented/);
	});
});
