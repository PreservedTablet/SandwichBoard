import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MetaCliConnector, MetaCliError } from '../src/connectors/meta-cli.js';

/**
 * Connector unit tests against a fake `meta` binary — a node script that
 * records its argv + env and replies per a control file. This exercises the
 * real subprocess path (spawn, env construction, JSON parsing, error
 * classification, retries) with zero network and zero credentials.
 */

let dir: string;
let fakeBin: string;
let controlPath: string;
let capturePath: string;

interface Control {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	sleepMs?: number;
}

async function setControl(control: Control): Promise<void> {
	await writeFile(controlPath, JSON.stringify(control));
}

interface Capture {
	argv: string[];
	env: { ACCESS_TOKEN?: string; AD_ACCOUNT_ID?: string; DATABASE_URL?: string };
	calls: number;
}

async function readCapture(): Promise<Capture> {
	return JSON.parse(await readFile(capturePath, 'utf8')) as Capture;
}

function connector(overrides: Partial<ConstructorParameters<typeof MetaCliConnector>[0]> = {}) {
	return new MetaCliConnector({
		bin: fakeBin,
		accessToken: 'FAKE_TEST_TOKEN',
		adAccountId: 'act_1',
		retryDelaysMs: [10, 10],
		...overrides
	});
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), 'sb-fake-meta-'));
	fakeBin = join(dir, 'meta');
	controlPath = join(dir, 'control.json');
	capturePath = join(dir, 'capture.json');
	const script = `#!/usr/bin/env node
const fs = require('node:fs');
const control = JSON.parse(fs.readFileSync(${JSON.stringify(controlPath)}, 'utf8'));
let calls = 0;
try { calls = JSON.parse(fs.readFileSync(${JSON.stringify(capturePath)}, 'utf8')).calls; } catch {}
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  argv: process.argv.slice(2),
  env: { ACCESS_TOKEN: process.env.ACCESS_TOKEN, AD_ACCOUNT_ID: process.env.AD_ACCOUNT_ID, DATABASE_URL: process.env.DATABASE_URL },
  calls: calls + 1
}));
const finish = () => {
  if (control.stdout) process.stdout.write(control.stdout);
  if (control.stderr) process.stderr.write(control.stderr);
  process.exit(control.exitCode ?? 0);
};
if (control.sleepMs) setTimeout(finish, control.sleepMs); else finish();
`;
	await writeFile(fakeBin, script);
	await chmod(fakeBin, 0o755);
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
	await rm(capturePath, { force: true });
});

describe('MetaCliConnector', () => {
	it('invokes adaccount get with scripted flags and a minimal child env', async () => {
		await setControl({
			stdout: JSON.stringify([
				{ id: 'act_1', name: 'FWT Main', currency: 'USD', timezone_name: 'America/Denver' }
			])
		});
		const account = await connector().getAccountInfo();
		expect(account.name).toBe('FWT Main');

		const capture = await readCapture();
		expect(capture.argv).toEqual([
			'--output',
			'json',
			'--no-input',
			'--no-color',
			'ads',
			'adaccount',
			'get'
		]);
		expect(capture.env.ACCESS_TOKEN).toBe('FAKE_TEST_TOKEN');
		expect(capture.env.AD_ACCOUNT_ID).toBe('act_1');
		// the child sees credentials from config, never the parent's secrets
		expect(capture.env.DATABASE_URL).toBeUndefined();
	});

	it('builds the verified insights invocation (range, daily increment, fields)', async () => {
		await setControl({ stdout: JSON.stringify({ data: [], paging: {} }) });
		const rows = await connector().getAdInsightsDaily('1201', '2026-06-01', '2026-07-09');
		expect(rows).toEqual([]);

		const capture = await readCapture();
		expect(capture.argv.slice(4)).toEqual([
			'ads',
			'insights',
			'get',
			'--ad-id',
			'1201',
			'--since',
			'2026-06-01',
			'--until',
			'2026-07-09',
			'--time-increment',
			'daily',
			'--limit',
			'500',
			'--fields',
			'ad_id,ad_name,spend,impressions,clicks,actions,action_values,video_thruplay_watched_actions'
		]);
	});

	it('refuses to truncate: paginated insights fail loudly', async () => {
		await setControl({
			stdout: JSON.stringify({
				data: [{ date_start: '2026-06-01', date_stop: '2026-06-01' }],
				paging: { next: 'https://example.invalid/page2' }
			})
		});
		await expect(
			connector().getAdInsightsDaily('1201', '2026-06-01', '2026-07-09')
		).rejects.toThrow(/refusing to silently truncate/);
	});

	it('refuses to truncate: a list at the page ceiling fails loudly', async () => {
		const ads = Array.from({ length: 500 }, (_, i) => ({ id: String(i + 1), name: `ad ${i + 1}` }));
		await setControl({ stdout: JSON.stringify(ads) });
		await expect(connector().listAds()).rejects.toThrow(/refusing to silently truncate/);
	});

	it('classifies auth failures and never retries them', async () => {
		await setControl({
			stderr: 'Error: OAuthException code 190: Invalid OAuth access token.',
			exitCode: 3
		});
		const err = await connector()
			.listCampaigns()
			.then(() => null)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(MetaCliError);
		expect((err as MetaCliError).kind).toBe('auth');
		expect((await readCapture()).calls).toBe(1);
	});

	it('retries transient failures with backoff, then reports the last error', async () => {
		await setControl({ stderr: 'connection reset by peer', exitCode: 1 });
		const err = await connector()
			.listCampaigns()
			.then(() => null)
			.catch((e: unknown) => e);
		expect((err as MetaCliError).kind).toBe('invocation');
		expect((err as MetaCliError).detail).toContain('connection reset');
		expect((await readCapture()).calls).toBe(3); // 1 try + 2 retries
	});

	it('classifies a missing binary with install guidance', async () => {
		const err = await connector({ bin: join(dir, 'does-not-exist') })
			.getAccountInfo()
			.then(() => null)
			.catch((e: unknown) => e);
		expect((err as MetaCliError).kind).toBe('not-installed');
		expect((err as MetaCliError).message).toContain('meta-ads==1.1.0');
	});

	it('classifies timeouts', async () => {
		await setControl({ sleepMs: 2_000, stdout: '[]' });
		const err = await connector({ timeoutMs: 150, retryDelaysMs: [] })
			.listCampaigns()
			.then(() => null)
			.catch((e: unknown) => e);
		expect((err as MetaCliError).kind).toBe('timeout');
	});

	it('classifies non-JSON stdout as an output contract violation', async () => {
		await setControl({ stdout: 'Usage: meta [OPTIONS]…' });
		const err = await connector()
			.listCampaigns()
			.then(() => null)
			.catch((e: unknown) => e);
		expect((err as MetaCliError).kind).toBe('output');
	});

	it('rejects output that drifts from the recorded contract', async () => {
		await setControl({ stdout: JSON.stringify([{ no_id_field: true }]) });
		const err = await connector()
			.listAds()
			.then(() => null)
			.catch((e: unknown) => e);
		expect((err as MetaCliError).kind).toBe('output');
		expect((err as MetaCliError).message).toContain('docs/decisions/0005');
	});
});
