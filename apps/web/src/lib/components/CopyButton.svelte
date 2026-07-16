<script lang="ts">
	let { text, label = 'Copy' }: { text: string; label?: string } = $props();
	let copied = $state(false);
	let failed = $state(false);

	// navigator.clipboard exists only in secure contexts; on a plain-HTTP
	// LAN origin (home-server before the TLS layer) fall back to the
	// selection-based API, and if both fail say so instead of doing nothing.
	function legacyCopy(): boolean {
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.style.position = 'fixed';
		ta.style.opacity = '0';
		document.body.appendChild(ta);
		ta.select();
		try {
			return document.execCommand('copy');
		} finally {
			ta.remove();
		}
	}

	async function copy() {
		copied = false;
		failed = false;
		let ok = false;
		if (navigator.clipboard?.writeText) {
			try {
				await navigator.clipboard.writeText(text);
				ok = true;
			} catch {
				// fall through to the legacy path
			}
		}
		if (!ok) ok = legacyCopy();
		if (ok) {
			copied = true;
			setTimeout(() => (copied = false), 1600);
		} else {
			failed = true;
			setTimeout(() => (failed = false), 2600);
		}
	}
</script>

<button type="button" onclick={copy} title="Copy to clipboard">
	{#if failed}Copy failed — select manually{:else if copied}Copied ✓{:else}{label}{/if}
</button>
