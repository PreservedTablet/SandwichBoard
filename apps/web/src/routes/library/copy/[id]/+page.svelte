<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { api, ApiError } from '$lib/api';

	let { data } = $props();
	const variant = $derived(data.variant);

	let error = $state('');
	let busy = $state(false);

	let body = $state('');
	let angle = $state('');
	let tone = $state('');
	let tags = $state('');
	$effect(() => {
		body = variant.body;
		angle = variant.angle ?? '';
		tone = variant.tone ?? '';
		tags = variant.tags.join(', ');
	});

	async function save(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = '';
		try {
			await api.updateCopyVariant(variant.id, {
				body,
				angle: angle.trim() ? angle.trim() : null,
				tone: tone.trim() ? tone.trim() : null,
				tags: tags
					.split(',')
					.map((tag) => tag.trim().toLowerCase())
					.filter(Boolean)
			});
			await invalidateAll();
		} catch (err) {
			error = err instanceof ApiError ? err.message : String(err);
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!window.confirm('Delete this copy variant? Combos using it will block this.')) return;
		busy = true;
		error = '';
		try {
			await api.deleteCopyVariant(variant.id);
			void goto(resolve('/library/copy'));
		} catch (err) {
			error = err instanceof ApiError ? err.message : String(err);
			busy = false;
		}
	}
</script>

<p><a href={resolve('/library/copy')} class="muted">← Copy variants</a></p>
<div class="row" style="justify-content: space-between;">
	<h1 style="margin: 0;">{variant.kind}</h1>
	<span class="mono muted">{variant.char_count} chars</span>
</div>

{#if error}<p class="error">{error}</p>{/if}

<div class="panel" style="margin-top: 1rem;">
	<form class="stack" onsubmit={save}>
		<label class="field">
			Body
			<textarea bind:value={body} required maxlength="5000"></textarea>
		</label>
		<div class="row">
			<label class="field">
				Angle
				<input bind:value={angle} />
			</label>
			<label class="field">
				Tone
				<input bind:value={tone} />
			</label>
			<label class="field" style="flex: 1;">
				Tags (comma-separated)
				<input bind:value={tags} />
			</label>
		</div>
		<div class="row">
			<button class="primary" type="submit" disabled={busy}>Save</button>
			<button type="button" class="danger" onclick={remove} disabled={busy}>Delete</button>
		</div>
	</form>
	<p class="muted" style="margin-bottom: 0;">
		Created {new Date(variant.created_at).toLocaleString()} · updated
		{new Date(variant.updated_at).toLocaleString()}
	</p>
</div>
