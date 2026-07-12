<script lang="ts">
	/**
	 * Inline-SVG sparkline — no charting dependency (CLAUDE.md: no new
	 * deps). Values are plotted in order; a flat/empty series renders a
	 * quiet baseline instead of noise.
	 */
	interface Props {
		values: number[];
		width?: number;
		height?: number;
		stroke?: string;
		label: string;
	}
	let { values, width = 96, height = 22, stroke = 'var(--accent)', label }: Props = $props();

	const PAD = 2;

	const points = $derived.by(() => {
		if (values.length === 0) return '';
		const max = Math.max(...values);
		const min = Math.min(...values);
		const span = max - min;
		const innerW = width - PAD * 2;
		const innerH = height - PAD * 2;
		const stepX = values.length > 1 ? innerW / (values.length - 1) : 0;
		return values
			.map((value, i) => {
				const x = PAD + (values.length > 1 ? i * stepX : innerW / 2);
				const y = span === 0 ? PAD + innerH / 2 : PAD + innerH - ((value - min) / span) * innerH;
				return `${x.toFixed(1)},${y.toFixed(1)}`;
			})
			.join(' ');
	});
</script>

{#if values.length > 0}
	<svg {width} {height} viewBox="0 0 {width} {height}" role="img" aria-label={label}>
		<polyline
			{points}
			fill="none"
			{stroke}
			stroke-width="1.5"
			stroke-linejoin="round"
			stroke-linecap="round"
		/>
	</svg>
{:else}
	<span class="muted">—</span>
{/if}
