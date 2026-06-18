<script lang="ts">
	import { composeArc, DEFAULT_ARC_GEOMETRY } from '$lib/arc-scene.js';

	interface Props {
		todaySleeps: Array<{ start_time: string; end_time: string | null; type: 'nap' | 'night' }>;
		activeSleep: {
			start_time: string;
			type: 'nap' | 'night';
		} | null;
		prediction: {
			nextNap: string;
			bedtime?: string;
			predictedNaps?: Array<{ startTime: string; endTime: string }>;
			napDurationMin?: number | null;
		} | null;
		isNightMode: boolean;
		/** Baby IANA timezone for arc hour math (defaults to runtime tz). */
		tz?: string;
		wakeUpTime?: string | null;
		startTimeLabel?: string | null;
		endTimeLabel?: string | null;
		/** Confidence bands for predicted nap starts: lo/hi ISO timestamps spanning ~±1 SD */
		napConfidenceBands?: Array<{ lo: string; hi: string }>;
		/**
		 * Predicted wake time for the active sleep. When set, the arc draws a faint
		 * dashed "planned" track from sleep-start → activeWakeAt so the bright active
		 * bubble (start → now) reads as a progress meter against the plan.
		 */
		activeWakeAt?: string | null;
		/** ±1 SD band around activeWakeAt (lo/hi ISO). Translucent peach/moon. */
		activeWakeBand?: { lo: string; hi: string } | null;
		/**
		 * A nap the engine predicted that didn't happen (parent skipped or baby
		 * didn't fall asleep). Rendered as a faded dashed blob with a strikethrough
		 * across it so the day's narrative stays intact instead of silently
		 * collapsing to bedtime mode.
		 */
		skippedNap?: { plannedAt: string } | null;
		/**
		 * A recommended rescue-nap window after a skip. Rendered as a soft predicted
		 * blob spanning earliest..latest, distinct from the strikethrough above.
		 */
		rescueWindow?: { earliest: string; latest: string } | null;
		/**
		 * Actual bedtime ISO. Night mode anchors arcStart to this; day mode
		 * anchors arcEnd to it. Keeps the displayed endpoint labels and the
		 * time-fraction math sharing a single source of truth so an active
		 * sleep at the start label sits at the start endpoint.
		 */
		bedtime?: string | null;
		/** Expected night-end ISO (`prediction.expectedNightEnd`). Anchors the night arc's arcEnd. */
		nightEnd?: string | null;
		/** Override internal clock (ms since epoch). Used by the dev playground. */
		nowMs?: number;
		/**
		 * Night wakings to overlay as red intervals on the night band. Click
		 * → opens the NightWakingEditSheet via `onNightWakingClick`.
		 */
		nightWakings?: Array<{ startTime: string; endTime: string | null; domainId: string }>;
		onStartClick?: () => void;
		onEndClick?: () => void;
		onSleepClick?: (index: number) => void;
		onPredictedNapClick?: (index: number) => void;
		onNightWakingClick?: (domainId: string) => void;
	}

	let {
		todaySleeps,
		activeSleep,
		prediction,
		isNightMode,
		tz,
		wakeUpTime = null,
		startTimeLabel = null,
		endTimeLabel = null,
		napConfidenceBands = [],
		activeWakeAt = null,
		activeWakeBand = null,
		skippedNap = null,
		rescueWindow = null,
		bedtime = null,
		nightEnd = null,
		nowMs,
		nightWakings = [],
		onStartClick,
		onEndClick,
		onSleepClick,
		onPredictedNapClick,
		onNightWakingClick,
	}: Props = $props();

	const G = DEFAULT_ARC_GEOMETRY;

	let _now = $state(new Date());
	const now = $derived(nowMs != null ? new Date(nowMs) : _now);

	$effect(() => {
		if (nowMs != null) return;
		const interval = setInterval(() => {
			_now = new Date();
		}, 10_000);
		return () => clearInterval(interval);
	});

	const scene = $derived(
		composeArc({
			todaySleeps,
			activeSleep,
			prediction,
			isNightMode,
			now,
			tz,
			wakeUpTime,
			startTimeLabel,
			endTimeLabel,
			napConfidenceBands,
			activeWakeAt,
			activeWakeBand,
			skippedNap,
			rescueWindow,
			bedtime,
			nightEnd,
			nightWakings,
			geometry: G,
		}),
	);

	const trackStroke = $derived(isNightMode ? 'rgba(120, 110, 170, 0.3)' : 'var(--lavender-dark)');

	function colorVar(c: 'moon' | 'peach'): string {
		return c === 'moon' ? 'var(--moon)' : 'var(--peach-dark)';
	}
</script>

