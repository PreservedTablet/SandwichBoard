<script lang="ts">
	import type { AssetRow } from '@sandwichboard/core';
	import { api } from '$lib/api';

	let { asset }: { asset: AssetRow } = $props();

	// Tokenized URLs are short-lived by design; fetch one per mount.
	let src = $state<string | null>(null);
	const showsImage = $derived(
		asset.kind === 'image' && asset.storage_path && asset.storage_content_type !== 'image/svg+xml'
	);

	$effect(() => {
		if (!showsImage) return;
		let cancelled = false;
		api
			.getAssetFileUrl(asset.id)
			.then(({ url }) => {
				if (!cancelled) src = url;
			})
			.catch(() => {
				if (!cancelled) src = null;
			});
		return () => {
			cancelled = true;
		};
	});
</script>

<div class="thumb">
	{#if showsImage && src}
		<img {src} alt={asset.title} loading="lazy" />
	{:else if asset.kind === 'video'}
		<span>▶ video</span>
	{:else if asset.kind === 'overlay_template'}
		<span>overlay</span>
	{:else if asset.external_url}
		<span>external ↗</span>
	{:else}
		<span>no file yet</span>
	{/if}
</div>
