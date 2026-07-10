<script lang="ts">
	import { creativeStatuses } from '@sandwichboard/core';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { withQuery } from '$lib/nav';

	let { data } = $props();

	function toggleStatus(status: string) {
		const params = new SvelteURLSearchParams();
		if (data.activeStatus !== status) params.set('status', status);
		void goto(withQuery(resolve('/combos'), params), { keepFocus: true });
	}
</script>

<div class="row" style="justify-content: space-between; margin-bottom: 1rem;">
	<h1 style="margin: 0;">Combos</h1>
	<a href={resolve('/combos/new')}><button class="primary">+ Build combo</button></a>
</div>

<div class="row" style="margin-bottom: 1rem;">
	<span class="badge">Status</span>
	{#each creativeStatuses as status (status)}
		<button
			class="chip {data.activeStatus === status ? 'on' : ''}"
			onclick={() => toggleStatus(status)}
		>
			{status}
		</button>
	{/each}
</div>

{#if data.creatives.length === 0}
	<div class="panel muted">
		No combos{data.activeStatus ? ' with this status' : ' yet'} — build one from an asset and copy pieces.
		Each combo gets an immutable short code that joins platform metrics back to it.
	</div>
{:else}
	<table class="list">
		<thead>
			<tr
				><th>Code</th><th>Status</th><th>Asset</th><th>Headline</th><th>CTA</th><th>Angle</th><th
					>Created</th
				></tr
			>
		</thead>
		<tbody>
			{#each data.creatives as creative (creative.id)}
				<tr>
					<td
						><a class="mono" href={resolve('/combos/[id]', { id: creative.id })}
							>{creative.short_code}</a
						></td
					>
					<td><span class="badge status-{creative.status}">{creative.status}</span></td>
					<td>{creative.asset_title ?? '—'}</td>
					<td>{creative.headline_body ?? '—'}</td>
					<td>{creative.cta_body ?? '—'}</td>
					<td>{creative.angle ?? ''}</td>
					<td class="muted">{new Date(creative.created_at).toLocaleDateString()}</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}
