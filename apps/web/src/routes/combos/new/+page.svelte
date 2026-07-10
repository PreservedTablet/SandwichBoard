<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { api, ApiError } from '$lib/api';

	let { data } = $props();

	let assetId = $state('');
	let headlineId = $state('');
	let primaryTextId = $state('');
	let ctaId = $state('');
	let angle = $state('');
	let landingPath = $state('');
	let notes = $state('');
	let error = $state('');
	let saving = $state(false);

	const hasComponent = $derived(Boolean(assetId || headlineId || primaryTextId || ctaId));
	const selectedAsset = $derived(data.assets.find((asset) => asset.id === assetId));
	const selectedHeadline = $derived(data.headlines.find((h) => h.id === headlineId));
	const selectedPrimary = $derived(data.primaryTexts.find((p) => p.id === primaryTextId));
	const selectedCta = $derived(data.ctas.find((c) => c.id === ctaId));

	// The pieces suggest an angle when they agree and none was typed.
	const suggestedAngle = $derived(
		[selectedHeadline?.angle, selectedPrimary?.angle, selectedCta?.angle].filter(Boolean)[0] ?? ''
	);

	async function create(event: SubmitEvent) {
		event.preventDefault();
		saving = true;
		error = '';
		try {
			const created = await api.createCreative({
				...(assetId ? { asset_id: assetId } : {}),
				...(headlineId ? { headline_id: headlineId } : {}),
				...(primaryTextId ? { primary_text_id: primaryTextId } : {}),
				...(ctaId ? { cta_id: ctaId } : {}),
				...((angle || suggestedAngle).trim() ? { angle: (angle || suggestedAngle).trim() } : {}),
				...(landingPath.trim() ? { landing_path: landingPath.trim() } : {}),
				...(notes.trim() ? { notes: notes.trim() } : {})
			});
			void goto(resolve('/combos/[id]', { id: created.id }));
		} catch (err) {
			error = err instanceof ApiError ? err.message : String(err);
			saving = false;
		}
	}
</script>

<p><a href={resolve('/combos')} class="muted">← Combos</a></p>
<h1>Build a combo</h1>
<p class="muted">
	Pick an asset and copy pieces; the database assigns an immutable base36 short code, and the combo
	page composes the canonical ad name + UTM string for launching it.
</p>

<div class="panel">
	<form class="stack" onsubmit={create}>
		<label class="field">
			Asset ({data.assets.length} in library)
			<select bind:value={assetId}>
				<option value="">— none (copy-only combo) —</option>
				{#each data.assets as asset (asset.id)}
					<option value={asset.id}>{asset.title} [{asset.kind}]</option>
				{/each}
			</select>
		</label>
		<label class="field">
			Headline
			<select bind:value={headlineId}>
				<option value="">— none —</option>
				{#each data.headlines as headline (headline.id)}
					<option value={headline.id}>{headline.body}</option>
				{/each}
			</select>
		</label>
		<label class="field">
			Primary text
			<select bind:value={primaryTextId}>
				<option value="">— none —</option>
				{#each data.primaryTexts as primary (primary.id)}
					<option value={primary.id}>{primary.body}</option>
				{/each}
			</select>
		</label>
		<label class="field">
			CTA
			<select bind:value={ctaId}>
				<option value="">— none —</option>
				{#each data.ctas as cta (cta.id)}
					<option value={cta.id}>{cta.body}</option>
				{/each}
			</select>
		</label>
		<div class="row">
			<label class="field">
				Angle
				<input bind:value={angle} placeholder={suggestedAngle || 'save-money'} />
			</label>
			<label class="field">
				Landing path
				<input bind:value={landingPath} placeholder="/compare or https://…" />
			</label>
			<label class="field" style="flex: 1;">
				Notes
				<input bind:value={notes} placeholder="why this pairing" />
			</label>
		</div>
		{#if selectedAsset || selectedHeadline || selectedPrimary || selectedCta}
			<div class="codeline" style="display: block;">
				<div class="badge" style="margin-bottom: 0.3rem;">Preview</div>
				{#if selectedAsset}<div>🖼 {selectedAsset.title}</div>{/if}
				{#if selectedHeadline}<div><strong>{selectedHeadline.body}</strong></div>{/if}
				{#if selectedPrimary}<div>{selectedPrimary.body}</div>{/if}
				{#if selectedCta}<div>→ {selectedCta.body}</div>{/if}
			</div>
		{/if}
		{#if error}<p class="error">{error}</p>{/if}
		<div class="row">
			<button class="primary" type="submit" disabled={saving || !hasComponent}>
				{saving ? 'Creating…' : 'Create combo'}
			</button>
			{#if !hasComponent}<span class="muted">pick at least one component</span>{/if}
		</div>
	</form>
</div>
