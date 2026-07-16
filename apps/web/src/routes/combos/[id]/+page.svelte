<script lang="ts">
	import {
		creativeStatuses,
		isValidCampaignSlug,
		slugifyCampaign,
		utmMediums
	} from '@sandwichboard/core';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { api, ApiError, type AdNameResponse } from '$lib/api';
	import CopyButton from '$lib/components/CopyButton.svelte';

	let { data } = $props();
	const creative = $derived(data.creative);

	let error = $state('');
	let busy = $state(false);

	async function setStatus(status: string) {
		busy = true;
		error = '';
		try {
			await api.updateCreative(creative.id, { status });
			await invalidateAll();
		} catch (err) {
			error = err instanceof ApiError ? err.message : String(err);
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!window.confirm(`Delete draft combo ${creative.short_code}?`)) return;
		busy = true;
		try {
			await api.deleteCreative(creative.id);
			void goto(resolve('/combos'));
		} catch (err) {
			error = err instanceof ApiError ? err.message : String(err);
			busy = false;
		}
	}

	// -- ad name + UTM generator (the acceptance loop) ------------------------
	let campaignInput = $state('');
	let version = $state<number | null>(1);
	let platform = $state('meta');
	let medium = $state<'paid' | 'organic'>('paid');
	let baseUrl = $state('');
	const campaignSlug = $derived(slugifyCampaign(campaignInput));

	let result = $state<AdNameResponse | null>(null);
	let nameError = $state('');
	let prefixMissing = $state(false);
	let prefixInput = $state('');
	let generating = $state(false);

	// Seed the composer per combo: a full-URL landing path pre-fills the
	// tagged-link destination, and stale results clear when client-side
	// navigation reuses this component for a different combo. The id guard
	// (a plain variable, deliberately untracked) keeps this from re-running
	// on user edits — the operator can clear the field without it refilling.
	let seededFor: string | null = null;
	$effect(() => {
		if (seededFor !== creative.id) {
			seededFor = creative.id;
			baseUrl = creative.landing_path?.startsWith('http') ? creative.landing_path : '';
			result = null;
			nameError = '';
			prefixMissing = false;
		}
	});

	async function generate() {
		if (!campaignSlug || !isValidCampaignSlug(campaignSlug)) {
			nameError = 'enter a campaign name first';
			return;
		}
		// A cleared number input binds null — catch it here instead of
		// sending "null" to the API and surfacing a raw validation error.
		if (version === null || !Number.isInteger(version) || version < 1 || version > 999999) {
			nameError = 'version must be a whole number from 1 to 999999';
			return;
		}
		generating = true;
		nameError = '';
		prefixMissing = false;
		try {
			const params = new SvelteURLSearchParams({
				campaign_slug: campaignSlug,
				version: String(version),
				platform,
				medium
			});
			if (baseUrl.trim()) params.set('base_url', baseUrl.trim());
			result = await api.adName(creative.id, params);
		} catch (err) {
			result = null;
			if (err instanceof ApiError && err.body.error === 'naming_prefix_not_set') {
				prefixMissing = true;
				nameError = '';
			} else {
				nameError = err instanceof ApiError ? err.message : String(err);
			}
		} finally {
			generating = false;
		}
	}

	async function savePrefix(event: SubmitEvent) {
		event.preventDefault();
		try {
			await api.putSetting('naming_prefix', prefixInput.trim());
			prefixMissing = false;
			await generate();
		} catch (err) {
			nameError = err instanceof ApiError ? err.message : String(err);
		}
	}
</script>

<p><a href={resolve('/combos')} class="muted">← Combos</a></p>
<div class="row" style="justify-content: space-between;">
	<h1 style="margin: 0;">
		Combo <span class="mono">{creative.short_code}</span>
	</h1>
	<span class="badge status-{creative.status}">{creative.status}</span>
</div>

