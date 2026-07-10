<script lang="ts">
	let { text, label = 'Copy' }: { text: string; label?: string } = $props();
	let copied = $state(false);

	async function copy() {
		await navigator.clipboard.writeText(text);
		copied = true;
		setTimeout(() => (copied = false), 1600);
	}
</script>

<button type="button" onclick={copy} title="Copy to clipboard">
	{copied ? 'Copied ✓' : label}
</button>
