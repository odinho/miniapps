<script lang="ts">
	import { formatDuration } from '$lib/utils.js';
	import {
		TS_CHART,
		GANTT,
		fetchStatsData,
		fetchFullHistory,
		computeAllStats,
		type ComputedStats,
	} from '$lib/stats-view-utils.js';
	import { appState } from '$lib/stores/app.svelte.js';
	import { calculateAgeMonths } from '$lib/engine/schedule.js';
	import {
		buildSleepInfoRows,
		buildPredictionRows,
		getNextSleepMilestone,
		formatAge,
	} from '$lib/settings-utils.js';

	const s = $derived(appState.state);
	const baby = $derived(s.baby);
	const ageMonths = $derived(baby ? calculateAgeMonths(baby.birthdate) : 0);
	const sleepInfoRows = $derived(baby ? buildSleepInfoRows(ageMonths) : []);
	const nextMilestone = $derived(baby ? getNextSleepMilestone(ageMonths) : null);
	const selectedNapCount = $derived(baby?.custom_nap_count ?? null);
	const pottyMode = $derived(baby?.potty_mode === 1);

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
	let showSleepDetail = $state(false);
	let error = $state(false);
	let empty = $state(false);
	let stats = $state<ComputedStats | null>(null);
	let showFullHistory = $state(false);
	let loadingFullHistory = $state(false);
	let fullStats = $state<ComputedStats | null>(null);

	// Fullscreen chart overlay
	let fullscreenSvg = $state<string | null>(null);
	let fullscreenTitle = $state('');

	function openFullscreen(svgEl: SVGSVGElement | null, title: string) {
		if (!svgEl) return;
		fullscreenSvg = svgEl.outerHTML;
		fullscreenTitle = title;
	}

	function closeFullscreen() {
		fullscreenSvg = null;
	}

	function handleChartClick(e: MouseEvent, title: string) {
		const wrap = (e.currentTarget as HTMLElement);
		const svg = wrap.querySelector('svg');
		openFullscreen(svg, title);
	}

	async function loadFullHistory() {
		loadingFullHistory = true;
		try {
			const allData = await fetchFullHistory();
			fullStats = computeAllStats(allData.sleeps, allData.diapers, baby?.timezone ?? undefined, baby?.birthdate ?? undefined);
			showFullHistory = true;
		} finally {
			loadingFullHistory = false;
		}
	}

	/** Active stats: full history if loaded, otherwise 30-day */
	const activeStats = $derived(showFullHistory && fullStats ? fullStats : stats);

	async function load() {
		loading = true;
		error = false;
		try {
			const data = await fetchStatsData();
			if (data.sleeps.length === 0 && data.diapers.length === 0) {
				empty = true;
			} else {
				empty = false;
				stats = computeAllStats(data.sleeps, data.diapers, baby?.timezone ?? undefined, baby?.birthdate ?? undefined);
			}
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

	<!-- Predictions first (most actionable), then age norms -->
	{#if baby}
		{#if predictionRows.length > 0}
			<div class="stats-section">
				<div
					data-testid="pred-panel"
					class="sleep-info-panel"
					style="background: var(--lavender); border-radius: var(--radius-sm); padding: 12px;"
				>
					<div style="font-weight: 600; margin-bottom: 8px; font-size: 0.9rem;">
						Appen reknar med
					</div>
					{#each predictionRows as row}
						<div class="stats-trend-row">
							<div class="stats-trend-label">{row.label}</div>
							<div class="stats-trend-val">{row.value}</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<div class="stats-section">
			<h3 class="stats-section-title">
				Søvninfo for {formatAge(baby.birthdate)}
			</h3>
			<div class="sleep-info-panel">
				{#each sleepInfoRows.filter(r => !r.detail) as row}
					<div class="stats-trend-row">
						<div class="stats-trend-label">{row.label}</div>
						<div class="stats-trend-val">{row.value}</div>
					</div>
				{/each}
				{#if sleepInfoRows.some(r => r.detail)}
					<button
						class="btn btn-ghost"
						style="width: 100%; font-size: 0.8rem; padding: 4px 0; margin-top: 4px; color: var(--text-light);"
						onclick={() => (showSleepDetail = !showSleepDetail)}
					>
						{showSleepDetail ? 'Gøym vakevindauge ▲' : 'Vis vakevindauge ▼'}
					</button>
					{#if showSleepDetail}
						{#each sleepInfoRows.filter(r => r.detail) as row}
							<div class="stats-trend-row" style="font-size: 0.85rem; opacity: 0.85;">
								<div class="stats-trend-label">{row.label}</div>
								<div class="stats-trend-val">{row.value}</div>
							</div>
						{/each}
					{/if}
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
	{:else if activeStats}
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
		<!-- Chart A: 30-Day Stacked Area Trend -->
		{#if activeStats.stackedArea.nightPath}
			<div class="stats-section">
				<h3 class="stats-section-title">Søvntrend (30 dagar)</h3>
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="stats-chart-wrap" onclick={(e) => handleChartClick(e, 'Søvntrend')}>
					<svg viewBox="0 0 {TS_CHART.W} {TS_CHART.H}" width="100%" class="stats-chart">
						{#each activeStats.stackedArea.gridLines as y}
							<line x1={TS_CHART.PAD_L} x2={TS_CHART.W - TS_CHART.PAD_R} y1={y} y2={y} stroke="var(--cream-dark)" stroke-width="1" />
						{/each}
						{#each activeStats.stackedArea.yTicks as tick}
							<text x={TS_CHART.PAD_L - 4} y={tick.y + 4} text-anchor="end" fill="var(--text-light)" font-size="10" font-family="var(--font)">{tick.label}</text>
						{/each}
						<path d={activeStats.stackedArea.nightPath} fill="var(--moon)" opacity="0.7" />
						<path d={activeStats.stackedArea.napPath} fill="var(--peach-dark)" opacity="0.7" />
						{#if activeStats.stackedArea.rollingAvgPath}
							<path d={activeStats.stackedArea.rollingAvgPath} fill="none" stroke="var(--danger-dark, #c0392b)" stroke-width="2.5" stroke-linecap="round" opacity="0.8" />
						{/if}
						{#each activeStats.stackedArea.xLabels as lbl}
							<text x={lbl.x} y={TS_CHART.H - 6} text-anchor="middle" fill="var(--text-light)" font-size="10" font-family="var(--font)">{lbl.label}</text>
						{/each}
					</svg>
					<div class="stats-legend">
						<span class="stats-legend-item"><span class="stats-dot" style="background: var(--peach-dark)"></span> Lurar</span>
						<span class="stats-legend-item"><span class="stats-dot" style="background: var(--moon)"></span> Natt</span>
					</div>
				</div>
			</div>
		{/if}

		<!-- Chart B: Total Sleep vs Age Norms (hero chart) -->
		{#if activeStats.sleepVsNorm && activeStats.sleepVsNorm.actualPath}
			<div class="stats-section">
				<h3 class="stats-section-title">Total søvn vs. tilrådd</h3>
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="stats-chart-wrap" onclick={(e) => handleChartClick(e, 'Total søvn vs. tilrådd')}>
					<svg viewBox="0 0 {TS_CHART.W} {TS_CHART.H}" width="100%" class="stats-chart">
						{#each activeStats.sleepVsNorm.gridLines as y}
							<line x1={TS_CHART.PAD_L} x2={TS_CHART.W - TS_CHART.PAD_R} y1={y} y2={y} stroke="var(--cream-dark)" stroke-width="1" />
						{/each}
						{#each activeStats.sleepVsNorm.yTicks as tick}
							<text x={TS_CHART.PAD_L - 4} y={tick.y + 4} text-anchor="end" fill="var(--text-light)" font-size="10" font-family="var(--font)">{tick.label}</text>
						{/each}
						<!-- Norm band (recommended range) -->
						<path d={activeStats.sleepVsNorm.bandPath} fill="var(--lavender)" opacity="0.35" />
						<!-- Typical line (center of range) -->
						<path d={activeStats.sleepVsNorm.typicalPath} fill="none" stroke="var(--lavender-dark)" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.7" />
						<text x={TS_CHART.W - TS_CHART.PAD_R - 2} y={(activeStats.sleepVsNorm.yTicks[0]?.y ?? TS_CHART.PAD_T) + 14} text-anchor="end" fill="var(--lavender-dark)" font-size="9" font-family="var(--font)" opacity="0.7">tilrådd</text>
						<!-- Actual sleep area -->
						<path d={activeStats.sleepVsNorm.actualPath} fill="var(--moon)" opacity="0.6" />
						<!-- Data line (no dots — clean design) -->
						{#each activeStats.sleepVsNorm.xLabels as lbl}
							<text x={lbl.x} y={TS_CHART.H - 6} text-anchor="middle" fill="var(--text-light)" font-size="10" font-family="var(--font)">{lbl.label}</text>
						{/each}
					</svg>
					<div class="stats-legend">
						<span class="stats-legend-item"><span class="stats-dot" style="background: var(--moon)"></span> Faktisk søvn</span>
						<span class="stats-legend-item"><span class="stats-dot" style="background: var(--moon-glow)"></span> Tilrådd</span>
					</div>
				</div>
			</div>
		{/if}

		<!-- Chart C: Night Stretch Growth -->
		{#if activeStats.nightStretchChart.linePath}
			<div class="stats-section">
				<h3 class="stats-section-title">Lengste nattestrekk</h3>
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="stats-chart-wrap" onclick={(e) => handleChartClick(e, 'Lengste nattestrekk')}>
					<svg viewBox="0 0 {TS_CHART.W} {TS_CHART.H}" width="100%" class="stats-chart">
						{#each activeStats.nightStretchChart.gridLines as y}
							<line x1={TS_CHART.PAD_L} x2={TS_CHART.W - TS_CHART.PAD_R} y1={y} y2={y} stroke="var(--cream-dark)" stroke-width="1" />
						{/each}
						{#each activeStats.nightStretchChart.yTicks as tick}
							<text x={TS_CHART.PAD_L - 4} y={tick.y + 4} text-anchor="end" fill="var(--text-light)" font-size="10" font-family="var(--font)">{tick.label}</text>
						{/each}
						<!-- Area fill -->
						<path d={activeStats.nightStretchChart.areaPath} fill="var(--moon-glow)" opacity="0.3" />
						<!-- Rolling average -->
						{#if activeStats.nightStretchChart.rollingAvgPath}
							<path d={activeStats.nightStretchChart.rollingAvgPath} fill="none" stroke="var(--danger-dark, #c0392b)" stroke-width="2.5" stroke-linecap="round" opacity="0.8" />
						{/if}
						<!-- Line -->
						<path d={activeStats.nightStretchChart.linePath} fill="none" stroke="var(--moon)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
						<!-- No dots — clean lines only -->
						{#each activeStats.nightStretchChart.xLabels as lbl}
							<text x={lbl.x} y={TS_CHART.H - 6} text-anchor="middle" fill="var(--text-light)" font-size="10" font-family="var(--font)">{lbl.label}</text>
						{/each}
					</svg>
				</div>
			</div>
		{/if}

		<!-- Chart: Bedtime Consistency -->
		{#if activeStats.bedtimeChart.linePath}
			<div class="stats-section">
				<h3 class="stats-section-title">Leggetid</h3>
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="stats-chart-wrap" onclick={(e) => handleChartClick(e, 'Leggetid')}>
					<svg viewBox="0 0 {TS_CHART.W} {TS_CHART.H}" width="100%" class="stats-chart">
						{#each activeStats.bedtimeChart.gridLines as y}
							<line x1={TS_CHART.PAD_L} x2={TS_CHART.W - TS_CHART.PAD_R} y1={y} y2={y} stroke="var(--cream-dark)" stroke-width="1" />
						{/each}
						{#each activeStats.bedtimeChart.yTicks as tick}
							<text x={TS_CHART.PAD_L - 4} y={tick.y + 4} text-anchor="end" fill="var(--text-light)" font-size="10" font-family="var(--font)">{tick.label}</text>
						{/each}
						<!-- Average line -->
						<line x1={TS_CHART.PAD_L} x2={TS_CHART.W - TS_CHART.PAD_R} y1={activeStats.bedtimeChart.avgY} y2={activeStats.bedtimeChart.avgY} stroke="var(--lavender-dark)" stroke-width="1" stroke-dasharray="4,3" />
						<text x={TS_CHART.W - TS_CHART.PAD_R} y={activeStats.bedtimeChart.avgY - 4} text-anchor="end" fill="var(--lavender-dark)" font-size="10" font-family="var(--font)">snitt {activeStats.bedtimeChart.avgLabel}</text>
						<!-- Line -->
						<path d={activeStats.bedtimeChart.linePath} fill="none" stroke="var(--moon)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
						<!-- Dots -->
						<!-- No dots — clean lines only -->
						{#each activeStats.bedtimeChart.xLabels as lbl}
							<text x={lbl.x} y={TS_CHART.H - 6} text-anchor="middle" fill="var(--text-light)" font-size="10" font-family="var(--font)">{lbl.label}</text>
						{/each}
					</svg>
				</div>
			</div>
		{/if}

		<!-- Nap Count Trend -->
		{#if activeStats.napCountChart.linePath}
			<div class="stats-section">
				<h3 class="stats-section-title">Lurar per dag</h3>
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="stats-chart-wrap" onclick={(e) => handleChartClick(e, 'Lurar per dag')}>
					<svg viewBox="0 0 {TS_CHART.W} {TS_CHART.H}" width="100%" class="stats-chart">
						{#each activeStats.napCountChart.gridLines as y}
							<line x1={TS_CHART.PAD_L} x2={TS_CHART.W - TS_CHART.PAD_R} y1={y} y2={y} stroke="var(--cream-dark)" stroke-width="1" />
						{/each}
						{#each activeStats.napCountChart.yTicks as tick}
							<text x={TS_CHART.PAD_L - 4} y={tick.y + 4} text-anchor="end" fill="var(--text-light)" font-size="10" font-family="var(--font)">{tick.label}</text>
						{/each}
						{#if activeStats.napCountChart.rollingAvgPath}
							<path d={activeStats.napCountChart.rollingAvgPath} fill="none" stroke="var(--danger-dark, #c0392b)" stroke-width="2.5" stroke-linecap="round" opacity="0.8" />
						{/if}
						<path d={activeStats.napCountChart.linePath} fill="none" stroke="var(--peach-dark)" stroke-width="2.5" stroke-linecap="round" />
						<!-- No dots — clean lines only -->
						{#each activeStats.napCountChart.xLabels as lbl}
							<text x={lbl.x} y={TS_CHART.H - 6} text-anchor="middle" fill="var(--text-light)" font-size="10" font-family="var(--font)">{lbl.label}</text>
						{/each}
					</svg>
				</div>
			</div>
		{/if}

		<!-- Sleep pressure chart -->
		{#if activeStats.pressureChart.curves.length > 0}
			<div class="stats-section">
				<h3 class="stats-section-title">Søvntrykk gjennom dagen</h3>
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="stats-chart-wrap" onclick={(e) => handleChartClick(e, 'Søvntrykk')}>
					<svg viewBox="0 0 {TS_CHART.W} {TS_CHART.H}" width="100%" class="stats-chart">
						{#each activeStats.pressureChart.gridLines as y}
							<line x1={TS_CHART.PAD_L} x2={TS_CHART.W - TS_CHART.PAD_R} y1={y} y2={y} stroke="var(--cream-dark)" stroke-width="1" />
						{/each}
						{#each activeStats.pressureChart.yTicks as tick}
							<text x={TS_CHART.PAD_L - 4} y={tick.y + 4} text-anchor="end" fill="var(--text-light)" font-size="10" font-family="var(--font)">{tick.label}</text>
						{/each}
						<!-- Individual day curves (translucent) -->
						{#each activeStats.pressureChart.curves as curve, i}
							<!-- Nap bands -->
							{#each curve.sleepBands as band}
								<rect x={band.x1} y={TS_CHART.PAD_T} width={band.x2 - band.x1} height={TS_CHART.H - TS_CHART.PAD_T - TS_CHART.PAD_B} fill="var(--lavender)" opacity="0.15" />
							{/each}
							<path d={curve.areaPath} fill="var(--peach-dark)" opacity={0.08} />
							<path d={curve.linePath} fill="none" stroke="var(--peach-dark)" stroke-width="1.5" stroke-linecap="round" opacity={0.3} />
						{/each}
						<!-- Average curve (bold) -->
						{#if activeStats.pressureChart.avgLinePath}
							<path d={activeStats.pressureChart.avgLinePath} fill="none" stroke="var(--peach-dark)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
						{/if}
						{#each activeStats.pressureChart.xLabels as lbl}
							<text x={lbl.x} y={TS_CHART.H - 6} text-anchor="middle" fill="var(--text-light)" font-size="10" font-family="var(--font)">{lbl.label}</text>
						{/each}
					</svg>
				</div>
			</div>
		{/if}

		<!-- Wake windows (merged into the scatter replacement below) -->

		<!-- Sleep trends 7d vs 30d -->
		<div class="stats-section">
			<h3 class="stats-section-title">Søvntrendar</h3>
			<div class="stats-trends-table">
				{#each activeStats.trendRows as row}
					<div class="stats-trend-row" class:stats-trend-header={row.isHeader}>
						<div class="stats-trend-label">{row.label}</div>
						<div class="stats-trend-val">{row.val7}</div>
						<div class="stats-trend-val">{row.val30}</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- Best/worst days -->
		{#if activeStats.bestWorst}
			<div class="stats-section">
				<h3 class="stats-section-title">Best og verst</h3>
				<div class="stats-row">
					<div class="stats-card">
						<div class="stat-value">{activeStats.bestWorst.best.label}</div>
						<div class="stat-label">Mest søvn: {activeStats.bestWorst.best.duration}</div>
					</div>
					<div class="stats-card">
						<div class="stat-value">{activeStats.bestWorst.worst.label}</div>
						<div class="stat-label">Minst søvn: {activeStats.bestWorst.worst.duration}</div>
					</div>
				</div>
			</div>
		{/if}

		<!-- Diaper stats -->
		{#if activeStats.diaperStats7}
			<div class="stats-section">
				<h3 class="stats-section-title">Bleie/Do</h3>
				<div class="stats-row">
					<div class="stats-card">
						<div class="stat-value">{activeStats.diaperStats7.perDay}</div>
						<div class="stat-label">Bleier/dag (7d)</div>
					</div>
					<div class="stats-card">
						<div class="stat-value">{activeStats.diaperStats7.wetCount}/{activeStats.diaperStats7.dirtyCount}/{activeStats.diaperStats7.bothCount}</div>
						<div class="stat-label">{pottyMode ? 'Tiss/Bæsj/Begge' : 'Våt/Skitten/Begge'}</div>
					</div>
					{#if activeStats.diaperStats30 && activeStats.diaperStats30.pottyCount > 0 && activeStats.diaperStats30.pottySuccessRate != null}
						<div class="stats-card">
							<div class="stat-value">{activeStats.diaperStats30.pottySuccessRate}%</div>
							<div class="stat-label">Suksessrate do</div>
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<!-- Tier 2: Additional charts -->
			<!-- Chart D: Sleep Timeline (Gantt) -->
			{#if activeStats.gantt.rows.length > 0}
				<div class="stats-section">
					<h3 class="stats-section-title">Døgnrytme (30 dagar)</h3>
					<div class="stats-chart-wrap" style="overflow-x: auto;">
						<svg viewBox="0 0 {GANTT.W} {activeStats.gantt.height}" width="100%" class="stats-chart" shape-rendering="crispEdges">
							<!-- Hour labels -->
							{#each activeStats.gantt.hourLabels as lbl}
								<text x={lbl.x} y={14} text-anchor="middle" fill="var(--text-light)" font-size="10" font-family="var(--font)" shape-rendering="auto">{lbl.label}</text>
							{/each}
							<!-- Rows -->
							{#each activeStats.gantt.rows as row}
								<!-- Date label -->
								<text x={GANTT.PAD_L - 4} y={row.y + GANTT.ROW_H / 2 + 3} text-anchor="end" fill="var(--text-light)" font-size="10" font-family="var(--font)" shape-rendering="auto">{row.dateLabel}</text>
								<!-- Row background -->
								<rect x={GANTT.PAD_L} y={row.y} width={GANTT.W - GANTT.PAD_L - GANTT.PAD_R} height={GANTT.ROW_H - 2} fill="var(--cream-dark)" opacity="0.3" />
								<!-- Sleep blocks -->
								{#each row.blocks as block}
									<rect
										x={block.x}
										y={block.y}
										width={block.w}
										height={GANTT.ROW_H - 6}
										fill={block.type === 'nap' ? 'var(--peach-dark)' : 'var(--moon)'}
									/>
								{/each}
							{/each}
						</svg>
						<div class="stats-legend">
							<span class="stats-legend-item"><span class="stats-dot" style="background: var(--peach-dark)"></span> Lurar</span>
							<span class="stats-legend-item"><span class="stats-dot" style="background: var(--moon)"></span> Natt</span>
						</div>
					</div>
				</div>
			{/if}

			<!-- Chart E: 24h Sleep Heatmap -->
			{#if activeStats.heatmapChart.cells.length > 0}
				{@const hm = activeStats.heatmapChart}
				<div class="stats-section">
					<h3 class="stats-section-title">Søvnkart</h3>
					<div class="stats-chart-wrap" style="overflow-y: auto; max-height: 70vh;">
						<svg viewBox="0 0 {hm.width} {hm.height}" width="100%" class="stats-chart" shape-rendering="crispEdges" style="height: {hm.height}px; width: 100%;">
							{#each hm.hourLabels as lbl}
								<text x={lbl.x} y={12} text-anchor="middle" fill="var(--text-light)" font-size="9" font-family="var(--font)" shape-rendering="auto">{lbl.label}</text>
							{/each}
							{#each hm.dateLabels as lbl}
								<text x={lbl.x} y={lbl.y} text-anchor="end" fill="var(--text-light)" font-size="8" font-family="var(--font)" shape-rendering="auto">{lbl.label}</text>
							{/each}
							{#each hm.cells as cell}
								<rect
									x={cell.x}
									y={cell.y}
									width={cell.w}
									height={cell.h}
									fill="var(--moon)"
									opacity={Math.max(0.05, cell.opacity)}
								/>
							{/each}
						</svg>
					</div>
				</div>
			{/if}

			<!-- Wake window chart with context -->
			{#if activeStats.wakeScatter.dots.length > 0}
				<div class="stats-section">
					<h3 class="stats-section-title">Vakevindu siste 7 dagar</h3>
					<div class="stats-row" style="margin-bottom: 12px;">
						<div class="stats-card">
							<div class="stat-value">{activeStats.wakeAvg ? formatDuration(activeStats.wakeAvg * 60000) : '—'}</div>
							<div class="stat-label">Snitt</div>
						</div>
						<div class="stats-card">
							<div class="stat-value">{formatDuration(Math.min(...activeStats.wakeScatter.dots.map(d => d.minutes)) * 60000)}</div>
							<div class="stat-label">Kortast</div>
						</div>
						<div class="stats-card">
							<div class="stat-value">{formatDuration(Math.max(...activeStats.wakeScatter.dots.map(d => d.minutes)) * 60000)}</div>
							<div class="stat-label">Lengst</div>
						</div>
					</div>
					<p style="font-size: 0.8rem; color: var(--text-light); margin: 0 0 8px; line-height: 1.3;">
						Kvart punkt er eitt vakevindu — tida mellom to søvnperiodar.
						Fyrste vakevindu (etter morgon) er ofte kortast, siste (før leggetid) er lengst.
						{#if activeStats.wakeScatter.bandY}
							Det skraverte feltet viser tilrådd område.
						{/if}
					</p>
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class="stats-chart-wrap" onclick={(e) => handleChartClick(e, 'Vakevindu')}>
						<svg viewBox="0 0 {TS_CHART.W} {TS_CHART.H}" width="100%" class="stats-chart">
							{#each activeStats.wakeScatter.gridLines as y}
								<line x1={TS_CHART.PAD_L} x2={TS_CHART.W - TS_CHART.PAD_R} y1={y} y2={y} stroke="var(--cream-dark)" stroke-width="1" />
							{/each}
							{#each activeStats.wakeScatter.yTicks as tick}
								<text x={TS_CHART.PAD_L - 4} y={tick.y + 4} text-anchor="end" fill="var(--text-light)" font-size="10" font-family="var(--font)">{tick.label}</text>
							{/each}
							{#if activeStats.wakeScatter.bandY}
								<rect
									x={TS_CHART.PAD_L}
									y={activeStats.wakeScatter.bandY.top}
									width={TS_CHART.W - TS_CHART.PAD_L - TS_CHART.PAD_R}
									height={activeStats.wakeScatter.bandY.bottom - activeStats.wakeScatter.bandY.top}
									fill="var(--lavender)"
									opacity="0.25"
									rx="4"
								/>
							{/if}
							{#each activeStats.wakeScatter.dots as dot, i}
								<circle cx={dot.x} cy={dot.y} r="5" fill="var(--peach-dark)" stroke="var(--white)" stroke-width="1" opacity="0.7" />
								<text x={dot.x} y={dot.y - 8} text-anchor="middle" fill="var(--text-light)" font-size="8" font-family="var(--font)">{formatDuration(dot.minutes * 60000)}</text>
							{/each}
						</svg>
					</div>
				</div>
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
{#if fullscreenSvg}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="chart-fullscreen-overlay" onclick={(e) => { if (e.target === e.currentTarget) closeFullscreen(); }} onkeydown={(e) => { if (e.key === 'Escape') closeFullscreen(); }} tabindex="-1">
		<div class="chart-fullscreen-header">
			<span>{fullscreenTitle}</span>
			<button class="btn btn-ghost" onclick={closeFullscreen} style="color: var(--text); padding: 4px 12px; min-height: 0;">✕</button>
		</div>
		<div class="chart-fullscreen-body">
			{@html fullscreenSvg}
		</div>
	</div>
{/if}

<style>
	.chart-fullscreen-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: var(--cream);
		z-index: 1000;
		display: flex;
		flex-direction: column;
		padding: 16px;
	}

	.chart-fullscreen-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-weight: 600;
		font-size: 0.9rem;
		margin-bottom: 16px;
	}

	.chart-fullscreen-body {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.chart-fullscreen-body :global(svg) {
		width: 100%;
		height: auto;
		max-height: 80vh;
	}

	.stats-chart-wrap {
		cursor: pointer;
	}
</style>
