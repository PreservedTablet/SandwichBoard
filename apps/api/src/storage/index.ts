import type { AppConfig, StorageAdapter } from '@sandwichboard/core';
import { LocalFsStorage } from './local-fs.js';

export type StorageConfig = Pick<AppConfig, 'STORAGE_DRIVER' | 'STORAGE_LOCAL_PATH'>;

export function createStorageAdapter(config: StorageConfig): StorageAdapter {
	switch (config.STORAGE_DRIVER) {
		case 'local-fs':
			return new LocalFsStorage(config.STORAGE_LOCAL_PATH);
		case 's3':
		case 'supabase-storage':
			throw new Error(
				`storage driver "${config.STORAGE_DRIVER}" is planned but not yet implemented — ` +
					'Phase 0 ships local-fs only (docs/plan/06-BUILD-PLAN.md)'
			);
	}
}

export { LocalFsStorage, StorageKeyError, assertSafeKey } from './local-fs.js';
