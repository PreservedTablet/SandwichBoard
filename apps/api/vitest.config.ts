import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts']
	},
	resolve: {
		alias: {
			// Tests resolve core from source so `pnpm test` works on a fresh
			// clone without a prior build step.
			'@sandwichboard/core': resolve(import.meta.dirname, '../../packages/core/src/index.ts')
		}
	}
});
