<script lang="ts">
	import { assetKinds } from '@sandwichboard/core';
	import { SvelteSet, SvelteURLSearchParams } from 'svelte/reactivity';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError } from '$lib/api';
	import { withQuery } from '$lib/nav';
	import AssetThumb from '$lib/components/AssetThumb.svelte';

	let { data } = $props();

	// Tag cloud comes from what's loaded — enough at library scale.
	const allTags = $derived([...new Set(data.assets.flatMap((asset) => asset.tags))].sort());

	function toggleParam(name: 'kind' | 'tag', value: string) {
		const params = new SvelteURLSearchParams(page.url.searchParams);
		if (name === 'kind') {
			if (params.get('kind') === value) params.delete('kind');
			else params.set('kind', value);
		} else {
			const tags = new SvelteSet(params.getAll('tag'));
			if (tags.has(value)) tags.delete(value);
			else tags.add(value);
			params.delete('tag');
			for (const tag of tags) params.append('tag', tag);
		}
		void goto(withQuery(resolve('/library'), params), { keepFocus: true });
	}

	// -- new-asset form ------------------------------------------------------
	let showForm = $state(false);
	let saving = $state(false);
	let formError = $state('');
	let form = $state({ kind: 'image', title: '', tags: '', external_url: '', source: '' });

	async function createAsset(event: SubmitEvent) {
		event.preventDefault();
		saving = true;
		formError = '';
		try {
			const created = await api.createAsset({
				kind: form.kind,
				title: form.title,
				tags: form.tags
					.split(',')
					.map((tag) => tag.trim().toLowerCase())
					.filter(Boolean),
				...(form.external_url ? { external_url: form.external_url } : {}),
				...(form.source ? { source: form.source } : {})
			});
			void goto(resolve('/library/assets/[id]', { id: created.id }));
		} catch (err) {
			formError = err instanceof ApiError ? err.message : String(err);
			saving = false;
		}
	}
</script>

<div class="row" style="justify-content: space-between; margin-bottom: 1rem;">
	<h1 style="margin: 0;">Creative library</h1>
	<button class="primary" onclick={() => (showForm = !showForm)}>
		{showForm ? 'Close' : '+ New asset'}
	</button>
</div>

{#if showForm}
	<div class="panel">
		<form class="stack" onsubmit={createAsset}>
			<div class="row">
				<label class="field">
					Kind
					<select bind:value={form.kind}>
						{#each assetKinds as kind (kind)}<option value={kind}>{kind}</option>{/each}
					</select>
				</label>
				<label class="field" style="flex: 1; min-width: 220px;">
					Title
					<input bind:value={form.title} required maxlength="200" placeholder="Porch drill still" />
				</label>
			</div>
			<label class="field">
				Tags (comma-separated)
				<input bind:value={form.tags} placeholder="porch, drill, denver" />
			</label>
			<div class="row">
				<label class="field" style="flex: 1;">
					External URL (for files that live elsewhere, e.g. Scalemo output)
					<input bind:value={form.external_url} type="url" placeholder="https://…" />
				</label>
				<label class="field">
					Source
					<input bind:value={form.source} placeholder="photo-shoot-jun26" />
				</label>
			</div>
			{#if formError}<p class="error">{formError}</p>{/if}
			<div class="row">
				<button class="primary" type="submit" disabled={saving || !form.title.trim()}>
					{saving ? 'Creating…' : 'Create asset'}
				</button>
				<span class="muted">Upload the file itself from the asset page after creating.</span>
			</div>
		</form>
	</div>
{/if}

<div class="row" style="margin-bottom: 1rem;">
	<span class="badge">Kind</span>
	{#each assetKinds as kind (kind)}
		<button
			class="chip {data.activeKind === kind ? 'on' : ''}"
			onclick={() => toggleParam('kind', kind)}
		>
			{kind}
		</button>
	{/each}
	{#if allTags.length > 0}
		<span class="badge" style="margin-left: 0.75rem;">Tags</span>
		{#each allTags as tag (tag)}
			<button
				class="chip {data.activeTags.includes(tag) ? 'on' : ''}"
				onclick={() => toggleParam('tag', tag)}
			>
				{tag}
			</button>
		{/each}
	{/if}
</div>

{#if data.assets.length === 0}
	<div class="panel muted">
		No assets{data.activeTags.length > 0 || data.activeKind ? ' match the filter' : ' yet'}. The
		seed import (maintainer CSV) or “+ New asset” fills this grid.
		<button class="chip" style="margin-left: 0.5rem;" onclick={() => void invalidateAll()}
			>refresh</button
		>
	</div>
{:else}
	<div class="grid">
		{#each data.assets as asset (asset.id)}
			<a class="card" href={resolve('/library/assets/[id]', { id: asset.id })}>
				<AssetThumb {asset} />
				<div class="title">{asset.title}</div>
				<div class="row" style="justify-content: space-between;">
					<span class="badge">{asset.kind}</span>
					{#if asset.source}<span class="muted">{asset.source}</span>{/if}
				</div>
				{#if asset.tags.length > 0}
					<div class="chips" style="margin-top: 0.45rem;">
						{#each asset.tags as tag (tag)}<span class="chip">{tag}</span>{/each}
					</div>
				{/if}
			</a>
		{/each}
	</div>
{/if}
