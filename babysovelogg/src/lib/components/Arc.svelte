<script lang="ts">
	import {
		getDayArcConfig,
		getNightArcConfig,
		timeToArcFraction,
		timeToArcFractionRaw,
		fracToPoint,
		describeArc,
		collectBubbles,
		isAtArcEndpoint,
		type ArcConfig,
	} from '$lib/arc-utils.js';
	import { formatTime, formatDuration } from '$lib/utils.js';

	interface Props {
		todaySleeps: Array<{ start_time: string; end_time: string | null; type: 'nap' | 'night' }>;
		activeSleep: {
			start_time: string;
			type: 'nap' | 'night';
			isPaused?: boolean;
			pauseTime?: string;
		} | null;
		prediction: {
			nextNap: string;
			bedtime?: string;
			predictedNaps?: Array<{ startTime: string; endTime: string }>;
		} | null;
		isNightMode: boolean;
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
		/** ±1 SD band around activeWakeAt (lo/hi ISO). Translucent peach. */
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
		/** Override internal clock (ms since epoch). Used by the dev playground. */
		nowMs?: number;
		onStartClick?: () => void;
		onEndClick?: () => void;
		onSleepClick?: (index: number) => void;
		onPredictedNapClick?: (index: number) => void;
	}

	let {
		todaySleeps,
		activeSleep,
		prediction,
		isNightMode,
		wakeUpTime = null,
		startTimeLabel = null,
		endTimeLabel = null,
		napConfidenceBands = [],
		activeWakeAt = null,
		activeWakeBand = null,
		skippedNap = null,
		rescueWindow = null,
		nowMs,
		onStartClick,
		onEndClick,
		onSleepClick,
		onPredictedNapClick,
	}: Props = $props();

	const S = 320;
	const cx = S / 2;
	const cy = S / 2;
	const r = 130;
	const trackWidth = 14;

	let _now = $state(new Date());
	const now = $derived(nowMs != null ? new Date(nowMs) : _now);

	$effect(() => {
		if (nowMs != null) return;
		const interval = setInterval(() => {
			_now = new Date();
		}, 10_000);
		return () => clearInterval(interval);
	});

	const config = $derived<ArcConfig>(
		isNightMode ? getNightArcConfig() : getDayArcConfig(wakeUpTime),
	);

	const trackD = $derived(describeArc(cx, cy, r, 0, 1));
	const trackStroke = $derived(isNightMode ? 'rgba(120, 110, 170, 0.3)' : 'var(--lavender-dark)');

	const startPt = $derived(fracToPoint(0, cx, cy, r));
	const endPt = $derived(fracToPoint(1, cx, cy, r));
	const startIcon = $derived(isNightMode ? '\u{1F319}' : '\u{2600}\u{FE0F}');
	const endIcon = $derived(isNightMode ? '\u{2600}\u{FE0F}' : '\u{1F319}');

	const startGlow = $derived(
		isNightMode ? 'rgba(100, 90, 150, 0.3)' : 'rgba(232, 223, 245, 0.6)',
	);

	// Current time marker
	const nowFracRaw = $derived(timeToArcFractionRaw(now, config));
	const showNowMarker = $derived(nowFracRaw >= 0 && nowFracRaw <= 1);
	const nowFrac = $derived(Math.max(0, Math.min(1, nowFracRaw)));
	const nowOuter = $derived(fracToPoint(nowFrac, cx, cy, r + trackWidth / 2 + 3));
	const nowInner = $derived(fracToPoint(nowFrac, cx, cy, r - trackWidth / 2 - 3));

	// Bubbles
	const bubbles = $derived(collectBubbles(todaySleeps, activeSleep, prediction));

	interface RenderedBubble {
		d: string;
		status: 'completed' | 'active' | 'predicted';
		type: 'nap' | 'night';
		stroke: string;
		strokeWidth: number;
		opacity: number;
		dashArray: string | null;
		filter: string | null;
		cssClass: string;
		sleepIndex?: number;
		predictionIndex?: number;
		label: { x: number; y: number; text: string; opacity: number } | null;
		tapD: string;
		/** When true, render as a circle dot instead of an arc path */
		dot: { cx: number; cy: number; r: number } | null;
	}

	const renderedBubbles = $derived.by((): RenderedBubble[] => {
		const result: RenderedBubble[] = [];

		for (const bubble of bubbles) {
			const startFracRaw = timeToArcFractionRaw(bubble.startTime, config);
			const endFracRaw = bubble.endTime
				? timeToArcFractionRaw(bubble.endTime, config)
				: timeToArcFractionRaw(now, config);

			if (startFracRaw > 1.05 && endFracRaw > 1.05) continue;
			if (startFracRaw < -0.05 && endFracRaw < -0.05) continue;

			const startFrac = timeToArcFraction(bubble.startTime, config);
			let endFrac = bubble.endTime
				? timeToArcFraction(bubble.endTime, config)
				: timeToArcFraction(now, config);

			// Sleep is outside this arc's time window (clamping inverted start/end)
			if (endFrac < startFrac) continue;

			// A 13-min active night sleep on the 720-min night arc is 0.018 of
			// the arc — visually a thin sliver that disappears next to the
			// wake-band paint at the other end. Treat anything under 0.03
			// (≈22 min on the 12-h arcs) as "very short" for active sleep so
			// the dot anchor below renders and the parent can see where the
			// active sleep actually started.
			const veryShortThreshold = bubble.status === 'active' ? 0.03 : 0.015;
			const isVeryShort = endFrac - startFrac < veryShortThreshold;

			if (bubble.status === 'active' && isVeryShort) {
				endFrac = Math.min(1, startFrac + 0.015);
			}

			if (Math.abs(endFrac - startFrac) < 0.005) continue;

			const d = describeArc(cx, cy, r, startFrac, endFrac);
			const tapD = describeArc(cx, cy, r, startFrac, endFrac);
			const midFrac = (startFrac + endFrac) / 2;
			const midPt = fracToPoint(midFrac, cx, cy, r + 24);
			// For start/end labels, offset slightly from the bubble edge
			const startLabelFrac = Math.min(startFrac + 0.02, midFrac);
			const startLabelPt = fracToPoint(startLabelFrac, cx, cy, r + 24);
			const endLabelFrac = Math.max(endFrac - 0.02, midFrac);
			const endLabelPt = fracToPoint(endLabelFrac, cx, cy, r + 24);

			let stroke: string;
			let strokeWidth: number;
			let opacity = 1;
			let dashArray: string | null = null;
			let filter: string | null = null;
			let cssClass = '';

			if (bubble.status === 'completed') {
				stroke = bubble.type === 'night' ? 'var(--moon)' : 'var(--peach-dark)';
				strokeWidth = trackWidth + 2;
				opacity = 0.9;
			} else if (bubble.status === 'active') {
				stroke = bubble.type === 'night' ? 'var(--moon)' : 'var(--peach-dark)';
				strokeWidth = trackWidth + 4;
				filter = 'url(#arc-glow)';
				cssClass = 'arc-active-pulse';
			} else {
				stroke = bubble.type === 'night' ? 'var(--moon)' : 'var(--peach-dark)';
				strokeWidth = trackWidth + 2;
				dashArray = '6 4';
				opacity = 0.5;
			}

			let label: RenderedBubble['label'] = null;

			if (bubble.status === 'completed' && bubble.endTime) {
				const durationMs = bubble.endTime.getTime() - bubble.startTime.getTime();
				if (durationMs > 10 * 60000) {
					label = { x: midPt.x, y: midPt.y, text: formatDuration(durationMs), opacity: 1 };
				}
			} else if (bubble.status === 'active') {
				// Show start time label at the start of the bubble (not middle)
				const elapsed = now.getTime() - bubble.startTime.getTime();
				const startTimeStr = formatTime(bubble.startTime);
				// Suppress if it duplicates the arc start endpoint label
				const duplicatesEndpoint = startTimeLabel === startTimeStr;
				if (elapsed > 3 * 60000 && !duplicatesEndpoint) {
					label = {
						x: startLabelPt.x,
						y: startLabelPt.y,
						text: startTimeStr,
						opacity: 0.8,
					};
				}
			} else if (bubble.status === 'predicted') {
				label = {
					x: startLabelPt.x,
					y: startLabelPt.y,
					text: formatTime(bubble.startTime),
					opacity: 0.6,
				};
			}

			// For very short active arcs, render as a dot instead of a path
			let dot: RenderedBubble['dot'] = null;
			if (bubble.status === 'active' && isVeryShort) {
				const dotPt = fracToPoint(startFrac, cx, cy, r);
				dot = { cx: dotPt.x, cy: dotPt.y, r: strokeWidth / 2 };
			}

			result.push({
				d,
				status: bubble.status,
				type: bubble.type,
				stroke,
				strokeWidth,
				opacity,
				dashArray,
				filter,
				cssClass,
				sleepIndex: bubble.sleepIndex,
				predictionIndex: bubble.predictionIndex,
				label,
				tapD,
				dot,
			});
		}

		return result;
	});

	interface RenderedBand {
		d: string;
		visible: boolean;
	}

	// Confidence bands: translucent zones showing ±1 SD uncertainty for predicted nap starts.
	// Only render while the window is still open (hi > now).
	const renderedBands = $derived.by((): RenderedBand[] => {
		return napConfidenceBands.map((band) => {
			const hiMs = new Date(band.hi).getTime();
			if (hiMs < now.getTime()) return { d: '', visible: false };

			const loFrac = timeToArcFraction(new Date(band.lo), config);
			const hiFrac = timeToArcFraction(new Date(band.hi), config);
			if (hiFrac <= loFrac || hiFrac - loFrac < 0.005) return { d: '', visible: false };

			return { d: describeArc(cx, cy, r, loFrac, hiFrac), visible: true };
		});
	});

	// Planned-track for the active sleep: faint dashed arc from sleep-start
	// to activeWakeAt. The bright active bubble (start → now) renders on top so
	// the whole thing reads as progress: filled = elapsed, dashed = remaining.
	// In overtime (now > wake) the bubble covers the dashed track, so we also
	// emit a perpendicular wake tick that draws above the bubble — the target
	// stays visible while the bubble overruns past it.
	interface PlannedTrack {
		d: string;
		visible: boolean;
		type: 'nap' | 'night';
		wakeMarker: { x: number; y: number; label: string } | null;
		wakeTick: { x1: number; y1: number; x2: number; y2: number } | null;
	}

	const plannedTrack = $derived.by((): PlannedTrack => {
		const empty: PlannedTrack = { d: '', visible: false, type: 'nap', wakeMarker: null, wakeTick: null };
		if (!activeSleep || !activeWakeAt) return empty;

		const startFrac = timeToArcFraction(new Date(activeSleep.start_time), config);
		const wakeFracRaw = timeToArcFractionRaw(new Date(activeWakeAt), config);
		// Clamp the wake mark to the visible arc so an end-of-day overrun
		// still shows a track terminating at the arc end.
		const wakeFrac = Math.max(0, Math.min(1, wakeFracRaw));
		if (wakeFrac - startFrac < 0.005) return empty;

		// Suppress the standalone wake-marker + tick when it would overlap or
		// visually duplicate the arc's endpoint icon. Two gates:
		//
		//   1. Geometric: fraction is within ARC_ENDPOINT_PROXIMITY of either
		//      endpoint. Catches the obvious "06:00 wake = arc end" case.
		//   2. Semantic: the marker's formatted label matches the endpoint
		//      label that's already on the same side. Catches the trickier
		//      case where wake is at 05:49 with seconds (e.g. 05:48:42), the
		//      fraction lands at 0.984 (just inside 1 - 0.015 = 0.985), but
		//      both labels format to the same HH:MM string. Without the
		//      semantic gate the parent saw two "05:49" labels stacked, which
		//      is what the 2026-05-17 screenshot reported.
		const wakeLabel = formatTime(new Date(activeWakeAt));
		const wakeAtEndpoint = isAtArcEndpoint(wakeFrac)
			|| (wakeFrac > 0.5 && endTimeLabel === wakeLabel)
			|| (wakeFrac < 0.5 && startTimeLabel === wakeLabel);

		const d = describeArc(cx, cy, r, startFrac, wakeFrac);
		const markerPt = fracToPoint(wakeFrac, cx, cy, r + 24);
		// Tick extends slightly outside the bubble's outer edge so it stays
		// visible regardless of bubble strokeWidth.
		const tickOuter = fracToPoint(wakeFrac, cx, cy, r + trackWidth / 2 + 6);
		const tickInner = fracToPoint(wakeFrac, cx, cy, r - trackWidth / 2 - 6);
		return {
			d,
			visible: true,
			type: activeSleep.type,
			wakeMarker: wakeAtEndpoint
				? null
				: { x: markerPt.x, y: markerPt.y, label: wakeLabel },
			wakeTick: wakeAtEndpoint
				? null
				: { x1: tickOuter.x, y1: tickOuter.y, x2: tickInner.x, y2: tickInner.y },
		};
	});

	// Active wake confidence band: translucent zone centered on activeWakeAt.
	// Hidden once now > hi (the predicted window has passed — overtime mode).
	const activeWakeBandPath = $derived.by((): { d: string; visible: boolean } => {
		if (!activeSleep || !activeWakeBand) return { d: '', visible: false };
		const hiMs = new Date(activeWakeBand.hi).getTime();
		if (hiMs < now.getTime()) return { d: '', visible: false };
		const loFrac = timeToArcFraction(new Date(activeWakeBand.lo), config);
		const hiFrac = timeToArcFraction(new Date(activeWakeBand.hi), config);
		if (hiFrac <= loFrac || hiFrac - loFrac < 0.005) return { d: '', visible: false };
		return { d: describeArc(cx, cy, r, loFrac, hiFrac), visible: true };
	});

	// Skipped nap: faded dashed blob spanning plannedAt..plannedAt+45m,
	// matching the geometry of a predicted-nap bubble so the user reads the
	// label as the *start* time (like every other nap on the arc) — not the
	// middle of an artificially centered blob. The line-through label is the
	// strikethrough signal; no perpendicular tick (that pointed at the middle
	// and looked like "the nap happened at HH:MM at the middle position").
	interface SkippedBlob {
		d: string;
		label: { x: number; y: number; text: string };
		visible: boolean;
	}
	const skippedBlob = $derived.by((): SkippedBlob | null => {
		if (!skippedNap) return null;
		const plannedMs = new Date(skippedNap.plannedAt).getTime();
		const loFrac = timeToArcFraction(new Date(plannedMs), config);
		const hiFrac = timeToArcFraction(new Date(plannedMs + 45 * 60_000), config);
		if (hiFrac - loFrac < 0.005) return null;
		const d = describeArc(cx, cy, r, loFrac, hiFrac);
		// Label sits just past the start, like predicted-nap bubbles in
		// renderedBubbles, so the time visually anchors to the bubble's left
		// edge instead of floating over its middle.
		const labelFrac = Math.min(loFrac + 0.02, hiFrac);
		const labelPt = fracToPoint(labelFrac, cx, cy, r + 24);
		return {
			d,
			label: { x: labelPt.x, y: labelPt.y, text: formatTime(skippedNap.plannedAt) },
			visible: true,
		};
	});

	// Rescue window: faint predicted-style blob spanning the suggested rescue
	// start window. Visually softer than a normal predicted nap to signal
	// "this is a suggestion, not a hard plan."
	const rescueBlob = $derived.by((): { d: string; visible: boolean } | null => {
		if (!rescueWindow) return null;
		const lo = new Date(rescueWindow.earliest);
		const hi = new Date(rescueWindow.latest);
		if (hi.getTime() < now.getTime()) return null;
		const loFrac = timeToArcFraction(lo, config);
		const hiFrac = timeToArcFraction(hi, config);
		if (hiFrac - loFrac < 0.005) return null;
		return { d: describeArc(cx, cy, r, loFrac, hiFrac), visible: true };
	});
