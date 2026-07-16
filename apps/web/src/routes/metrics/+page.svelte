<script lang="ts">
	import { SvelteMap, SvelteURLSearchParams } from 'svelte/reactivity';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { api, ApiError, type LeaderboardPlatform } from '$lib/api';
	import { clearInternalToken, getInternalToken, storeInternalToken } from '$lib/internal-token';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import { withQuery } from '$lib/nav';

	let { data } = $props();

	const platforms: LeaderboardPlatform[] = ['all', 'meta', 'google'];

	function setPlatform(platform: LeaderboardPlatform) {
		const params = new SvelteURLSearchParams();
		if (platform !== 'all') params.set('platform', platform);
		void goto(withQuery(resolve('/metrics'), params), { keepFocus: true });
	}

	// last-30d series per combo for the sparklines, zero-filled over the
	// window's full date axis: days without delivery render as dips to zero
	// at their real position, instead of being skipped and compressing a
	// 3-delivery-day combo into a misleading 3-point "30 day" line.
	const seriesByCreative = $derived.by(() => {
		const map = new SvelteMap<string, { spend: number[]; ctr: number[] }>();
		const items = data.daily.items;
		if (items.length === 0) return map;
		let min = items[0].date;
		let max = items[0].date;
		for (const row of items) {
			if (row.date < min) min = row.date;
			if (row.date > max) max = row.date;
		}
		const axis: string[] = [];
		const end = Date.parse(`${max}T00:00:00Z`);
		for (let t = Date.parse(`${min}T00:00:00Z`); t <= end; t += 86_400_000) {
			axis.push(new Date(t).toISOString().slice(0, 10));
		}
		// Plain Maps are fine here: they are locals rebuilt on every $derived
		// run, never mutated after this function returns — but the lint rule
		// can't see that, and SvelteMap is harmless.
		const byCreativeDate = new SvelteMap<string, SvelteMap<string, (typeof items)[number]>>();
		for (const row of items) {
			let inner = byCreativeDate.get(row.creative_id);
			if (!inner) {
				inner = new SvelteMap();
				byCreativeDate.set(row.creative_id, inner);
			}
			inner.set(row.date, row);
		}
		for (const [creativeId, rows] of byCreativeDate) {
			const spend: number[] = [];
			const ctr: number[] = [];
			for (const date of axis) {
				const row = rows.get(date);
				spend.push(row ? row.spend_cents / 100 : 0);
				ctr.push(row && row.impressions > 0 ? row.clicks / row.impressions : 0);
			}
			map.set(creativeId, { spend, ctr });
		}
		return map;
	});

	const money = (cents: number | null) => (cents === null ? '—' : (cents / 100).toFixed(2));
	const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(2)}%`);

	// ---- Google CSV upload (the tokenless backfill path) ----
	let customerId = $state('');
	let accountLabel = $state('');
	let csvFile = $state<File | null>(null);
	let csvFileInput = $state<HTMLInputElement | null>(null);
	let uploading = $state(false);
	let uploadProblems = $state<string[]>([]);
	let uploadResult = $state<string | null>(null);
	let needToken = $state(false);
	let tokenInput = $state('');

	function onFileChange(event: Event) {
		csvFile = (event.currentTarget as HTMLInputElement).files?.[0] ?? null;
	}

	async function uploadCsv() {
		uploadProblems = [];
		uploadResult = null;
		if (!csvFile || !customerId.trim()) {
			uploadProblems = ['pick a CSV file and enter the Google customer id (e.g. 123-456-7890)'];
			return;
		}
		const token = tokenInput.trim() || getInternalToken();
		if (!token) {
			needToken = true;
			return;
		}
		uploading = true;
		try {
			const text = await csvFile.text();
			const summary = await api.ingestGoogleCsv(
				token,
				{
					externalAccountId: customerId,
					label: accountLabel.trim() || undefined,
					filename: csvFile.name
				},
				text
			);
			storeInternalToken(token);
			needToken = false;
			tokenInput = '';
			uploadResult =
				`Ingested ${summary.range.since} → ${summary.range.until}: ` +
				`${summary.snapshot_rows_upserted} snapshot rows, ` +
				`${summary.ads_matched}/${summary.ads_synced} ads matched`;
			csvFile = null;
			// The state and the visible input must agree — otherwise the input
			// still shows the ingested filename while "no file picked" errors.
			if (csvFileInput) csvFileInput.value = '';
			await invalidateAll();
		} catch (err) {
			if (err instanceof ApiError && err.status === 401) {
				clearInternalToken();
				needToken = true;
				uploadProblems = ['That token was rejected — paste the INTERNAL_API_TOKEN value.'];
			} else if (err instanceof ApiError && err.body.problems) {
				uploadProblems = err.body.problems;
			} else {
				uploadProblems = [err instanceof Error ? err.message : 'upload failed'];
			}
		} finally {
			uploading = false;
		}
	}

	// ---- deadletters ----
	let resolveError = $state<string | null>(null);
	async function resolveLetter(id: string) {
		resolveError = null;
		try {
			await api.setDeadletterResolved(id, true);
			await invalidateAll();
		} catch (err) {
			resolveError = err instanceof Error ? err.message : 'resolve failed';
		}
	}
</script>

<div class="row" style="justify-content: space-between; margin-bottom: 0.5rem;">
	<h1 style="margin: 0;">Metrics</h1>
	<span class="muted">
		{#each data.status.platforms as p (p.platform)}
			{p.platform}: {p.data_through ? `through ${p.data_through}` : 'no data'} ·
		{/each}
		evidence-gated
	</span>
</div>

<div class="row" style="margin-bottom: 1rem;">
	<span class="badge">Platform</span>
	{#each platforms as platform (platform)}
		<button
			class="chip {data.platform === platform ? 'on' : ''}"
			onclick={() => setPlatform(platform)}
		>
			{platform}
		</button>
	{/each}
</div>

{#if data.leaderboard.items.length === 0}
	<div class="panel muted">
		No combos pass the evidence gate for <strong>{data.platform}</strong> yet
		{#if data.leaderboard.combos_below_gate > 0}
			— {data.leaderboard.combos_below_gate} combo{data.leaderboard.combos_below_gate === 1
				? ' has'
				: 's have'} delivery but insufficient data (the gate is a feature: a $6 fluke never outranks a
			$150 workhorse).
		{:else}
			— sync Meta or upload a Google CSV below to fill the warehouse.
		{/if}
	</div>
{:else}
	<table class="list">
		<thead>
			<tr>
				<th>Combo</th>
				<th>Status</th>
				<th>Spend</th>
				<th>Spend 30d</th>
				<th>Impr.</th>
				<th>Clicks</th>
				<th>CTR</th>
				<th>CTR 30d</th>
				<th>CPC</th>
				<th>Conv.</th>
				<th>Days</th>
				<th>Ads</th>
			</tr>
		</thead>
		<tbody>
			{#each data.leaderboard.items as row (row.creative_id)}
				<tr>
					<td>
						<a class="mono" href={resolve('/combos/[id]', { id: row.creative_id })}
							>{row.short_code}</a
						>
						{#if row.angle}<div class="muted">{row.angle}</div>{/if}
					</td>
					<td><span class="badge status-{row.creative_status}">{row.creative_status}</span></td>
					<td>{money(row.spend_cents)}</td>
					<td>
						<Sparkline
							values={seriesByCreative.get(row.creative_id)?.spend ?? []}
							label="spend, last 30 days"
						/>
					</td>
					<td>{row.impressions.toLocaleString()}</td>
					<td>{row.clicks.toLocaleString()}</td>
					<td>{pct(row.ctr)}</td>
					<td>
						<Sparkline
							values={seriesByCreative.get(row.creative_id)?.ctr ?? []}
							stroke="var(--ok)"
							label="CTR, last 30 days"
						/>
					</td>
					<td>{money(row.cpc_cents)}</td>
					<td>{row.conversions}</td>
					<td>{row.days_with_delivery}</td>
					<td>{row.ad_count}</td>
				</tr>
			{/each}
		</tbody>
	</table>
	{#if data.leaderboard.combos_below_gate > 0}
		<p class="muted">
			+ {data.leaderboard.combos_below_gate} combo{data.leaderboard.combos_below_gate === 1
				? ''
				: 's'} with delivery below the evidence gate (insufficient data — not ranked on purpose).
		</p>
	{/if}
{/if}

<h2>Import Google Ads CSV</h2>
<div class="panel stack">
	<p class="muted" style="margin: 0;">
		The tokenless path: export an ad-level report segmented by day (columns per
		<span class="mono">docs/setup.md</span> — GAQL names canonical), then upload. Re-uploads are idempotent;
		date ranges can overlap freely.
	</p>
	<div class="row">
		<label class="field">
			Google customer id
			<input bind:value={customerId} placeholder="123-456-7890" />
		</label>
		<label class="field">
			Account label (optional)
			<input bind:value={accountLabel} placeholder="FWT Google" />
		</label>
		<label class="field">
			Report CSV
			<input bind:this={csvFileInput} type="file" accept=".csv,text/csv" onchange={onFileChange} />
		</label>
		<button class="primary" onclick={() => void uploadCsv()} disabled={uploading}>
			{uploading ? 'Ingesting…' : 'Ingest CSV'}
		</button>
	</div>
	{#if needToken}
		<div class="row" style="align-items: end;">
			<label class="field" style="flex: 1;">
				INTERNAL_API_TOKEN (kept for this browser session only)
				<input
					type="password"
					bind:value={tokenInput}
					placeholder="paste the token from your Infisical /api path"
				/>
			</label>
			<button onclick={() => void uploadCsv()} disabled={uploading || !tokenInput.trim()}>
				Use token
			</button>
		</div>
	{/if}
	{#if uploadProblems.length > 0}
		<div class="error">
			{#each uploadProblems as problem (problem)}<div>{problem}</div>{/each}
		</div>
	{/if}
	{#if uploadResult}<div class="ok">{uploadResult}</div>{/if}
</div>

<h2>Unmatched ads {data.unmatched.items.length > 0 ? `(${data.unmatched.items.length})` : ''}</h2>
{#if data.unmatched.items.length === 0}
	<div class="panel muted">
		Every synced ad joins a combo — the naming convention is holding. New violations land here with
		a machine-readable reason.
	</div>
{:else}
	<table class="list">
		<thead>
			<tr>
				<th>Platform</th>
				<th>Ad name (raw)</th>
				<th>Why it didn't match</th>
				<th>Campaign</th>
				<th>First seen</th>
			</tr>
		</thead>
		<tbody>
			{#each data.unmatched.items as ad (ad.ad_entity_id)}
				<tr>
					<td>{ad.platform}</td>
					<td class="mono">{ad.ad_name === '' ? '(unnamed)' : ad.ad_name}</td>
					<td>
						<span class="badge" style="color: var(--warn);">{ad.match_failure_code}</span>
						{#if ad.match_failure_reason}<div class="muted">{ad.match_failure_reason}</div>{/if}
					</td>
					<td>{ad.campaign_name ?? '—'}</td>
					<td class="muted">{ad.first_seen}</td>
				</tr>
			{/each}
		</tbody>
	</table>
	<p class="muted">
		Fix: rename the ad on the platform to its canonical
		<span class="mono">prefix|campaign|code|vN</span> name (from the combo page) — the next sync/upload
		re-parses and clears the row.
	</p>
{/if}

<h2>
	Ingest deadletters {data.deadletters.items.length > 0
		? `(${data.deadletters.items.length} open)`
		: ''}
</h2>
{#if resolveError}<div class="error">{resolveError}</div>{/if}
{#if data.deadletters.items.length === 0}
	<div class="panel muted">No unresolved ingest failures.</div>
{:else}
	<table class="list">
		<thead>
			<tr><th>Platform</th><th>Phase</th><th>Error</th><th>When</th><th></th></tr>
		</thead>
		<tbody>
			{#each data.deadletters.items as letter (letter.id)}
				<tr>
					<td>{letter.platform}</td>
					<td class="mono">{String(letter.payload.phase ?? '?')}</td>
					<td>{letter.error}</td>
					<td class="muted">{new Date(letter.created_at).toLocaleString()}</td>
					<td>
						<button onclick={() => void resolveLetter(letter.id)}>Resolve</button>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
	<p class="muted">
		The full offending payload is preserved in <span class="mono">ingest_deadletter.payload</span>
		— resolve marks it handled, it never deletes.
	</p>
{/if}
