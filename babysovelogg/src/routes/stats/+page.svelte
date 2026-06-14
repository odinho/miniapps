<script lang="ts">
	import { formatDuration } from '$lib/utils.js';
	import { TS_CHART } from '$lib/stats-view-utils.js';
	import {
		computeChildrenStats,
		fetchChildrenRawData,
		statsMode,
		type ChildStats,
		type StatsChild,
	} from '$lib/stats/multi-child-stats.js';
	import {
		buildTwinOverlayCharts,
		buildTwinTimeline,
		type TwinOverlayChart,
	} from '$lib/stats/twin-overlay-charts.js';
	import {
		computeSharedSleepByDay,
		buildSharedSleepChart,
		type SharedSleepDay,
	} from '$lib/stats/shared-sleep.js';
	import type { ChildRawData } from '$lib/stats/multi-child-stats.js';
	import { appState } from '$lib/stores/app.svelte.js';
	import { calculateAgeMonths } from '$lib/engine/schedule.js';
	import {
		buildPredictionRows,
		buildComparisonTable,
		getNextSleepMilestone,
		formatAge,
	} from '$lib/settings-utils.js';
	import ChartFrame from '$lib/components/charts/ChartFrame.svelte';
	import ChartFullscreen from '$lib/components/charts/ChartFullscreen.svelte';
	import ChartLegend from '$lib/components/charts/ChartLegend.svelte';
	import TimeSeriesChart from '$lib/components/charts/TimeSeriesChart.svelte';
	import SleepTimelineChart from '$lib/components/charts/SleepTimelineChart.svelte';
	import HeatmapChart from '$lib/components/charts/HeatmapChart.svelte';

	const s = $derived(appState.state);
	const baby = $derived(s.baby);
	const ageMonths = $derived(baby ? calculateAgeMonths(baby.birthdate) : 0);
	const nextMilestone = $derived(baby ? getNextSleepMilestone(ageMonths) : null);
	const selectedNapCount = $derived(baby?.custom_nap_count ?? null);
	const statsChildren = $derived<StatsChild[]>(
		appState.babies.flatMap((child) =>
			child.baby
				? [
						{
							id: child.baby.id,
							name: child.baby.name,
							timezone: child.baby.timezone ?? undefined,
							birthdate: child.baby.birthdate,
						},
					]
				: [],
		),
	);
	const mode = $derived(statsMode(appState.babies.length, appState.state.family.isTwinMode));
	const completedNapCount = $derived(
		s.todaySleeps.filter((sl) => sl.type === 'nap' && sl.end_time).length,
	);
	const comparisonRows = $derived(
		baby
			? buildComparisonTable(
				ageMonths,
				s.prediction?.learnedSchedule ?? null,
				{
					dayTotals: s.dayTotals,
					todaySleeps: s.todaySleeps,
					completedNapCount,
					expectedNapCount: s.prediction?.expectedNapCount ?? completedNapCount,
					dailyTrendTotalMin: s.prediction?.dailyTrendTotalMin ?? null,
				},
			)
			: [],
	);
	const hasAltNorm = $derived(comparisonRows.some(r => r.altNorm !== undefined));
	const hasTodayColumn = $derived(comparisonRows.some(r => r.today !== undefined));
	const napComparison = $derived(comparisonRows.find(r => r.label === 'Lurar'));

	const predictionRows = $derived(
		baby
			? buildPredictionRows({
					ageMonths,
					napCount: selectedNapCount,
					completedNaps:
						s.todaySleeps.filter((sl) => sl.type === 'nap' && sl.end_time).length,
					wakeTime: s.todayWakeUp?.wake_time ?? null,
					recentSleeps: s.todaySleeps.map((sl) => ({
						start_time: sl.start_time,
						end_time: sl.end_time,
						type: sl.type as 'nap' | 'night',
					})),
					serverPrediction: s.prediction?.bedtime ? { predictedNaps: s.prediction.predictedNaps, expectedNapCount: s.prediction.expectedNapCount, bedtime: s.prediction.bedtime } : null,
					totalSleepMinutes:
						(s.stats?.totalNapMinutes ?? 0) + (s.stats?.totalNightMinutes ?? 0),
				})
			: [],
	);

	let loading = $state(true);
	let error = $state(false);
	let empty = $state(false);
	let childrenStats = $state<ChildStats[] | null>(null);
	let showFullHistory = $state(false);
	let loadingFullHistory = $state(false);
	let fullChildrenStats = $state<ChildStats[] | null>(null);
	let sharedSleepDays = $state<SharedSleepDay[] | null>(null);
	let fullSharedSleepDays = $state<SharedSleepDay[] | null>(null);

	/** Both-asleep minutes per day for exactly two children (parent downtime). */
	function sharedSleepFor(raw: ChildRawData[]): SharedSleepDay[] | null {
		if (raw.length !== 2) return null;
		return computeSharedSleepByDay(raw[0].sleeps, raw[1].sleeps, raw[0].baby.timezone ?? 'UTC');
	}

	// Fullscreen chart overlay
	let fullscreenSvg = $state<string | null>(null);
	let fullscreenTitle = $state('');
	let fullscreenLandscape = $state(true);

	function expand(svgHtml: string, title: string, landscape: boolean) {
		fullscreenSvg = svgHtml;
		fullscreenTitle = title;
		fullscreenLandscape = landscape;
	}

	function closeFullscreen() {
		fullscreenSvg = null;
	}

	async function loadFullHistory() {
		const children = statsChildren;
		if (children.length === 0) return;

		loadingFullHistory = true;
		try {
			const raw = await fetchChildrenRawData(children, true);
			fullChildrenStats = computeChildrenStats(raw);
			fullSharedSleepDays = sharedSleepFor(raw);
			showFullHistory = true;
		} finally {
			loadingFullHistory = false;
		}
	}

	/** Active stats: full history if loaded, otherwise 30-day. */
	const activeChildren = $derived(
		showFullHistory && fullChildrenStats ? fullChildrenStats : childrenStats,
	);
	const activeSharedSleep = $derived(
		showFullHistory && fullSharedSleepDays ? fullSharedSleepDays : sharedSleepDays,
	);
	const sharedSleepChart = $derived(activeSharedSleep ? buildSharedSleepChart(activeSharedSleep) : null);
	const twinOverlayCharts = $derived(
		mode === 'twinOverlay' && activeChildren && activeChildren.length > 1
			? buildTwinOverlayCharts(activeChildren)
			: null,
	);
	const twinTimeline = $derived(
		mode === 'twinOverlay' && activeChildren && activeChildren.length > 1
			? buildTwinTimeline(activeChildren)
			: null,
	);
	const twinChildLegend = $derived(
		activeChildren
			? activeChildren.map((child, i) => ({
					label: child.name,
					colorVar: i === 0 ? '--moon' : i === 1 ? '--peach-dark' : '--text-light',
				}))
			: [],
	);

	function twinLineSeries(chart: TwinOverlayChart) {
		return chart.series.map((series) => ({
			id: series.id,
			label: series.label,
			colorVar: series.colorVar,
			path: series.path,
			strokeWidth: 2.5,
			strokeLinecap: 'round',
			strokeLinejoin: 'round',
		}));
	}

	function childPottyMode(babyId: number): boolean {
		return appState.babyById(babyId)?.baby?.potty_mode === 1;
	}

	async function load() {
		const children = statsChildren;
		loading = true;
		error = false;
		if (children.length === 0) {
			childrenStats = null;
			fullChildrenStats = null;
			sharedSleepDays = null;
			fullSharedSleepDays = null;
			empty = appState.loaded;
			loading = !appState.loaded;
			return;
		}

		try {
			const raw = await fetchChildrenRawData(children, false);
			const hasAnyData = raw.some((child) => child.sleeps.length > 0 || child.diapers.length > 0);
			empty = !hasAnyData;
			childrenStats = hasAnyData ? computeChildrenStats(raw) : null;
			sharedSleepDays = hasAnyData ? sharedSleepFor(raw) : null;
		} catch {
			error = true;
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		load();
	});