</script>

<svg viewBox="0 0 {S} {S}" width="100%" class="sleep-arc">
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
		d={trackD}
		fill="none"
		stroke={trackStroke}
		stroke-width={trackWidth}
		stroke-linecap="round"
	/>

	<!-- Start endpoint -->
	<g class="arc-endpoint-icon">
		<circle cx={startPt.x} cy={startPt.y} r="16" fill={startGlow} />
		<text
			x={startPt.x}
			y={startPt.y + 1}
			font-size="18"
			text-anchor="middle"
			dominant-baseline="middle">{startIcon}</text
		>
		{#if startTimeLabel}
			<text
				x={startPt.x}
				y={startPt.y + 18}
				font-size="9"
				text-anchor="middle"
				fill="var(--text-light)"
				font-family="var(--font)">{startTimeLabel}</text
			>
		{/if}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<circle
			cx={startPt.x}
			cy={startPt.y}
			r="24"
			fill="transparent"
			style="cursor:pointer"
			onclick={onStartClick}
		/>
	</g>

	<!-- End endpoint -->
	<g class="arc-endpoint-icon">
		<circle cx={endPt.x} cy={endPt.y} r="16" fill={startGlow} />
		<text
			x={endPt.x}
			y={endPt.y + 1}
			font-size="18"
			text-anchor="middle"
			dominant-baseline="middle">{endIcon}</text
		>
		{#if endTimeLabel}
			<text
				x={endPt.x}
				y={endPt.y + 18}
				font-size="9"
				text-anchor="middle"
				fill="var(--text-light)"
				font-family="var(--font)">{endTimeLabel}</text
			>
		{/if}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<circle
			cx={endPt.x}
			cy={endPt.y}
			r="24"
			fill="transparent"
			style="cursor:pointer"
			onclick={onEndClick}
		/>
	</g>

	<!-- Current time marker -->
	{#if showNowMarker}
		<line
			x1={nowOuter.x}
			y1={nowOuter.y}
			x2={nowInner.x}
			y2={nowInner.y}
			stroke="var(--sun)"
			stroke-width="3"
			stroke-linecap="round"
		/>
	{/if}

	<!-- Planned-track for active sleep (drawn under the bubble so the
		 elapsed portion overprints as a progress meter) -->
	{#if plannedTrack.visible}
		<path
			d={plannedTrack.d}
			fill="none"
			stroke={plannedTrack.type === 'night' ? 'var(--moon)' : 'var(--peach-dark)'}
			stroke-width={trackWidth + 2}
			stroke-linecap="round"
			stroke-dasharray="6 4"
			opacity="0.35"
		/>
	{/if}

	<!-- Confidence band around the active sleep's predicted wake. Color
		 follows the sleep type so a night-mode band reads as the *night*
		 wake uncertainty (moon-coloured) instead of looking like a peach
		 nap-elapsed paint at the wrong end of the arc — the 2026-05-17
		 screenshot complaint. -->
	{#if activeWakeBandPath.visible}
		<path
			d={activeWakeBandPath.d}
			fill="none"
			stroke={activeSleep?.type === 'night' ? 'var(--moon)' : 'var(--peach-dark)'}
			stroke-width={trackWidth * 2.4}
			stroke-linecap="round"
			opacity="0.3"
		/>
	{/if}

	<!-- Rescue window: soft predicted-style blob for the suggested power-nap
		 window after a skipped nap. Drawn under bubbles. -->
	{#if rescueBlob?.visible}
		<path
			d={rescueBlob.d}
			fill="none"
			stroke="var(--peach-dark)"
			stroke-width={trackWidth + 2}
			stroke-linecap="round"
			stroke-dasharray="4 6"
			opacity="0.45"
		/>
	{/if}

	<!-- Nap confidence bands (±1 SD zones, rendered beneath predicted naps) -->
	{#each renderedBands as band}
		{#if band.visible}
			<path
				d={band.d}
				fill="none"
				stroke="var(--peach-dark)"
				stroke-width={trackWidth * 2.4}
				stroke-linecap="round"
				opacity="0.3"
			/>
		{/if}
	{/each}

	<!-- Sleep bubbles -->
	{#each renderedBubbles as b}
		<g class="arc-bubble arc-bubble-{b.status}">
			{#if b.dot}
				<circle
					cx={b.dot.cx}
					cy={b.dot.cy}
					r={b.dot.r}
					fill={b.stroke}
					opacity={b.opacity}
					filter={b.filter}
					class={b.cssClass}
				/>
			{:else}
				<path
					d={b.d}
					fill="none"
					stroke={b.stroke}
					stroke-width={b.strokeWidth}
					stroke-linecap="round"
					opacity={b.opacity}
					stroke-dasharray={b.dashArray}
					filter={b.filter}
					class={b.cssClass}
				/>
			{/if}

			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			{#if b.status === 'completed' && onSleepClick && b.sleepIndex != null}
				<path
					d={b.tapD}
					fill="none"
					stroke="transparent"
					stroke-width={trackWidth + 16}
					style="cursor:pointer"
					onclick={() => onSleepClick?.(b.sleepIndex!)}
				/>
			{/if}

			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			{#if b.status === 'predicted' && onPredictedNapClick && b.predictionIndex != null}
				<path
					d={b.tapD}
					fill="none"
					stroke="transparent"
					stroke-width={trackWidth + 16}
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

	<!-- Skipped-nap blob: faded dashed peach arc + line-through time label
		 at the start, matching the geometry of predicted-nap bubbles. -->
	{#if skippedBlob?.visible}
		<path
			d={skippedBlob.d}
			fill="none"
			stroke="var(--peach-dark)"
			stroke-width={trackWidth + 2}
			stroke-linecap="round"
			stroke-dasharray="3 5"
			opacity="0.35"
		/>
		<text
			x={skippedBlob.label.x}
			y={skippedBlob.label.y}
			text-anchor="middle"
			dominant-baseline="middle"
			fill="var(--text-light)"
			font-size="9"
			opacity="0.55"
			style="text-decoration: line-through;">{skippedBlob.label.text}</text
		>
	{/if}

	<!-- Wake target tick + label. Drawn after bubbles so the target stays
		 visible when an active sleep overruns its predicted wake. -->
	{#if plannedTrack.visible && plannedTrack.wakeTick}
		<line
			x1={plannedTrack.wakeTick.x1}
			y1={plannedTrack.wakeTick.y1}
			x2={plannedTrack.wakeTick.x2}
			y2={plannedTrack.wakeTick.y2}
			stroke={plannedTrack.type === 'night' ? 'var(--moon)' : 'var(--peach-dark)'}
			stroke-width="2"
			stroke-linecap="round"
			opacity="0.8"
		/>
	{/if}
	{#if plannedTrack.visible && plannedTrack.wakeMarker}
		<text
			x={plannedTrack.wakeMarker.x}
			y={plannedTrack.wakeMarker.y}
			text-anchor="middle"
			dominant-baseline="middle"
			fill="var(--text-light)"
			font-size="9"
			opacity="0.7">{plannedTrack.wakeMarker.label}</text
		>
	{/if}
</svg>
