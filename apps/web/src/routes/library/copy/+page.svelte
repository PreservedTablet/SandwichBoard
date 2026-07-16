<script lang="ts">
	import { copyVariantKinds } from '@sandwichboard/core';
	import { SvelteSet, SvelteURLSearchParams } from 'svelte/reactivity';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError } from '$lib/api';
	import { withQuery } from '$lib/nav';

	let { data } = $props();

	// Union in active tags so a filter that matches nothing keeps its chip
	// visible (and removable).
	const allTags = $derived(
		[...new Set([...data.activeTags, ...data.variants.flatMap((variant) => variant.tags)])].sort()
	);

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
		void goto(withQuery(resolve('/library/copy'), params), { keepFocus: true });
	}

	let showForm = $state(false);
	let saving = $state(false);
	let formError = $state('');
	let form = $state({ kind: 'headline', body: '', angle: '', tone: '', tags: '' });

	async function createVariant(event: SubmitEvent) {
		event.preventDefault();
		saving = true;
		formError = '';
		try {
			const created = await api.createCopyVariant({
				kind: form.kind,
				body: form.body,
				...(form.angle.trim() ? { angle: form.angle.trim() } : {}),
				...(form.tone.trim() ? { tone: form.tone.trim() } : {}),
				tags: form.tags
					.split(',')
					.map((tag) => tag.trim().toLowerCase())
					.filter(Boolean)
			});
			void goto(resolve('/library/copy/[id]', { id: created.id }));
		} catch (err) {
			formError = err instanceof ApiError ? err.message : String(err);
			saving = false;
		}
	}
</script>

<div class="row" style="justify-content: space-between; margin-bottom: 1rem;">
	<h1 style="margin: 0;">Copy variants</h1>
	<button class="primary" onclick={() => (showForm = !showForm)}>
		{showForm ? 'Close' : '+ New copy'}
	</button>
</div>

{#if showForm}
	<div class="panel">
		<form class="stack" onsubmit={createVariant}>
			<div class="row">
				<label class="field">
					Kind
					<select bind:value={form.kind}>
						{#each copyVariantKinds as kind (kind)}<option value={kind}>{kind}</option>{/each}
					</select>
				</label>
				<label class="field">
					Angle
					<input bind:value={form.angle} placeholder="meet-neighbors" />
				</label>
				<label class="field">
					Tone
					<input bind:value={form.tone} placeholder="warm" />
				</label>
			</div>
			<label class="field">
				Body
				<textarea
					bind:value={form.body}
					required
					maxlength="5000"
					placeholder="Borrow the drill. Meet the neighbors."></textarea>
			</label>
			<label class="field">
				Tags (comma-separated)
				<input bind:value={form.tags} />
			</label>
			{#if formError}<p class="error">{formError}</p>{/if}
			<div>
				<button class="primary" type="submit" disabled={saving || !form.body.trim()}>
					{saving ? 'Creating…' : 'Create copy variant'}
				</button>
			</div>
		</form>
	</div>
{/if}

<div class="row" style="margin-bottom: 1rem;">
	<span class="badge">Kind</span>
	{#each copyVariantKinds as kind (kind)}
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

{#if data.variants.length === 0}
	<div class="panel muted">
		No copy variants{data.activeKind || data.activeTags.length > 0 ? ' match the filter' : ' yet'}.
	</div>
{:else}
	<table class="list">
		<thead>
			<tr><th>Kind</th><th>Body</th><th>Angle</th><th>Tone</th><th>Chars</th><th>Tags</th></tr>
		</thead>
		<tbody>
			{#each data.variants as variant (variant.id)}
				<tr>
					<td><span class="badge">{variant.kind}</span></td>
					<td><a href={resolve('/library/copy/[id]', { id: variant.id })}>{variant.body}</a></td>
					<td>{variant.angle ?? ''}</td>
					<td>{variant.tone ?? ''}</td>
					<td class="mono">{variant.char_count}</td>
					<td>
						<div class="chips">
							{#each variant.tags as tag (tag)}<span class="chip">{tag}</span>{/each}
						</div>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}
