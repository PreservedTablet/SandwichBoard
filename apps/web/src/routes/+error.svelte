<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
</script>

<div class="panel" style="margin-top: 2rem; max-width: 40rem;">
	<h1 style="margin-top: 0;">{page.status}</h1>
	<p>{page.error?.message ?? 'Something went wrong.'}</p>
	{#if page.status === 503}
		<p class="muted">
			The dashboard talks same-origin to <span class="mono">apps/api</span> — start it (or wait for its
			restart to finish) and retry.
		</p>
	{/if}
	<p class="row">
		<button class="chip" onclick={() => location.reload()}>Retry</button>
		<a href={resolve('/library')}>← Back to the library</a>
	</p>
</div>
