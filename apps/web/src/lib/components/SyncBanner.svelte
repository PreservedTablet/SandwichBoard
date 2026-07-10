<script lang="ts">
	import { api, ApiError, type SyncStatus } from '$lib/api';

	/**
	 * The staleness banner (docs/plan/06 Phase 2): nothing runs unattended,
	 * so the dashboard always says how old the numbers are — and offers the
	 * "Sync now" button. The button needs the operator's INTERNAL_API_TOKEN
	 * once per browser session (kept in sessionStorage, never persisted).
	 */

	const TOKEN_STORAGE_KEY = 'sandwichboard.internal_api_token';

	let status = $state<SyncStatus | null>(null);
	let loadError = $state<string | null>(null);
	let syncing = $state(false);
	let syncError = $state<string | null>(null);
	let lastRunLine = $state<string | null>(null);
	let needToken = $state(false);
	let tokenInput = $state('');

	const meta = $derived(status?.platforms.find((p) => p.platform === 'meta') ?? null);
	const stalenessDays = $derived.by(() => {
		if (!meta?.last_success_at) return null;
		const ms = Date.now() - new Date(meta.last_success_at).getTime();
		return Math.max(0, Math.floor(ms / 86_400_000));
	});
	const failedSinceSuccess = $derived(
		Boolean(
			meta?.last_failure_at &&
			(!meta.last_success_at || meta.last_failure_at > meta.last_success_at)
		)
	);

	async function load(): Promise<void> {
		try {
			status = await api.syncStatus();
			loadError = null;
		} catch (err) {
			loadError = err instanceof Error ? err.message : 'failed to load sync status';
		}
	}

	async function syncNow(): Promise<void> {
		const token = tokenInput.trim() || sessionStorage.getItem(TOKEN_STORAGE_KEY) || '';
		if (!token) {
			needToken = true;
			return;
		}
		syncing = true;
		syncError = null;
		try {
			const summary = await api.runMetaSync(token);
			sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
			needToken = false;
			tokenInput = '';
			lastRunLine =
				`Synced ${summary.range.since} → ${summary.range.until}: ` +
				`${summary.snapshot_rows_upserted} snapshot rows, ` +
				`${summary.ads_matched}/${summary.ads_synced} ads matched` +
				(summary.deadletters > 0 ? `, ${summary.deadletters} deadlettered` : '');
			await load();
		} catch (err) {
			if (err instanceof ApiError && err.status === 401) {
				sessionStorage.removeItem(TOKEN_STORAGE_KEY);
				needToken = true;
				syncError = 'That token was rejected — paste the INTERNAL_API_TOKEN value.';
			} else {
				syncError = err instanceof Error ? err.message : 'sync failed';
			}
		} finally {
			syncing = false;
		}
	}

	$effect(() => {
		void load();
	});
</script>

{#if loadError}
	<div class="sync-banner stale">
		<span>Sync status unavailable: {loadError}</span>
	</div>
{:else if status}
	<div class="sync-banner" class:stale={stalenessDays === null || stalenessDays > 1}>
		<span>
			{#if meta?.last_success_at}
				Metrics last synced
				{#if stalenessDays === 0}today{:else if stalenessDays === 1}yesterday{:else}{stalenessDays}
					days ago{/if}
				{#if status.data_through}(data through {status.data_through}){/if}
			{:else}
				Metrics have never been synced
			{/if}
			{#if status.unmatched_ads > 0}
				· {status.unmatched_ads} unmatched ad{status.unmatched_ads === 1 ? '' : 's'}
			{/if}
			{#if status.open_deadletters > 0}
				· {status.open_deadletters} deadletter{status.open_deadletters === 1 ? '' : 's'}
			{/if}
		</span>

		<span class="sync-actions">
			{#if meta?.configured === false}
				<span class="muted">Meta ingestion not configured (docs/setup.md)</span>
			{:else}
				<button class="primary" onclick={() => void syncNow()} disabled={syncing}>
					{syncing ? 'Syncing…' : 'Sync now'}
				</button>
			{/if}
		</span>
	</div>

	{#if needToken}
		<div class="sync-banner token-row">
			<label class="field" style="flex:1">
				INTERNAL_API_TOKEN (kept for this browser session only)
				<input
					type="password"
					bind:value={tokenInput}
					placeholder="paste the token from your Infisical /api path"
					onkeydown={(e) => e.key === 'Enter' && void syncNow()}
				/>
			</label>
			<button onclick={() => void syncNow()} disabled={syncing || !tokenInput.trim()}>
				Use token
			</button>
		</div>
	{/if}
	{#if failedSinceSuccess && meta}
		<div class="sync-banner error-row">
			Last sync attempt failed{meta.last_failure_error ? `: ${meta.last_failure_error}` : ''} — see audit_log.
		</div>
	{/if}
	{#if syncError}
		<div class="sync-banner error-row">{syncError}</div>
	{/if}
	{#if lastRunLine}
		<div class="sync-banner ok-row">{lastRunLine}</div>
	{/if}
{/if}
