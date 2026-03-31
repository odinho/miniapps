<script lang="ts">
	import { getNearbyDstTransition, getDstAdjustedTime, formatDstDate, type DstTransition } from '$lib/dst-utils.js';
	import { formatTime } from '$lib/utils.js';

	interface Props {
		timezone: string | null;
		bedtime?: string | null;
	}

	let { timezone, bedtime = null }: Props = $props();

	const dstTransition = $derived<DstTransition | null>(
		timezone ? getNearbyDstTransition(timezone, new Date(), 3) : null
	);

	const bannerText = $derived.by(() => {
		if (!dstTransition || !timezone) return null;
		const dateLabel = formatDstDate(dstTransition.date);
		const isUpcoming = dstTransition.date.getTime() > Date.now();

		if (dstTransition.direction === 'spring-forward') {
			const advice = isUpcoming
				? `Sommartid startar ${dateLabel} — legg babyen ${dstTransition.offsetChangeMinutes} min seinare enn vanleg`
				: `Sommartid starta ${dateLabel} — legg babyen ${dstTransition.offsetChangeMinutes} min seinare enn vanleg`;
			if (!isUpcoming && bedtime) {
				const lastBedtime = formatTime(bedtime);
				const adjusted = getDstAdjustedTime(lastBedtime, timezone);
				if (adjusted && adjusted !== lastBedtime) {
					return `${advice} (t.d. ${lastBedtime} → ${adjusted})`;
				}
			}
			return advice;
		} else {
			const advice = isUpcoming
				? `Vintertid startar ${dateLabel} — legg babyen ${dstTransition.offsetChangeMinutes} min tidlegare enn vanleg`
				: `Vintertid starta ${dateLabel} — legg babyen ${dstTransition.offsetChangeMinutes} min tidlegare enn vanleg`;
			if (!isUpcoming && bedtime) {
				const lastBedtime = formatTime(bedtime);
				const adjusted = getDstAdjustedTime(lastBedtime, timezone);
				if (adjusted && adjusted !== lastBedtime) {
					return `${advice} (t.d. ${lastBedtime} → ${adjusted})`;
				}
			}
			return advice;
		}
	});

	const icon = $derived(dstTransition?.direction === 'spring-forward' ? '☀️' : '🌙');
</script>

{#if bannerText}
	<div class="dst-banner" data-testid="dst-banner">
		<span class="dst-banner-icon">{icon}</span>
		<span class="dst-banner-text">{bannerText}</span>
	</div>
{/if}
