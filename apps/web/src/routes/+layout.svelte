<script lang="ts">
	import '../app.css';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import favicon from '$lib/assets/favicon.svg';
	import SyncBanner from '$lib/components/SyncBanner.svelte';

	let { children } = $props();

	const sections = [
		{ href: resolve('/library'), label: 'Library' },
		{ href: resolve('/library/copy'), label: 'Copy' },
		{ href: resolve('/combos'), label: 'Combos' },
		{ href: resolve('/metrics'), label: 'Metrics' },
		{ href: resolve('/recommendations'), label: 'Recs' }
	] as const;

	function isActive(href: string): boolean {
		const path = page.url.pathname;
		if (href === resolve('/library')) {
			return path === href || path.startsWith(href + '/assets');
		}
		return path === href || path.startsWith(href + '/');
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>SandwichBoard</title>
</svelte:head>

<div class="shell">
	<header class="topbar">
		<a class="brand" href={resolve('/library')}>SandwichBoard</a>
		<nav>
			{#each sections as section (section.href)}
				<a href={section.href} class={isActive(section.href) ? 'active' : ''}>{section.label}</a>
			{/each}
		</nav>
	</header>
	<SyncBanner />
	{@render children()}
</div>
