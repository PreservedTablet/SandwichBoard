import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * `pnpm analyze:open [--list]` — print the newest analysis report (or list
 * them all). Reports live in the gitignored `reports/` directory at the
 * repo root; they contain real spend data and never belong in the tree.
 * Plain stdout on purpose: works locally, over ssh, and in CI-less shells.
 */

const REPORT_NAME = /^\d{4}-\d{2}-\d{2}\.md$/;

async function findRepoRoot(startDir: string): Promise<string> {
	let dir = startDir;
	for (;;) {
		try {
			await stat(join(dir, 'pnpm-workspace.yaml'));
			return dir;
		} catch {
			const parent = dirname(dir);
			if (parent === dir) {
				throw new Error('could not locate repo root (pnpm-workspace.yaml) above ' + startDir);
			}
			dir = parent;
		}
	}
}

async function main(): Promise<void> {
	const list = process.argv.slice(2).includes('--list');
	const repoRoot = await findRepoRoot(dirname(fileURLToPath(import.meta.url)));
	const reportsDir = join(repoRoot, 'reports');

	let files: string[];
	try {
		files = (await readdir(reportsDir)).filter((f) => REPORT_NAME.test(f)).sort();
	} catch {
		files = [];
	}
	if (files.length === 0) {
		console.log(
			'no reports yet — run /analyze in a Claude Code session started with\n' +
				'  infisical run --env=dev --path=/analysis -- claude --mcp-config mcp-draft.json --strict-mcp-config\n' +
				'(prompts/analyze.md is the contract; reports/ is gitignored by design)'
		);
		process.exitCode = 1;
		return;
	}

	if (list) {
		for (const file of files) console.log(join('reports', file));
		return;
	}

	const latest = files[files.length - 1]!;
	console.log(`── reports/${latest} ${'─'.repeat(Math.max(0, 60 - latest.length))}\n`);
	console.log(await readFile(join(reportsDir, latest), 'utf8'));
}

const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : err);
		process.exitCode = 1;
	});
}
