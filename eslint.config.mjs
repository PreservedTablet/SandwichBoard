import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

export default ts.config(
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	prettier,
	...svelte.configs.prettier,
	{
		languageOptions: {
			globals: { ...globals.node }
		}
	},
	{
		// apps/web renders client-side only (+layout.ts ssr=false)
		files: ['apps/web/src/**'],
		languageOptions: {
			globals: { ...globals.browser }
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		}
	},
	{
		ignores: [
			'**/node_modules/',
			'**/dist/',
			'**/build/',
			'**/.svelte-kit/',
			'**/data/',
			'**/coverage/'
		]
	}
);
