<script lang="ts">
	import {
		getDayArcConfig,
		getNightArcConfig,
		timeToArcFraction,
		timeToArcFractionRaw,
		fracToPoint,
		describeArc,
		collectBubbles,
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

	let now = $state(new Date());

	$effect(() => {
		const interval = setInterval(() => {
			now = new Date();
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

			if (bubble.status === 'active' && endFrac - startFrac < 0.015) {
				endFrac = Math.min(1, startFrac + 0.015);
			}

			if (Math.abs(endFrac - startFrac) < 0.005) continue;

			const d = describeArc(cx, cy, r, startFrac, endFrac);
			const tapD = describeArc(cx, cy, r, startFrac, endFrac);
			const midFrac = (startFrac + endFrac) / 2;
			const labelPt = fracToPoint(midFrac, cx, cy, r + 24);

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
				stroke = 'var(--moon)';
				strokeWidth = trackWidth + 2;
				dashArray = '6 4';
				opacity = 0.35;
			}

			let label: RenderedBubble['label'] = null;

			if (bubble.status === 'completed' && bubble.endTime) {
				const durationMs = bubble.endTime.getTime() - bubble.startTime.getTime();
				if (durationMs > 10 * 60000) {
					label = { x: labelPt.x, y: labelPt.y, text: formatDuration(durationMs), opacity: 1 };
				}
			} else if (bubble.status === 'predicted') {
				label = {
					x: labelPt.x,
					y: labelPt.y,
					text: formatTime(bubble.startTime),
					opacity: 0.6,
				};
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
			});
		}

		return result;
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

	<!-- Sleep bubbles -->
	{#each renderedBubbles as b}
		<g class="arc-bubble arc-bubble-{b.status}">
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
</svg>
