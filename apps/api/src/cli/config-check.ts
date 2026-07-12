import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configReadiness, type FeatureReadiness } from '@sandwichboard/core';
import pg from 'pg';
import { orderMigrations } from '../db/migrate.js';

/**
 * `pnpm config:check [--db]` — the clone-and-go diagnostic: report which
 * features the injected environment enables, per the public manifest
 * (config/variables.md). Prints variable NAMES only, never values. With
 * `--db` it also connects to DATABASE_URL and compares applied migrations
 * against db/migrations/.
 *
 * Exit code 0 when the core (database) configuration is present; 1 when it
 * isn't or --db finds the database unreachable/behind — optional features
 * being unset is normal, not an error.
 */

const MARK: Record<FeatureReadiness['status'], string> = {
	ready: '✓',
	incomplete: '✗',
	not_configured: '–'
};

function printReadiness(features: FeatureReadiness[]): boolean {
	let coreReady = true;
	for (const feature of features) {
		const lines = [
			`${MARK[feature.status]} ${feature.feature}: ${feature.status.replace('_', ' ')}`
		];
		if (feature.missing.length > 0) lines.push(`    missing: ${feature.missing.join(', ')}`);
		if (feature.note) lines.push(`    ${feature.note}`);
		console.log(lines.join('\n'));
		if (feature.status === 'incomplete' && feature.feature.startsWith('core')) coreReady = false;
	}
	return coreReady;
}

async function findRepoRoot(startDir: string): Promise<string> {
	let dir = startDir;
	for (;;) {
		try {
			await readdir(join(dir, 'db', 'migrations'));
			return dir;
		} catch {
			const parent = dirname(dir);
			if (parent === dir) throw new Error('could not locate db/migrations above ' + startDir);
			dir = parent;
		}
	}
}

async function checkDatabase(databaseUrl: string): Promise<boolean> {
	const repoRoot = await findRepoRoot(dirname(fileURLToPath(import.meta.url)));
	const files = orderMigrations(await readdir(join(repoRoot, 'db', 'migrations')));
	const client = new pg.Client({ connectionString: databaseUrl });
	try {
		await client.connect();
	} catch (err) {
		console.log(`✗ database: unreachable (${err instanceof Error ? err.message : 'error'})`);
		return false;
	}
	try {
		const { rows } = await client.query<{ filename: string }>(
			`select filename from schema_migrations order by filename`
		);
		const applied = new Set(rows.map((r) => r.filename));
		const pending = files.filter((f) => !applied.has(f));
		if (pending.length === 0) {
			console.log(`✓ database: reachable, all ${files.length} migrations applied`);
			return true;
		}
		console.log(
			`✗ database: reachable, ${pending.length} migration(s) pending — run pnpm db:migrate\n    pending: ${pending.join(', ')}`
		);
		return false;
	} catch {
		console.log('✗ database: reachable but schema_migrations is missing — run pnpm db:migrate');
		return false;
	} finally {
		await client.end();
	}
}

async function main(): Promise<void> {
	const withDb = process.argv.slice(2).includes('--db');
	console.log('SandwichBoard configuration readiness (names only, values never shown)\n');
	const features = configReadiness();
	let ok = printReadiness(features);
	if (withDb) {
		console.log('');
		const dbUrl = features.find((f) => f.feature.startsWith('core'))?.status === 'ready';
		if (!dbUrl) {
			console.log('✗ database: skipped — DATABASE_URL is not set');
			ok = false;
		} else {
			// The one sanctioned env read happens in core; reuse its parsing by
			// loading the validated config for the URL.
			const { loadConfig } = await import('@sandwichboard/core');
			ok = (await checkDatabase(loadConfig().DATABASE_URL)) && ok;
		}
	}
	console.log(
		'\nManifest: config/variables.md · Setup: docs/setup.md · Meta credential steps: docs/decisions/0005'
	);
	process.exitCode = ok ? 0 : 1;
}

const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : err);
		process.exitCode = 1;
	});
}
