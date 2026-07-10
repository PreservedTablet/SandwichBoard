import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// adapter-node: SandwichBoard is self-hosted (docs/plan/02).
			adapter: adapter()
		})
	],

	server: {
		proxy: {
			// Dev-only: the browser talks same-origin `/api/*`; in production a
			// reverse proxy (Caddy/Tunnel, docs/plan/02) does the same mapping.
			// 3000 mirrors the API_PORT default in packages/core/src/config.ts —
			// only config.ts may read env, so the dev proxy states the default.
			'/api': 'http://127.0.0.1:3000'
		}
	}
});