</script>

<div class="view stats-view">
	<h1 class="history-header">Statistikk</h1>

	<!-- Unified comparison: Norm vs Baby -->
	{#if baby}
		<div class="stats-section">
			<div class="stats-section-head">
				<h3 class="stats-section-title">
					{#if hasTodayColumn}I dag vs. typisk vs. norm{:else}{baby.name} vs. norm{/if}
					<span class="stats-section-age">({formatAge(baby.birthdate)})</span>
				</h3>
				<details class="help-disclosure">
					<summary aria-label="Forklaring">?</summary>
					<p>
						{#if hasTodayColumn}«I dag»-tala er det som faktisk har skjedd i dag — natta som enda i morges + lurar som er ferdige.{/if}
						«Lærd typisk» er det appen har lært frå dei siste 7 dagane.
						«Norm» er publiserte aldersnormer (Galland 2012, AAP). Når barnet har eit anna
						lurmønster enn alderssnittet, viser me begge normsetta inline.
						{#if hasTodayColumn}Trendmål er glidande snitt over 7d/30d som engine brukar som «dagsmål».{/if}
					</p>
				</details>
			</div>
			<!--
				Card-list layout: one row per metric. Today's actual is the
				right-aligned punchline when present (the answer the parent
				came for). Sub-text below shows learned-typical + norm so
				the comparison stays visible without a real <table> (which
				clipped the baby column on narrow screens — 2026-05-14).
				When the baby's nap count differs from age norm we show both
				normsetts inline so the comparison still works.
			-->
			<div class="comparison-panel sleep-info-panel">
				{#each comparisonRows as row}
					{@const punchline = row.today ?? row.learned}
					{@const normLine = hasAltNorm && row.altNorm && row.norm !== row.altNorm
						? `${napComparison?.norm ?? ''}-lur: ${row.norm} · ${napComparison?.altNorm ?? ''}-lur: ${row.altNorm}`
						: row.norm === '—' ? null : `Norm ${row.norm}`}
					<div class="comparison-row">
						<div class="comparison-row-head">
							<span class="comparison-row-label">{row.label}</span>
							<span class="comparison-row-actual" class:comparison-row-actual--today={row.today != null}>{punchline}</span>
						</div>
						<div class="comparison-row-norm">
							{#if row.today != null && row.learned !== '—'}
								Lærd typisk {row.learned}{#if normLine} · {normLine}{/if}
							{:else if normLine}
								{normLine}
							{/if}
						</div>
					</div>
				{/each}
				<p class="comparison-footnote">
					Normverdiar er omtrentlege og varierer mellom barn. {baby.name}-verdiane er baserte på dei siste 7 dagane.
				</p>
			</div>

			{#if predictionRows.length > 0}
				<div
					data-testid="pred-panel"
					style="margin-top: 12px; padding: 12px; background: var(--lavender); border-radius: var(--radius-sm);"
				>
					<div class="pred-panel-head">
						<span style="font-weight: 600; font-size: 0.9rem;">Appen reknar med</span>
						<!-- Inline help: small (?) toggle reveals a one-paragraph
						     explanation. Defaults closed so the section stays
						     compact for parents who already understand it. -->
						<details class="help-disclosure">
							<summary aria-label="Forklaring">?</summary>
							<p>
								Dagens spesifikke prediksjonar — kva tid neste lur og leggetid kjem,
								og kor mykje søvn som er logga så langt i dag. Tider med tilde (~)
								er estimat basert på dei siste dagane og kan flytta seg etter kvart
								som dagen utviklar seg.
							</p>
						</details>
					</div>
					{#each predictionRows as row}
						<div class="stats-trend-row">
							<div class="stats-trend-label">{row.label}</div>
							<div class="stats-trend-val">{row.value}</div>
						</div>
					{/each}
				</div>
			{/if}

			{#if nextMilestone}
				<div
					style="margin-top: 12px; padding: 12px; background: var(--lavender); border-radius: var(--radius-sm); font-size: 0.85rem;"
				>
					<div style="font-weight: 600; margin-bottom: 4px;">Kva som kjem</div>
					<div style="color: var(--text-light);">{nextMilestone}</div>
				</div>
			{/if}
		</div>
	{/if}

	{#if loading}
		<div class="history-empty">Lastar...</div>
	{:else if error}
		<div class="history-empty">Klarte ikkje lasta statistikk</div>
	{:else if empty}
		<div class="history-empty">
			<div style="font-size: 3rem; margin-bottom: 16px;">📊</div>
			<div>Ingen søvndata enno</div>
			<div style="font-size: 0.9rem; margin-top: 8px;">
				Start med å spora søvn for å sjå diagram og trendar her
			</div>
		</div>
	{:else if activeChildren && activeChildren.length > 0}
		<!-- Full history toggle -->
		<div class="stats-section" style="text-align: center;">
			{#if showFullHistory}
				<button class="btn btn-ghost" style="font-size: 0.85rem; color: var(--text-light);" onclick={() => { showFullHistory = false; }}>
					Vis siste 30 dagar
				</button>
			{:else}
				<button class="btn btn-ghost" style="font-size: 0.85rem;" onclick={loadFullHistory} disabled={loadingFullHistory}>
					{loadingFullHistory ? 'Lastar...' : 'Vis heile historia'}
				</button>
			{/if}
		</div>

		{#snippet childPanel(cs: ChildStats['stats'], pottyMode: boolean)}
		<!-- Chart A: 30-Day Stacked Area Trend -->
		{#if cs.stackedArea.nightPath}
			<div class="stats-section">
				<h3 class="stats-section-title">Søvntrend (30 dagar)</h3>
				<ChartFrame title="Søvntrend" onExpand={expand}>
					<TimeSeriesChart
						gridLines={cs.stackedArea.gridLines}
						yTicks={cs.stackedArea.yTicks}
						xLabels={cs.stackedArea.xLabels}
						series={[
							{ path: cs.stackedArea.nightPath, fill: 'var(--moon)', opacity: 0.7 },
							{ path: cs.stackedArea.napPath, fill: 'var(--peach-dark)', opacity: 0.7 },
							...(cs.stackedArea.rollingAvgPath
								? [{ path: cs.stackedArea.rollingAvgPath, stroke: 'var(--danger-dark, #c0392b)', strokeWidth: 2.5, strokeLinecap: 'round', opacity: 0.8 }]
								: []),
						]}
					/>
					<ChartLegend items={[{ label: 'Lurar', colorVar: '--peach-dark' }, { label: 'Natt', colorVar: '--moon' }]} />
				</ChartFrame>
			</div>
		{/if}

		<!-- Chart B: Total Sleep vs Age Norms (hero chart) -->
		{#if cs.sleepVsNorm && cs.sleepVsNorm.actualPath}
			<div class="stats-section">
				<h3 class="stats-section-title">Total søvn vs. tilrådd</h3>
				<ChartFrame title="Total søvn vs. tilrådd" onExpand={expand}>
					<TimeSeriesChart
						gridLines={cs.sleepVsNorm.gridLines}
						yTicks={cs.sleepVsNorm.yTicks}
						xLabels={cs.sleepVsNorm.xLabels}
						bands={[{ path: cs.sleepVsNorm.bandPath, fill: 'var(--moon-glow)', opacity: 0.5 }]}
						series={[
							{ path: cs.sleepVsNorm.typicalPath, stroke: 'var(--text-light)', strokeWidth: 1.5, strokeDasharray: '4,3', opacity: 0.6 },
							{ path: cs.sleepVsNorm.actualPath, fill: 'var(--moon)', opacity: 0.85 },
						]}
					/>
					<ChartLegend items={[{ label: 'Faktisk søvn', colorVar: '--moon' }, { label: 'Tilrådd', colorVar: '--moon-glow' }]} />
				</ChartFrame>
			</div>
		{/if}

		<!-- Chart C: Night Stretch Growth -->
		{#if cs.nightStretchChart.linePath}
			<div class="stats-section">
				<h3 class="stats-section-title">Lengste nattestrekk</h3>
				<ChartFrame title="Lengste nattestrekk" onExpand={expand}>
					<TimeSeriesChart
						gridLines={cs.nightStretchChart.gridLines}
						yTicks={cs.nightStretchChart.yTicks}
						xLabels={cs.nightStretchChart.xLabels}
						series={[
							{ path: cs.nightStretchChart.areaPath, fill: 'var(--moon-glow)', opacity: 0.3 },
							...(cs.nightStretchChart.rollingAvgPath
								? [{ path: cs.nightStretchChart.rollingAvgPath, stroke: 'var(--danger-dark, #c0392b)', strokeWidth: 2.5, strokeLinecap: 'round', opacity: 0.8 }]
								: []),
							{ path: cs.nightStretchChart.linePath, stroke: 'var(--moon)', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
						]}
					/>
				</ChartFrame>
			</div>
		{/if}

		<!-- Chart: Bedtime Consistency -->
		{#if cs.bedtimeChart.linePath}
			<div class="stats-section">
				<h3 class="stats-section-title">Leggetid</h3>
				<ChartFrame title="Leggetid" onExpand={expand}>
					<TimeSeriesChart
						gridLines={cs.bedtimeChart.gridLines}
						yTicks={cs.bedtimeChart.yTicks}
						xLabels={cs.bedtimeChart.xLabels}
						series={[
							{ path: cs.bedtimeChart.linePath, stroke: 'var(--moon)', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
						]}
					>
						{#snippet underlay()}
							<line x1={TS_CHART.PAD_L} x2={TS_CHART.W - TS_CHART.PAD_R} y1={cs.bedtimeChart.avgY} y2={cs.bedtimeChart.avgY} stroke="var(--lavender-dark)" stroke-width="1" stroke-dasharray="4,3" />
							<text x={TS_CHART.W - TS_CHART.PAD_R} y={cs.bedtimeChart.avgY - 4} text-anchor="end" fill="var(--lavender-dark)" font-size="10" font-family="var(--font)">snitt {cs.bedtimeChart.avgLabel}</text>
						{/snippet}
					</TimeSeriesChart>
				</ChartFrame>
			</div>
		{/if}

		<!-- Nap Count Trend -->
		{#if cs.napCountChart.linePath}
			<div class="stats-section">
				<h3 class="stats-section-title">Lurar per dag</h3>
				<ChartFrame title="Lurar per dag" onExpand={expand}>
					<TimeSeriesChart
						gridLines={cs.napCountChart.gridLines}
						yTicks={cs.napCountChart.yTicks}
						xLabels={cs.napCountChart.xLabels}
						series={[
							...(cs.napCountChart.rollingAvgPath
								? [{ path: cs.napCountChart.rollingAvgPath, stroke: 'var(--danger-dark, #c0392b)', strokeWidth: 2.5, strokeLinecap: 'round', opacity: 0.8 }]
								: []),
							{ path: cs.napCountChart.linePath, stroke: 'var(--peach-dark)', strokeWidth: 2.5, strokeLinecap: 'round' },
						]}
					/>
				</ChartFrame>
			</div>
		{/if}


		<!-- Sleep trends 7d vs 30d -->
		<div class="stats-section">
			<h3 class="stats-section-title">Søvntrendar</h3>
			<div class="stats-trends-table">
				{#each cs.trendRows as row}
					<div class="stats-trend-row" class:stats-trend-header={row.isHeader}>
						<div class="stats-trend-label">{row.label}</div>
						<div class="stats-trend-val">{row.val7}</div>
						<div class="stats-trend-val">{row.val30}</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- Best/worst days -->
		{#if cs.bestWorst}
			<div class="stats-section">
				<h3 class="stats-section-title">Best og verst</h3>
				<div class="stats-row">
					<div class="stats-card">
						<div class="stat-value">{cs.bestWorst.best.label}</div>
						<div class="stat-label">Mest søvn: {cs.bestWorst.best.duration}</div>
					</div>
					<div class="stats-card">
						<div class="stat-value">{cs.bestWorst.worst.label}</div>
						<div class="stat-label">Minst søvn: {cs.bestWorst.worst.duration}</div>
					</div>
				</div>
			</div>
		{/if}

		<!-- Diaper stats -->
		{#if cs.diaperStats7}
			<div class="stats-section">
				<h3 class="stats-section-title">Bleie/Do</h3>
				<div class="stats-row">
					<div class="stats-card">
						<div class="stat-value">{cs.diaperStats7.perDay}</div>
						<div class="stat-label">Bleier/dag (7d)</div>
					</div>
					<div class="stats-card">
						<div class="stat-value">{cs.diaperStats7.wetCount}/{cs.diaperStats7.dirtyCount}/{cs.diaperStats7.bothCount}</div>
						<div class="stat-label">{pottyMode ? 'Tiss/Bæsj/Begge' : 'Våt/Skitten/Begge'}</div>
					</div>
					{#if cs.diaperStats30 && cs.diaperStats30.pottyCount > 0 && cs.diaperStats30.pottySuccessRate != null}
						<div class="stats-card">
							<div class="stat-value">{cs.diaperStats30.pottySuccessRate}%</div>
							<div class="stat-label">Suksessrate do</div>
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<!-- Tier 2: Additional charts -->
			<!-- Chart D: Sleep Timeline (Gantt) -->
			{#if cs.gantt.rows.length > 0}
				<div class="stats-section">
					<h3 class="stats-section-title">Døgnrytme (30 dagar)</h3>
					<ChartFrame title="Døgnrytme" landscape={false} wrapStyle="overflow-x: auto;" onExpand={expand}>
						<SleepTimelineChart
							rows={cs.gantt.rows}
							hourLabels={cs.gantt.hourLabels}
							height={cs.gantt.height}
						/>
						<ChartLegend items={[{ label: 'Lurar', colorVar: '--peach-dark' }, { label: 'Natt', colorVar: '--moon' }]} />
					</ChartFrame>
				</div>
			{/if}

			<!-- Chart E: 24h Sleep Heatmap -->
			{#if cs.heatmapChart.cells.length > 0}
				{@const hm = cs.heatmapChart}
				<div class="stats-section">
					<h3 class="stats-section-title">Søvnkart</h3>
					<ChartFrame title="Søvnkart" landscape={false} wrapStyle="overflow-y: auto; max-height: 70vh;" onExpand={expand}>
						<HeatmapChart width={hm.width} height={hm.height} cells={hm.cells} hourLabels={hm.hourLabels} dateLabels={hm.dateLabels} />
					</ChartFrame>
				</div>
			{/if}

			<!-- Wake window chart with context -->
			{#if cs.wakeScatter.dots.length > 0}
				<div class="stats-section">
					<h3 class="stats-section-title">Vakevindu siste 7 dagar</h3>
					<div class="stats-row" style="margin-bottom: 12px;">
						<div class="stats-card">
							<div class="stat-value">{cs.wakeAvg ? formatDuration(cs.wakeAvg * 60000) : '—'}</div>
							<div class="stat-label">Snitt</div>
						</div>
						<div class="stats-card">
							<div class="stat-value">{formatDuration(Math.min(...cs.wakeScatter.dots.map(d => d.minutes)) * 60000)}</div>
							<div class="stat-label">Kortast</div>
						</div>
						<div class="stats-card">
							<div class="stat-value">{formatDuration(Math.max(...cs.wakeScatter.dots.map(d => d.minutes)) * 60000)}</div>
							<div class="stat-label">Lengst</div>
						</div>
					</div>
					<p style="font-size: 0.8rem; color: var(--text-light); margin: 0 0 8px; line-height: 1.3;">
						Kvart punkt er eitt vakevindu — tida mellom to søvnperiodar.
						Fyrste vakevindu (etter morgon) er ofte kortast, siste (før leggetid) er lengst.
						{#if cs.wakeScatter.bandY}
							Det skraverte feltet viser tilrådd område.
						{/if}
					</p>
					<ChartFrame title="Vakevindu" onExpand={expand}>
						<TimeSeriesChart
							gridLines={cs.wakeScatter.gridLines}
							yTicks={cs.wakeScatter.yTicks}
							xLabels={[]}
							series={[]}
						>
							{#snippet underlay()}
								{#if cs.wakeScatter.bandY}
									<rect
										x={TS_CHART.PAD_L}
										y={cs.wakeScatter.bandY.top}
										width={TS_CHART.W - TS_CHART.PAD_L - TS_CHART.PAD_R}
										height={cs.wakeScatter.bandY.bottom - cs.wakeScatter.bandY.top}
										fill="var(--lavender)"
										opacity="0.25"
										rx="4"
									/>
								{/if}
							{/snippet}
							{#snippet overlay()}
								{#each cs.wakeScatter.dots as dot}
									<circle cx={dot.x} cy={dot.y} r="5" fill="var(--peach-dark)" stroke="var(--white)" stroke-width="1" opacity="0.7" />
									<text x={dot.x} y={dot.y - 8} text-anchor="middle" fill="var(--text-light)" font-size="8" font-family="var(--font)">{formatDuration(dot.minutes * 60000)}</text>
								{/each}
							{/snippet}
						</TimeSeriesChart>
					</ChartFrame>
				</div>
			{/if}
		{/snippet}

		{#snippet twinChildPanel(cs: ChildStats['stats'], pottyMode: boolean)}
		<!-- Sleep trends 7d vs 30d -->
		<div class="stats-section">
			<h3 class="stats-section-title">Søvntrendar</h3>
			<div class="stats-trends-table">
				{#each cs.trendRows as row}
					<div class="stats-trend-row" class:stats-trend-header={row.isHeader}>
						<div class="stats-trend-label">{row.label}</div>
						<div class="stats-trend-val">{row.val7}</div>
						<div class="stats-trend-val">{row.val30}</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- Best/worst days -->
		{#if cs.bestWorst}
			<div class="stats-section">
				<h3 class="stats-section-title">Best og verst</h3>
				<div class="stats-row">
					<div class="stats-card">
						<div class="stat-value">{cs.bestWorst.best.label}</div>
						<div class="stat-label">Mest søvn: {cs.bestWorst.best.duration}</div>
					</div>
					<div class="stats-card">
						<div class="stat-value">{cs.bestWorst.worst.label}</div>
						<div class="stat-label">Minst søvn: {cs.bestWorst.worst.duration}</div>
					</div>
				</div>
			</div>
		{/if}

		<!-- Diaper stats -->
		{#if cs.diaperStats7}
			<div class="stats-section">
				<h3 class="stats-section-title">Bleie/Do</h3>
				<div class="stats-row">
					<div class="stats-card">
						<div class="stat-value">{cs.diaperStats7.perDay}</div>
						<div class="stat-label">Bleier/dag (7d)</div>
					</div>
					<div class="stats-card">
						<div class="stat-value">{cs.diaperStats7.wetCount}/{cs.diaperStats7.dirtyCount}/{cs.diaperStats7.bothCount}</div>
						<div class="stat-label">{pottyMode ? 'Tiss/Bæsj/Begge' : 'Våt/Skitten/Begge'}</div>
					</div>
					{#if cs.diaperStats30 && cs.diaperStats30.pottyCount > 0 && cs.diaperStats30.pottySuccessRate != null}
						<div class="stats-card">
							<div class="stat-value">{cs.diaperStats30.pottySuccessRate}%</div>
							<div class="stat-label">Suksessrate do</div>
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<!-- Tier 2 (twin two-up): gantt is a shared combined chart above; here just heatmap + wake window -->

			<!-- Chart E: 24h Sleep Heatmap -->
			{#if cs.heatmapChart.cells.length > 0}
				{@const hm = cs.heatmapChart}
				<div class="stats-section">
					<h3 class="stats-section-title">Søvnkart</h3>
					<ChartFrame title="Søvnkart" landscape={false} wrapStyle="overflow-y: auto; max-height: 70vh;" onExpand={expand}>
						<HeatmapChart width={hm.width} height={hm.height} cells={hm.cells} hourLabels={hm.hourLabels} dateLabels={hm.dateLabels} />
					</ChartFrame>
				</div>
			{/if}

			<!-- Wake window chart with context -->
			{#if cs.wakeScatter.dots.length > 0}
				<div class="stats-section">
					<h3 class="stats-section-title">Vakevindu siste 7 dagar</h3>
					<div class="stats-row" style="margin-bottom: 12px;">
						<div class="stats-card">
							<div class="stat-value">{cs.wakeAvg ? formatDuration(cs.wakeAvg * 60000) : '—'}</div>
							<div class="stat-label">Snitt</div>
						</div>
						<div class="stats-card">
							<div class="stat-value">{formatDuration(Math.min(...cs.wakeScatter.dots.map(d => d.minutes)) * 60000)}</div>
							<div class="stat-label">Kortast</div>
						</div>
						<div class="stats-card">
							<div class="stat-value">{formatDuration(Math.max(...cs.wakeScatter.dots.map(d => d.minutes)) * 60000)}</div>
							<div class="stat-label">Lengst</div>
						</div>
					</div>
					<p style="font-size: 0.8rem; color: var(--text-light); margin: 0 0 8px; line-height: 1.3;">
						Kvart punkt er eitt vakevindu — tida mellom to søvnperiodar.
						Fyrste vakevindu (etter morgon) er ofte kortast, siste (før leggetid) er lengst.
						{#if cs.wakeScatter.bandY}
							Det skraverte feltet viser tilrådd område.
						{/if}
					</p>
					<ChartFrame title="Vakevindu" onExpand={expand}>
						<TimeSeriesChart
							gridLines={cs.wakeScatter.gridLines}
							yTicks={cs.wakeScatter.yTicks}
							xLabels={[]}
							series={[]}
						>
							{#snippet underlay()}
								{#if cs.wakeScatter.bandY}
									<rect
										x={TS_CHART.PAD_L}
										y={cs.wakeScatter.bandY.top}
										width={TS_CHART.W - TS_CHART.PAD_L - TS_CHART.PAD_R}
										height={cs.wakeScatter.bandY.bottom - cs.wakeScatter.bandY.top}
										fill="var(--lavender)"
										opacity="0.25"
										rx="4"
									/>
								{/if}
							{/snippet}
							{#snippet overlay()}
								{#each cs.wakeScatter.dots as dot}
									<circle cx={dot.x} cy={dot.y} r="5" fill="var(--peach-dark)" stroke="var(--white)" stroke-width="1" opacity="0.7" />
									<text x={dot.x} y={dot.y - 8} text-anchor="middle" fill="var(--text-light)" font-size="8" font-family="var(--font)">{formatDuration(dot.minutes * 60000)}</text>
								{/each}
							{/snippet}
						</TimeSeriesChart>
					</ChartFrame>
				</div>
			{/if}
		{/snippet}

		{#if sharedSleepChart}
			<div class="stats-section" data-testid="shared-sleep">
				<h3 class="stats-section-title">Felles søvn (foreldrekvile)</h3>
				<div class="stats-row" style="margin-bottom: 12px;">
					<div class="stats-card">
						<div class="stat-value">{formatDuration(sharedSleepChart.avgMinutes * 60000)}</div>
						<div class="stat-label">Snitt/dag begge søv</div>
					</div>
				</div>
				<ChartFrame title="Felles søvn" onExpand={expand}>
					<TimeSeriesChart
						gridLines={sharedSleepChart.gridLines}
						yTicks={sharedSleepChart.yTicks}
						xLabels={sharedSleepChart.xLabels}
						series={[{ path: sharedSleepChart.areaPath, fill: 'var(--lavender)', opacity: 0.5 }]}
					/>
				</ChartFrame>
			</div>
		{/if}

		{#if mode === 'single' && activeChildren.length === 1}
			{@render childPanel(activeChildren[0]!.stats, childPottyMode(activeChildren[0]!.babyId))}
		{:else if mode === 'twinOverlay' && twinOverlayCharts}
			{#if twinOverlayCharts.sleepTrend}
				<div class="stats-section" data-testid="twin-overlay-sleep-trend">
					<h3 class="stats-section-title">Søvntrend (30 dagar)</h3>
					<ChartFrame title="Søvntrend" onExpand={expand}>
						<TimeSeriesChart
							gridLines={twinOverlayCharts.sleepTrend.gridLines}
							yTicks={twinOverlayCharts.sleepTrend.yTicks}
							xLabels={twinOverlayCharts.sleepTrend.xLabels}
							series={twinLineSeries(twinOverlayCharts.sleepTrend)}
						/>
						<ChartLegend items={twinChildLegend} />
					</ChartFrame>
				</div>
			{/if}

			{#if twinOverlayCharts.sleepVsNorm}
				<div class="stats-section" data-testid="twin-overlay-sleep-vs-norm">
					<h3 class="stats-section-title">Total søvn vs. tilrådd</h3>
					<ChartFrame title="Total søvn vs. tilrådd" onExpand={expand}>
						<TimeSeriesChart
							gridLines={twinOverlayCharts.sleepVsNorm.gridLines}
							yTicks={twinOverlayCharts.sleepVsNorm.yTicks}
							xLabels={twinOverlayCharts.sleepVsNorm.xLabels}
							bands={twinOverlayCharts.sleepVsNorm.bands.map((b) => ({ path: b.path, fill: `var(${b.colorVar})`, opacity: b.opacity }))}
							series={twinLineSeries(twinOverlayCharts.sleepVsNorm)}
						/>
						<ChartLegend items={[...twinChildLegend, { label: 'Tilrådd', colorVar: '--moon-glow' }]} />
					</ChartFrame>
				</div>
			{/if}

			{#if twinOverlayCharts.nightStretch}
				<div class="stats-section" data-testid="twin-overlay-night-stretch">
					<h3 class="stats-section-title">Lengste nattestrekk</h3>
					<ChartFrame title="Lengste nattestrekk" onExpand={expand}>
						<TimeSeriesChart
							gridLines={twinOverlayCharts.nightStretch.gridLines}
							yTicks={twinOverlayCharts.nightStretch.yTicks}
							xLabels={twinOverlayCharts.nightStretch.xLabels}
							series={twinLineSeries(twinOverlayCharts.nightStretch)}
						/>
						<ChartLegend items={twinChildLegend} />
					</ChartFrame>
				</div>
			{/if}

			{#if twinOverlayCharts.bedtime}
				<div class="stats-section" data-testid="twin-overlay-bedtime">
					<h3 class="stats-section-title">Leggetid</h3>
					<ChartFrame title="Leggetid" onExpand={expand}>
						<TimeSeriesChart
							gridLines={twinOverlayCharts.bedtime.gridLines}
							yTicks={twinOverlayCharts.bedtime.yTicks}
							xLabels={twinOverlayCharts.bedtime.xLabels}
							series={twinLineSeries(twinOverlayCharts.bedtime)}
						/>
						<ChartLegend items={twinChildLegend} />
					</ChartFrame>
				</div>
			{/if}

			{#if twinOverlayCharts.napCount}
				<div class="stats-section" data-testid="twin-overlay-nap-count">
					<h3 class="stats-section-title">Lurar per dag</h3>
					<ChartFrame title="Lurar per dag" onExpand={expand}>
						<TimeSeriesChart
							gridLines={twinOverlayCharts.napCount.gridLines}
							yTicks={twinOverlayCharts.napCount.yTicks}
							xLabels={twinOverlayCharts.napCount.xLabels}
							series={twinLineSeries(twinOverlayCharts.napCount)}
						/>
						<ChartLegend items={twinChildLegend} />
					</ChartFrame>
				</div>
			{/if}

			{#if twinTimeline}
				<div class="stats-section" data-testid="twin-overlay-gantt">
					<h3 class="stats-section-title">Døgnrytme (30 dagar)</h3>
					<ChartFrame title="Døgnrytme" landscape={false} wrapStyle="overflow-x: auto;" onExpand={expand}>
						<SleepTimelineChart rows={twinTimeline.rows} hourLabels={twinTimeline.hourLabels} height={twinTimeline.height} />
						<ChartLegend items={twinChildLegend} />
					</ChartFrame>
				</div>
			{/if}

			{#each activeChildren as child, index (child.babyId)}
				<section class="stats-child-panel" data-testid="stats-child-panel">
					<h2 class="stats-child-name">{child.name}</h2>
					{@render twinChildPanel(child.stats, childPottyMode(child.babyId))}
				</section>
				{#if index < activeChildren.length - 1}
					<div class="stats-child-divider" aria-hidden="true"></div>
				{/if}
			{/each}
		{:else}
			{#each activeChildren as child, index (child.babyId)}
				<section class="stats-child-panel" data-testid="stats-child-panel">
					<h2 class="stats-child-name">{child.name}</h2>
					{@render childPanel(child.stats, childPottyMode(child.babyId))}
				</section>
				{#if index < activeChildren.length - 1}
					<div class="stats-child-divider" aria-hidden="true"></div>
				{/if}
			{/each}
		{/if}

		<!-- Export -->
		<div class="stats-section">
			<h3 class="stats-section-title">Eksport</h3>
			<div class="stats-row" style="gap: 8px;">
				<a
					href="/api/export?format=csv"
					target="_blank"
					rel="noopener"
					class="btn btn-ghost"
					data-testid="export-btn"
				>
					📤 Eksporter data
				</a>
				<a
					href="/api/export"
					target="_blank"
					rel="noopener"
					class="btn btn-ghost"
				>
					📋 Eksporter JSON
				</a>
			</div>
		</div>
	{/if}
</div>

<!-- Fullscreen chart overlay -->
<ChartFullscreen svg={fullscreenSvg} title={fullscreenTitle} landscape={fullscreenLandscape} onClose={closeFullscreen} />

<style>
	/* --- comparison: norm vs baby, card-list (mobile-first, no overflow) --- */
	.stats-child-panel {
		margin: 0;
	}

	.stats-child-name {
		margin: 20px 4px 12px;
		font-size: 1.05rem;
		font-weight: 600;
		color: var(--text);
	}

	.stats-child-divider {
		height: 1px;
		margin: 24px 0;
		background: var(--cream-dark);
	}

	.comparison-panel {
		padding: 4px 4px 0;
	}

	.comparison-row {
		padding: 8px 12px;
		border-bottom: 1px solid var(--cream-dark);
	}

	.comparison-row:last-of-type {
		border-bottom: none;
	}

	.comparison-row-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
	}

	.comparison-row-label {
		font-size: 0.85rem;
		color: var(--text);
	}

	.comparison-row-actual {
		font-size: 1.05rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		text-align: right;
		/* Allow the value to shrink-wrap; never let it get clipped. */
		flex-shrink: 0;
	}

	/* Distinguish "today" punchline from the fallback "learned" value so the
	   parent reads it as a fresh number, not the multi-day average. */
	.comparison-row-actual--today {
		color: var(--text);
	}

	.stats-section-age {
		font-size: 0.85rem;
		color: var(--text-light);
		font-weight: 400;
		margin-left: 4px;
	}

	.comparison-row-norm {
		font-size: 0.72rem;
		color: var(--text-light);
		margin-top: 2px;
		line-height: 1.3;
	}

	.comparison-footnote {
		font-size: 0.7rem;
		color: var(--text-light);
		margin: 8px 12px 6px;
		line-height: 1.3;
	}

	/* --- inline (?) help disclosures --- */
	.stats-section-head,
	.pred-panel-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
	}

	.help-disclosure {
		font-size: 0.85rem;
	}

	.help-disclosure summary {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		background: var(--cream-dark, rgba(255, 255, 255, 0.06));
		color: var(--text-light);
		cursor: pointer;
		font-weight: 600;
		font-size: 0.78rem;
		list-style: none;
		user-select: none;
		transition: background 0.15s, color 0.15s;
	}

	.help-disclosure summary::-webkit-details-marker {
		display: none;
	}

	.help-disclosure summary:hover,
	.help-disclosure[open] summary {
		background: var(--lavender);
		color: var(--text);
	}

	.help-disclosure p {
		margin: 8px 0 0;
		font-size: 0.78rem;
		line-height: 1.4;
		color: var(--text-light);
		background: var(--lavender);
		padding: 10px 12px;
		border-radius: var(--radius-sm);
	}
</style>
