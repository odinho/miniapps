<script lang="ts">
	import type { BabyState } from '$lib/stores/app.svelte.js';
	import { getLaneStatus } from '$lib/lane-status.js';
	import { handoffSegments, handoffWakings, HANDOFF_WINDOW_MS } from '$lib/handoff.js';
	import { formatDurationCompact, formatTime } from '$lib/utils.js';

	interface Props {
		babies: BabyState[];
		/** Live clock (ms), owned by the dashboard. */
		now: number;
	}
	let { babies, now }: Props = $props();

	const windowStart = $derived(now - HANDOFF_WINDOW_MS);
	const pct = (ms: number) => ((ms - windowStart) / HANDOFF_WINDOW_MS) * 100;

	// Hour gridlines across the 6h window (on the hour), as %.
	const hourMarks = $derived.by(() => {
		const marks: { left: number; label: string }[] = [];
		const first = new Date(windowStart);
		first.setMinutes(0, 0, 0);
		let t = first.getTime();
		if (t < windowStart) t += 3_600_000;
		for (; t <= now; t += 3_600_000) {
			marks.push({ left: pct(t), label: formatTime(new Date(t).toISOString()) });
		}
		return marks;
	});

	const rows = $derived(
		babies
			.filter((b) => b.baby)
			.map((b) => ({
				baby: b.baby!,
				status: getLaneStatus(b, now),
				segments: handoffSegments(b, now),
				wakings: handoffWakings(b, now),
			})),
	);

	function statusText(s: ReturnType<typeof getLaneStatus>): string {
		if (s.kind === 'stale') return '⚠️ Sjekk vaknetid';
		if (s.kind === 'asleep') return `Søv ${formatDurationCompact(s.sinceMs)}`;
		return s.sinceMs ? `Vaken ${formatDurationCompact(s.sinceMs)}` : 'Vaken';
	}
</script>

<details class="handoff" data-testid="handoff">
	<summary>Overlevering · siste 6 timar</summary>
	<div class="handoff-body">
		{#each rows as r (r.baby.id)}
			<div class="handoff-row" data-testid="handoff-row">
				<div class="handoff-head">
					<span class="handoff-name">{r.baby.name}</span>
					<span class="handoff-status" class:stale={r.status.kind === 'stale'}>{statusText(r.status)}</span>
				</div>
				<div class="handoff-bar" aria-hidden="true">
					{#each hourMarks as m}
						<span class="handoff-grid" style="left: {m.left}%"></span>
					{/each}
					{#each r.segments as seg}
						<span
							class="handoff-seg {seg.type}"
							class:ongoing={seg.ongoing}
							style="left: {pct(seg.startMs)}%; width: {pct(seg.endMs) - pct(seg.startMs)}%"
						></span>
					{/each}
					{#each r.wakings as w}
						<span class="handoff-wake" style="left: {pct(w.startMs)}%"></span>
					{/each}
				</div>
			</div>
		{/each}
		<div class="handoff-legend">
			<span><i class="sw nap"></i> lur</span>
			<span><i class="sw night"></i> natt</span>
			<span><i class="sw wake"></i> vakning</span>
		</div>
	</div>
</details>

<style>
	.handoff {
		background: var(--cream);
		border: 1px solid var(--cream-dark);
		border-radius: 16px;
		padding: 10px 14px;
	}
	.handoff summary {
		cursor: pointer;
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--text-light);
		list-style: none;
	}
	.handoff summary::-webkit-details-marker {
		display: none;
	}
	.handoff-body {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-top: 12px;
	}
	.handoff-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		margin-bottom: 4px;
	}
	.handoff-name {
		font-weight: 600;
	}
	.handoff-status {
		font-size: 0.8rem;
		color: var(--text-light);
	}
	.handoff-status.stale {
		color: var(--danger, #c0392b);
		font-weight: 600;
	}
	.handoff-bar {
		position: relative;
		height: 20px;
		background: var(--cream-dark);
		border-radius: 6px;
		overflow: hidden;
	}
	.handoff-grid {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 1px;
		background: rgba(0, 0, 0, 0.06);
	}
	.handoff-seg {
		position: absolute;
		top: 3px;
		bottom: 3px;
		border-radius: 4px;
		min-width: 2px;
	}
	.handoff-seg.nap {
		background: var(--lavender, #b9a7e6);
	}
	.handoff-seg.night {
		background: var(--lavender-dark, #6c57a8);
	}
	.handoff-seg.ongoing {
		box-shadow: 0 0 0 1.5px var(--peach-dark, #e08a5a);
	}
	.handoff-wake {
		position: absolute;
		top: 1px;
		bottom: 1px;
		width: 2px;
		background: var(--peach-dark, #e08a5a);
	}
	.handoff-legend {
		display: flex;
		gap: 14px;
		font-size: 0.72rem;
		color: var(--text-light);
	}
	.handoff-legend .sw {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 2px;
		margin-right: 3px;
		vertical-align: -1px;
	}
	.sw.nap {
		background: var(--lavender, #b9a7e6);
	}
	.sw.night {
		background: var(--lavender-dark, #6c57a8);
	}
	.sw.wake {
		background: var(--peach-dark, #e08a5a);
	}
</style>
