<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { sync } from '$lib/stores/sync.svelte.js';

	let { children } = $props();

	const tabs = [
		{ icon: '🏠', label: 'Heim', href: '/' },
		{ icon: '📋', label: 'Logg', href: '/history' },
		{ icon: '📊', label: 'Statistikk', href: '/stats' },
		{ icon: '⚙️', label: 'Innstillingar', href: '/settings' },
	];

	function applyTheme() {
		const hour = new Date().getHours();
		const mode = hour >= 6 && hour < 18 ? 'day' : 'night';
		document.documentElement.setAttribute('data-theme', mode);
	}

	function isActive(href: string): boolean {
		const path = page.url.pathname;
		if (href === '/') return path === '/';
		return path.startsWith(href);
	}

	$effect(() => {
		applyTheme();
		const interval = setInterval(applyTheme, 60_000);
		sync.init();

		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/service-worker.js');
		}

		return () => {
			clearInterval(interval);
			sync.destroy();
		};
	});
</script>

<svelte:head>
	<title>Babysovelogg</title>
</svelte:head>

<div id="app">
	<div class="view">
		{@render children()}
	</div>

	<nav class="nav-bar">
		{#each tabs as tab}
			<a
				class="nav-tab"
				class:active={isActive(tab.href)}
				href={tab.href}
			>
				<span class="nav-icon">{tab.icon}</span>
				<span>{tab.label}</span>
			</a>
		{/each}
	</nav>
</div>