{#if error}<p class="error">{error}</p>{/if}

<div class="panel" style="margin-top: 1rem;">
	<h2 style="margin-top: 0;">
		Components <span class="muted">(immutable — a combo is its combination)</span>
	</h2>
	<table class="list">
		<tbody>
			<tr>
				<th>Asset</th>
				<td>
					{#if creative.asset_id}
						<a href={resolve('/library/assets/[id]', { id: creative.asset_id })}
							>{creative.asset_title}</a
						>
						<span class="badge">{creative.asset_kind}</span>
					{:else}—{/if}
				</td>
			</tr>
			<tr>
				<th>Headline</th>
				<td>
					{#if creative.headline_id}<a
							href={resolve('/library/copy/[id]', { id: creative.headline_id })}
							>{creative.headline_body}</a
						>{:else}—{/if}
				</td>
			</tr>
			<tr>
				<th>Primary text</th>
				<td>
					{#if creative.primary_text_id}<a
							href={resolve('/library/copy/[id]', { id: creative.primary_text_id })}
							>{creative.primary_text_body}</a
						>{:else}—{/if}
				</td>
			</tr>
			<tr>
				<th>CTA</th>
				<td>
					{#if creative.cta_id}<a href={resolve('/library/copy/[id]', { id: creative.cta_id })}
							>{creative.cta_body}</a
						>{:else}—{/if}
				</td>
			</tr>
			<tr><th>Angle</th><td>{creative.angle ?? '—'}</td></tr>
			<tr><th>Landing path</th><td class="mono">{creative.landing_path ?? '—'}</td></tr>
			<tr><th>Notes</th><td>{creative.notes ?? '—'}</td></tr>
		</tbody>
	</table>
	<div class="row" style="margin-top: 0.8rem;">
		<span class="badge">Status</span>
		{#each creativeStatuses as status (status)}
			<button
				class="chip {creative.status === status ? 'on' : ''}"
				disabled={busy || creative.status === status}
				onclick={() => setStatus(status)}
			>
				{status}
			</button>
		{/each}
		{#if creative.status === 'draft'}
			<button class="danger" style="margin-left: auto;" onclick={remove} disabled={busy}>
				Delete draft
			</button>
		{/if}
	</div>
</div>

<div class="panel">
	<h2 style="margin-top: 0;">Ad name + UTM</h2>
	<p class="muted">
		Canonical name for launching this combo — <span class="mono">prefix|campaign|code|v#</span>.
		Paste it as the ad name on the platform; ingestion joins metrics back through it.
	</p>
	<div class="stack">
		<div class="row">
			<label class="field" style="flex: 1; min-width: 200px;">
				Campaign
				<input bind:value={campaignInput} placeholder="Denver Circle" />
			</label>
			<label class="field" style="width: 90px;">
				Version
				<input type="number" bind:value={version} min="1" max="999999" />
			</label>
			<label class="field">
				Platform
				<select bind:value={platform}>
					<option value="meta">meta</option>
					<option value="google">google</option>
					<option value="tiktok">tiktok</option>
					<option value="reddit">reddit</option>
				</select>
			</label>
			<label class="field">
				Medium
				<select bind:value={medium}>
					{#each utmMediums as m (m)}<option value={m}>{m}</option>{/each}
				</select>
			</label>
		</div>
		<label class="field">
			Destination URL (optional — for the full tagged link)
			<input
				bind:value={baseUrl}
				type="url"
				placeholder="https://friendswithtools.example/invite"
			/>
		</label>
		{#if campaignInput}
			<p class="muted" style="margin: 0;">
				campaign slug: <span class="mono">{campaignSlug || '(empty)'}</span>
			</p>
		{/if}
		<div>
			<button class="primary" onclick={generate} disabled={generating || !campaignSlug}>
				{generating ? 'Composing…' : 'Compose name + UTM'}
			</button>
		</div>

		{#if prefixMissing}
			<form class="row" onsubmit={savePrefix} style="align-items: end;">
				<label class="field">
					Ad-name prefix (set once per org — e.g. “fwt”)
					<input bind:value={prefixInput} placeholder="fwt" required />
				</label>
				<button class="primary" type="submit">Save prefix &amp; compose</button>
			</form>
		{/if}
		{#if nameError}<p class="error">{nameError}</p>{/if}

		{#if result}
			<div class="stack" data-testid="ad-name-result">
				<div class="codeline">
					<span class="mono" data-testid="ad-name">{result.ad_name}</span>
					<CopyButton text={result.ad_name} label="Copy name" />
				</div>
				<div class="codeline">
					<span class="mono">{result.utm_query}</span>
					<CopyButton text={result.utm_query} label="Copy UTM" />
				</div>
				{#if result.url}
					<div class="codeline">
						<span class="mono">{result.url}</span>
						<CopyButton text={result.url} label="Copy URL" />
					</div>
				{/if}
				<p class="muted" style="margin: 0;" data-testid="round-trip">
					{#if result.round_trip_ok}
						<span class="ok">✓ parser round-trip verified</span> — parsed back to prefix
						<span class="mono">{result.parts.prefix}</span>, campaign
						<span class="mono">{result.parts.campaignSlug}</span>, code
						<span class="mono">{result.parts.shortCode}</span>, v{result.parts.version}
					{:else}
						<span class="error">round-trip failed — this is a bug</span>
					{/if}
				</p>
			</div>
		{/if}
	</div>
</div>

<p class="muted">
	Created {new Date(creative.created_at).toLocaleString()} · updated
	{new Date(creative.updated_at).toLocaleString()}
</p>