<svg viewBox="0 0 {G.size} {G.size}" width="100%" class="sleep-arc">
	<defs>
		<filter id="arc-glow" x="-50%" y="-50%" width="200%" height="200%">
			<feGaussianBlur stdDeviation="4" result="glow" />
			<feMerge>
				<feMergeNode in="glow" />
				<feMergeNode in="SourceGraphic" />
			</feMerge>
		</filter>
	</defs>

	<!-- Background track -->
	<path
		d={scene.trackD}
		fill="none"
		stroke={trackStroke}
		stroke-width={G.trackWidth}
		stroke-linecap="round"
	/>

	<!-- Current time marker -->
	{#if scene.nowMarker.visible}
		<line
			x1={scene.nowMarker.outer.x}
			y1={scene.nowMarker.outer.y}
			x2={scene.nowMarker.inner.x}
			y2={scene.nowMarker.inner.y}
			stroke="var(--sun)"
			stroke-width="3"
			stroke-linecap="round"
		/>
	{/if}

	<!-- Planned-track for active sleep (drawn under the bubble so the
		 elapsed portion overprints as a progress meter) -->
	{#if scene.plannedTrack.visible}
		<path
			d={scene.plannedTrack.d}
			fill="none"
			stroke={colorVar(scene.plannedTrack.color)}
			stroke-width={G.trackWidth + 2}
			stroke-linecap="round"
			stroke-dasharray="6 4"
			opacity="0.35"
		/>
	{/if}

	<!-- Active wake confidence band (colour matches active sleep type) -->
	{#if scene.activeWakeBand.visible}
		<path
			d={scene.activeWakeBand.d}
			fill="none"
			stroke={colorVar(scene.activeWakeBand.color)}
			stroke-width={G.trackWidth * 2.4}
			stroke-linecap="round"
			opacity="0.3"
		/>
	{/if}

	<!-- Rescue window: soft predicted-style blob -->
	{#if scene.rescueBlob?.visible}
		<path
			d={scene.rescueBlob.d}
			fill="none"
			stroke="var(--peach-dark)"
			stroke-width={G.trackWidth + 2}
			stroke-linecap="round"
			stroke-dasharray="4 6"
			opacity="0.45"
		/>
	{/if}

	<!-- Nap confidence bands (±1 SD zones, rendered beneath predicted naps) -->
	{#each scene.confidenceBands as band}
		{#if band.visible}
			<path
				d={band.d}
				fill="none"
				stroke={colorVar(band.color)}
				stroke-width={G.trackWidth * 2.4}
				stroke-linecap="round"
				opacity="0.3"
			/>
		{/if}
	{/each}

	<!-- Sleep bubbles -->
	{#each scene.bubbles as b}
		<g class="arc-bubble arc-bubble-{b.status}">
			{#if b.dot}
				<circle
					cx={b.dot.cx}
					cy={b.dot.cy}
					r={b.dot.r}
					fill={colorVar(b.color)}
					opacity={b.opacity}
					filter={b.glow ? 'url(#arc-glow)' : null}
					class={b.pulse ? 'arc-active-pulse' : ''}
				/>
			{:else}
				<path
					d={b.d}
					fill="none"
					stroke={colorVar(b.color)}
					stroke-width={b.strokeWidth}
					stroke-linecap="round"
					opacity={b.opacity}
					stroke-dasharray={b.dashArray}
					filter={b.glow ? 'url(#arc-glow)' : null}
					class={b.pulse ? 'arc-active-pulse' : ''}
				/>
			{/if}

			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			{#if b.status === 'completed' && onSleepClick && b.sleepIndex != null && b.tapD}
				<path
					d={b.tapD}
					fill="none"
					stroke="transparent"
					stroke-width={G.trackWidth + 16}
					style="cursor:pointer"
					onclick={() => onSleepClick?.(b.sleepIndex!)}
				/>
			{/if}

			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			{#if b.status === 'predicted' && onPredictedNapClick && b.predictionIndex != null && b.tapD}
				<path
					d={b.tapD}
					fill="none"
					stroke="transparent"
					stroke-width={G.trackWidth + 16}
					style="cursor:pointer"
					onclick={() => onPredictedNapClick?.(b.predictionIndex!)}
				/>
			{/if}

			{#if b.label}
				<text
					x={b.label.x}
					y={b.label.y}
					text-anchor="middle"
					dominant-baseline="middle"
					fill="var(--text-light)"
					font-size="9"
					opacity={b.label.opacity}>{b.label.text}</text
				>
			{/if}
		</g>
	{/each}

	<!-- Night-waking overlays: red sub-bands inside the night band.
		 Drawn AFTER bubbles so they paint on top of the moon-coloured
		 night band, with a wider transparent tap target underneath. -->
	{#each scene.nightWakingOverlays as overlay (overlay.domainId)}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		{#if onNightWakingClick}
			<path
				d={overlay.tapD}
				fill="none"
				stroke="transparent"
				stroke-width={G.trackWidth + 16}
				style="cursor:pointer"
				onclick={() => onNightWakingClick?.(overlay.domainId)}
			/>
		{/if}
		<!-- Deep saturated red: the night band is light lavender (--moon) in
			 both themes, so the old salmon (231,110,110) sat at ~1.5:1 contrast
			 against it. This brick red is ~3:1 — readable in night mode without
			 reading as an alarm. -->
		<path
			d={overlay.d}
			fill="none"
			stroke="rgba(192, 57, 43, 0.95)"
			stroke-width={G.trackWidth - 2}
			stroke-linecap="round"
			opacity={overlay.active ? 1 : 0.9}
			class:arc-active-pulse={overlay.active}
		/>
	{/each}

	<!-- Skipped-nap blob: faded dashed peach arc + line-through time label -->
	{#if scene.skippedBlob?.visible}
		<path
			d={scene.skippedBlob.d}
			fill="none"
			stroke="var(--peach-dark)"
			stroke-width={G.trackWidth + 2}
			stroke-linecap="round"
			stroke-dasharray="3 5"
			opacity="0.35"
		/>
		<text
			x={scene.skippedBlob.label.x}
			y={scene.skippedBlob.label.y}
			text-anchor="middle"
			dominant-baseline="middle"
			fill="var(--text-light)"
			font-size="9"
			opacity="0.55"
			style="text-decoration: line-through;">{scene.skippedBlob.label.text}</text
		>
	{/if}

	<!-- Wake target dot + label drawn after bubbles so they stay visible
		 even when an active sleep overruns its predicted wake. -->
	{#if scene.plannedTrack.wakeDot}
		<circle
			cx={scene.plannedTrack.wakeDot.cx}
			cy={scene.plannedTrack.wakeDot.cy}
			r={scene.plannedTrack.wakeDot.r}
			fill={colorVar(scene.plannedTrack.color)}
			opacity="0.95"
		/>
	{/if}
	{#if scene.plannedTrack.wakeMarker}
		<text
			x={scene.plannedTrack.wakeMarker.x}
			y={scene.plannedTrack.wakeMarker.y}
			text-anchor="middle"
			dominant-baseline="middle"
			fill="var(--text-light)"
			font-size="9"
			opacity="0.85">{scene.plannedTrack.wakeMarker.label}</text
		>
	{/if}

	<!-- Endpoint icons drawn LAST so they sit on top of any bubble cap that
		 abuts them. Without this, a fresh active-sleep bubble's rounded
		 line cap visually fuses into the moon/sun endpoint's glow circle —
		 the 2026-05-17 "round-and-line not well designed" complaint. -->
	<g class="arc-endpoint-icon arc-endpoint-start" class:has-halo={scene.start.activeHalo != null}>
		{#if scene.start.activeHalo}
			<circle
				cx={scene.start.pt.x}
				cy={scene.start.pt.y}
				r="20"
				fill="none"
				stroke={colorVar(scene.start.activeHalo.color)}
				stroke-width="2.5"
				opacity="0.85"
				class="arc-endpoint-halo arc-active-pulse"
			/>
		{/if}
		<circle cx={scene.start.pt.x} cy={scene.start.pt.y} r="16" fill={scene.start.glow} />
		<text
			x={scene.start.pt.x}
			y={scene.start.pt.y + 1}
			font-size="18"
			text-anchor="middle"
			dominant-baseline="middle">{scene.start.icon}</text
		>
		{#if scene.start.label}
			<text
				x={scene.start.pt.x}
				y={scene.start.pt.y + 18}
				font-size="9"
				text-anchor="middle"
				fill="var(--text-light)"
				font-family="var(--font)">{scene.start.label}</text
			>
		{/if}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<circle
			cx={scene.start.pt.x}
			cy={scene.start.pt.y}
			r="24"
			fill="transparent"
			style="cursor:pointer"
			onclick={onStartClick}
		/>
	</g>

	<g class="arc-endpoint-icon arc-endpoint-end" class:has-halo={scene.end.activeHalo != null}>
		{#if scene.end.activeHalo}
			<circle
				cx={scene.end.pt.x}
				cy={scene.end.pt.y}
				r="20"
				fill="none"
				stroke={colorVar(scene.end.activeHalo.color)}
				stroke-width="2.5"
				opacity="0.85"
				class="arc-endpoint-halo arc-active-pulse"
			/>
		{/if}
		<circle cx={scene.end.pt.x} cy={scene.end.pt.y} r="16" fill={scene.end.glow} />
		<text
			x={scene.end.pt.x}
			y={scene.end.pt.y + 1}
			font-size="18"
			text-anchor="middle"
			dominant-baseline="middle">{scene.end.icon}</text
		>
		{#if scene.end.label}
			<text
				x={scene.end.pt.x}
				y={scene.end.pt.y + 18}
				font-size="9"
				text-anchor="middle"
				fill="var(--text-light)"
				font-family="var(--font)">{scene.end.label}</text
			>
		{/if}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<circle
			cx={scene.end.pt.x}
			cy={scene.end.pt.y}
			r="24"
			fill="transparent"
			style="cursor:pointer"
			onclick={onEndClick}
		/>
	</g>
</svg>
