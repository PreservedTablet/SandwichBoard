<script lang="ts">
	import { recommendationStatuses } from '@sandwichboard/core';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { api, type RecommendationListItem } from '$lib/api';
	import { withQuery } from '$lib/nav';

	let { data } = $props();

	let actionError = $state<string | null>(null);
	let noteDrafts = $state<Record<string, string>>({});

	function toggleStatus(status: string) {
		const params = new SvelteURLSearchParams();
		if (data.activeStatus !== status) params.set('status', status);
		void goto(withQuery(resolve('/recommendations'), params), { keepFocus: true });
	}

	async function setStatus(
		rec: RecommendationListItem,
		status: 'accepted' | 'rejected' | 'done' | 'expired'
	) {
		actionError = null;
		try {
			const note = noteDrafts[rec.id]?.trim();
			await api.updateRecommendation(rec.id, {
				status,
				...(note ? { outcome_note: note } : {})
			});
			delete noteDrafts[rec.id];
			await invalidateAll();
		} catch (err) {
			actionError = err instanceof Error ? err.message : 'update failed';
		}
	}

	async function saveNote(rec: RecommendationListItem) {
		actionError = null;
		try {
			await api.updateRecommendation(rec.id, { outcome_note: noteDrafts[rec.id]?.trim() || null });
			delete noteDrafts[rec.id];
			await invalidateAll();
		} catch (err) {
			actionError = err instanceof Error ? err.message : 'update failed';
		}
	}

	const evidencePretty = (evidence: unknown) => JSON.stringify(evidence, null, 2);
</script>

<div class="row" style="justify-content: space-between; margin-bottom: 0.5rem;">
	<h1 style="margin: 0;">Recommendations</h1>
	<span class="muted">proposed by /analyze · your verdicts feed the next run</span>
</div>

<div class="row" style="margin-bottom: 1rem;">
	<span class="badge">Status</span>
	{#each recommendationStatuses as status (status)}
		<button
			class="chip {data.activeStatus === status ? 'on' : ''}"
			onclick={() => toggleStatus(status)}
		>
			{status}
		</button>
	{/each}
</div>

{#if actionError}<div class="error" style="margin-bottom: 1rem;">{actionError}</div>{/if}

{#if data.recommendations.length === 0}
	<div class="panel muted">
		No recommendations{data.activeStatus ? ` with status ${data.activeStatus}` : ' yet'} — run
		<span class="mono">/analyze</span> in a Claude Code session started with
		<span class="mono">mcp-draft.json</span> (docs/setup.md §5). Proposals land here; nothing executes
		without your click.
	</div>
{:else}
	{#each data.recommendations as rec (rec.id)}
		<div class="panel stack rec-card">
			<div class="row" style="justify-content: space-between;">
				<span class="row">
					<span class="badge rec-kind rec-kind-{rec.kind}">{rec.kind.replace('_', ' ')}</span>
					{#if rec.subject_short_code && rec.subject_creative_id}
						<a class="mono" href={resolve('/combos/[id]', { id: rec.subject_creative_id })}
							>{rec.subject_short_code}</a
						>
					{/if}
					<span class="badge">{rec.status}</span>
				</span>
				<span class="muted">{new Date(rec.created_at).toLocaleDateString()}</span>
			</div>

			<p style="margin: 0;">{rec.rationale}</p>

			<details>
				<summary class="muted">evidence (reproducible: each claim carries its SQL)</summary>
				<pre class="mono evidence">{evidencePretty(rec.evidence)}</pre>
			</details>

			{#if rec.outcome_note}
				<p class="muted" style="margin: 0;">outcome: {rec.outcome_note}</p>
			{/if}

			<div class="row">
				{#if rec.status === 'open'}
					<button class="primary" onclick={() => void setStatus(rec, 'accepted')}>Accept</button>
					<button class="danger" onclick={() => void setStatus(rec, 'rejected')}>Reject</button>
					<button onclick={() => void setStatus(rec, 'expired')}>Expire</button>
				{:else if rec.status === 'accepted'}
					<button class="primary" onclick={() => void setStatus(rec, 'done')}>Mark done</button>
					<button onclick={() => void setStatus(rec, 'expired')}>Expire</button>
				{/if}
				<input
					style="flex: 1; min-width: 12rem;"
					placeholder="outcome note (what happened; feeds the next run)"
					bind:value={noteDrafts[rec.id]}
				/>
				<button onclick={() => void saveNote(rec)} disabled={!noteDrafts[rec.id]?.trim()}>
					Save note
				</button>
			</div>
		</div>
	{/each}
{/if}
