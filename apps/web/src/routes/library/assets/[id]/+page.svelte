<script lang="ts">
	import { assetProductionStatuses } from '@sandwichboard/core';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { api, ApiError } from '$lib/api';

	let { data } = $props();
	const asset = $derived(data.asset);

	let error = $state('');
	let busy = $state(false);

	// -- metadata edit -------------------------------------------------------
	let title = $state('');
	let tags = $state('');
	let source = $state('');
	let externalUrl = $state('');
	let productionStatus = $state('ready');
	let angle = $state('');
	let aspectRatio = $state('');
	let notes = $state('');
	$effect(() => {
		title = asset.title;
		tags = asset.tags.join(', ');
		source = asset.source ?? '';
		externalUrl = asset.external_url ?? '';
		productionStatus = asset.production_status;
		angle = asset.angle ?? '';
		aspectRatio = asset.aspect_ratio ?? '';
		notes = asset.notes ?? '';
	});

	async function saveMeta(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = '';
		try {
			await api.updateAsset(asset.id, {
				title,
				production_status: productionStatus,
				tags: tags
					.split(',')
					.map((tag) => tag.trim().toLowerCase())
					.filter(Boolean),
				source: source.trim() ? source.trim() : null,
				external_url: externalUrl.trim() ? externalUrl.trim() : null,
				angle: angle.trim() ? angle.trim() : null,
				aspect_ratio: aspectRatio.trim() ? aspectRatio.trim() : null,
				notes: notes.trim() ? notes.trim() : null
			});
			await invalidateAll();
		} catch (err) {
			error = err instanceof ApiError ? err.message : String(err);
		} finally {
			busy = false;
		}
	}

	// -- file upload + preview ----------------------------------------------
	let fileInput = $state<HTMLInputElement | null>(null);
	let previewUrl = $state<string | null>(null);
	let previewError = $state<string | null>(null);

	$effect(() => {
		if (!asset.storage_path) {
			previewUrl = null;
			previewError = null;
			return;
		}
		let cancelled = false;
		api
			.getAssetFileUrl(asset.id)
			.then(({ url }) => {
				if (!cancelled) {
					previewUrl = url;
					previewError = null;
				}
			})
			.catch((err: unknown) => {
				// Surface, never swallow: a missing preview is information.
				if (!cancelled) {
					previewError = err instanceof Error ? err.message : 'preview unavailable';
				}
			});
		return () => {
			cancelled = true;
		};
	});

	async function upload() {
		const file = fileInput?.files?.[0];
		if (!file) return;
		busy = true;
		error = '';
		try {
			await api.uploadAssetFile(asset.id, file);
			await invalidateAll();
		} catch (err) {
			error = err instanceof ApiError ? err.message : String(err);
		} finally {
			busy = false;
			if (fileInput) fileInput.value = '';
		}
	}

	async function removeAsset() {
		if (!window.confirm(`Delete asset “${asset.title}”? Combos using it will block this.`)) return;
		busy = true;
		error = '';
		try {
			await api.deleteAsset(asset.id);
			void goto(resolve('/library'));
		} catch (err) {
			error = err instanceof ApiError ? err.message : String(err);
			busy = false;
		}
	}
</script>

<p><a href={resolve('/library')} class="muted">← Library</a></p>
<div class="row" style="justify-content: space-between;">
	<h1 style="margin: 0;">{asset.title}</h1>
	<span class="badge">{asset.kind}</span>
</div>

{#if error}<p class="error">{error}</p>{/if}

<div class="panel" style="margin-top: 1rem;">
	<h2 style="margin-top: 0;">File</h2>
	{#if asset.storage_path}
		{#if previewError}
			<p class="error">Preview unavailable: {previewError}</p>
		{/if}
		{#if previewUrl && asset.storage_content_type?.startsWith('image/') && asset.storage_content_type !== 'image/svg+xml'}
			<img
				src={previewUrl}
				alt={asset.title}
				style="max-width: 420px; max-height: 320px; border-radius: 8px;"
			/>
		{:else if previewUrl && asset.storage_content_type?.startsWith('video/')}
			<!-- svelte-ignore a11y_media_has_caption -->
			<video src={previewUrl} controls style="max-width: 420px; border-radius: 8px;"></video>
		{:else if previewUrl}
			<!-- tokenized API URL, not an app route -->
			<p class="mono"><a href={previewUrl} rel="external">download {asset.storage_path}</a></p>
		{/if}
		<p class="muted mono">{asset.storage_path} · {asset.storage_content_type}</p>
		<p class="muted">
			Reads use short-lived tokenized URLs; refresh the page if a preview expires.
		</p>
	{:else if asset.external_url}
		<p>
			Lives elsewhere: <a href={asset.external_url} target="_blank" rel="noreferrer" class="mono"
				>{asset.external_url}</a
			>
		</p>
	{:else}
		<p class="muted">No file uploaded yet.</p>
	{/if}
	<div class="row" style="margin-top: 0.5rem;">
		<input type="file" bind:this={fileInput} accept="image/*,video/*,application/pdf" />
		<button onclick={upload} disabled={busy}>Upload{asset.storage_path ? ' (replace)' : ''}</button>
	</div>
</div>

<div class="panel">
	<h2 style="margin-top: 0;">Details</h2>
	<form class="stack" onsubmit={saveMeta}>
		<div class="row">
			<label class="field" style="flex: 1; min-width: 220px;">
				Title
				<input bind:value={title} required maxlength="200" />
			</label>
			<label class="field">
				Production status
				<select bind:value={productionStatus}>
					{#each assetProductionStatuses as status (status)}
						<option value={status}>{status.replace('_', ' ')}</option>
					{/each}
				</select>
			</label>
		</div>
		<label class="field">
			Tags (comma-separated)
			<input bind:value={tags} />
		</label>
		<div class="row">
			<label class="field">
				Angle
				<input bind:value={angle} placeholder="cost" />
			</label>
			<label class="field">
				Aspect ratio
				<input bind:value={aspectRatio} placeholder="4:5" pattern="\d+:\d+" />
			</label>
			<label class="field" style="flex: 1;">
				External URL
				<input bind:value={externalUrl} type="url" placeholder="https://…" />
			</label>
			<label class="field">
				Source
				<input bind:value={source} />
			</label>
		</div>
		<label class="field">
			Notes (briefs, hooks, production details)
			<textarea bind:value={notes}></textarea>
		</label>
		<div class="row">
			<button class="primary" type="submit" disabled={busy}>Save</button>
			<button type="button" class="danger" onclick={removeAsset} disabled={busy}
				>Delete asset</button
			>
		</div>
	</form>
	<p class="muted" style="margin-bottom: 0;">
		Created {new Date(asset.created_at).toLocaleString()} · updated
		{new Date(asset.updated_at).toLocaleString()}{#if asset.import_ref}
			· imported as <span class="mono">{asset.import_ref}</span>{/if}{#if asset.storage_sha256}
			· sha256 <span class="mono">{asset.storage_sha256.slice(0, 12)}…</span>{/if}
	</p>
</div>
