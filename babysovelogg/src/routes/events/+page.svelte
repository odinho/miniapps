<script lang="ts">
	import { page } from '$app/stores';
	import {
		type ParsedEvent,
		EVENT_TYPES,
		PAGE_SIZE,
		formatEventTimestamp,
		getTypeColor,
		buildPayloadPreview,
		buildEventsQuery,
	} from '$lib/event-view-utils.js';

	let events = $state<ParsedEvent[]>([]);
	let total = $state(0);
	let loading = $state(true);
	let error = $state('');
	let typeFilter = $state('');
	let expandedId = $state<number | null>(null);

	// domainId from URL query parameter: /events?domainId=abc
	const domainId = $derived($page.url.searchParams.get('domainId'));
	const title = $derived(domainId ? 'Entitetshistorikk' : 'Hendingslogg');
	const hasMore = $derived(events.length < total);

	async function fetchEvents(append = false) {
		if (!append) loading = true;
		error = '';
		try {
			const offset = append ? events.length : 0;
			const qs = buildEventsQuery({
				typeFilter: typeFilter || null,
				domainId: domainId,
				limit: PAGE_SIZE,
				offset,
			});
			const res = await fetch(`/api/events?${qs}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			if (append) {
				events = [...events, ...data.events];
			} else {
				events = data.events;
			}
			total = data.total;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	// Load on mount and when filter/domainId changes
	$effect(() => {
		// Reactively track filter values
		const _tf = typeFilter;
		const _di = domainId;
		void _tf;
		void _di;
		fetchEvents();
	});

	function onFilterChange(e: Event) {
		typeFilter = (e.target as HTMLSelectElement).value;
	}

	function toggleExpanded(id: number) {
		expandedId = expandedId === id ? null : id;
	}
</script>

<div class="view view-fade-in">
	<div class="events-header">
		<h1 class="events-title">{title}</h1>
		<a href="/" class="events-close" aria-label="Lukk">&times;</a>
	</div>

	{#if !domainId}
		<div class="events-filter">
			<select value={typeFilter} onchange={onFilterChange}>
				<option value="">Alle typar</option>
				{#each EVENT_TYPES as t}
					<option value={t}>{t}</option>
				{/each}
			</select>
		</div>
	{/if}

	{#if loading && events.length === 0}
		<p class="events-status">Lastar...</p>
	{:else if error}
		<p class="events-status events-error">{error}</p>
	{:else if events.length === 0}
		<p class="events-status">Ingen hendingar funne.</p>
	{:else}
		<div class="events-list">
			{#each events as ev (ev.id)}
				<button
					class="event-card"
					style="border-left-color: {getTypeColor(ev.type)}"
					onclick={() => toggleExpanded(ev.id)}
					aria-expanded={expandedId === ev.id}
				>
					<div class="event-header">
						<span class="event-type-badge" style="background: {getTypeColor(ev.type)}">{ev.type}</span>
						<span class="event-time">{formatEventTimestamp(ev.timestamp)}</span>
					</div>
					<div class="event-preview">{buildPayloadPreview(ev.payload)}</div>
					{#if expandedId === ev.id}
						<pre class="event-payload">{JSON.stringify(ev.payload, null, 2)}</pre>
					{/if}
				</button>
			{/each}
		</div>

		{#if hasMore}
			<button class="btn btn-secondary events-load-more" onclick={() => fetchEvents(true)}>
				Vis fleire ({events.length} av {total})
			</button>
		{/if}
	{/if}
</div>

<style>
	.events-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 12px;
	}
	.events-title {
		font-size: 1.2rem;
		font-weight: 700;
		margin: 0;
	}
	.events-close {
		font-size: 1.6rem;
		line-height: 1;
		text-decoration: none;
		color: var(--text-light);
		padding: 4px 8px;
	}
	.events-filter {
		margin-bottom: 12px;
	}
	.events-filter select {
		width: 100%;
		padding: 10px 14px;
		border: 2px solid var(--cream-dark);
		border-radius: var(--radius-sm);
		font-size: 0.95rem;
		font-family: var(--font);
		color: var(--text);
		background: var(--white);
		min-height: 44px;
	}
	.events-status {
		text-align: center;
		color: var(--text-light);
		padding: 2rem 0;
	}
	.events-error {
		color: var(--danger, #c62828);
	}
	.events-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.event-card {
		display: block;
		width: 100%;
		text-align: left;
		background: var(--white);
		border: none;
		border-left: 4px solid #757575;
		border-radius: var(--radius-sm);
		padding: 10px 12px;
		cursor: pointer;
		font-family: var(--font);
		color: var(--text);
		box-shadow: var(--shadow);
	}
	.event-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 4px;
	}
	.event-type-badge {
		display: inline-block;
		font-size: 0.72rem;
		font-weight: 600;
		color: #fff;
		padding: 2px 8px;
		border-radius: 10px;
		white-space: nowrap;
	}
	.event-time {
		font-size: 0.78rem;
		color: var(--text-light);
		white-space: nowrap;
	}
	.event-preview {
		font-size: 0.82rem;
		color: var(--text-light);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.event-payload {
		margin-top: 8px;
		padding: 10px;
		background: var(--cream);
		border-radius: var(--radius-sm);
		font-size: 0.75rem;
		line-height: 1.5;
		overflow-x: auto;
		max-height: 200px;
		overflow-y: auto;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.events-load-more {
		margin-top: 12px;
		width: 100%;
	}
</style>
