<script lang="ts">
	import { formatDuration } from '$lib/utils.js';
	import {
		TS_CHART,
		GANTT,
		fetchStatsData,
		fetchFullHistory,
		computeAllStats,
		buildHeatmapChart,
		type ComputedStats,
		type HeatmapChartData,
	} from '$lib/stats-view-utils.js';
	import { buildSleepHeatmap } from '$lib/engine/stats.js';
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
	let error = $state(false);
	let empty = $state(false);
	let stats = $state<ComputedStats | null>(null);
	let showAdvanced = $state(typeof localStorage !== 'undefined' && localStorage.getItem('stats_advanced') === '1');
	let fullHeatmap = $state<HeatmapChartData | null>(null);
	let loadingFullHeatmap = $state(false);

	function toggleAdvanced() {
		showAdvanced = !showAdvanced;
		localStorage.setItem('stats_advanced', showAdvanced ? '1' : '0');
	}

	async function loadFullHeatmap() {
		loadingFullHeatmap = true;
		try {
			const allSleeps = await fetchFullHistory();
			const heatmapRows = buildSleepHeatmap(allSleeps, baby?.timezone ?? undefined);
			fullHeatmap = buildHeatmapChart(heatmapRows, heatmapRows.length);
		} finally {
			loadingFullHeatmap = false;
		}
	}

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

	<!-- Sleep info for age + predictions -->
	{#if baby}
		<div class="stats-section">
			<h3 class="stats-section-title">
				Søvninfo for {formatAge(baby.birthdate)}
			</h3>
			<div class="sleep-info-panel">
				{#each sleepInfoRows as row}
					<div class="stats-trend-row">
						<div class="stats-trend-label">{row.label}</div>
						<div class="stats-trend-val">{row.value}</div>
					</div>
				{/each}

				{#if nextMilestone}
					<div
						style="margin-top: 12px; padding: 12px; background: var(--lavender); border-radius: var(--radius-sm); font-size: 0.85rem;"
					>
						<div style="font-weight: 600; margin-bottom: 4px;">Kva som kjem</div>
						<div style="color: var(--text-light);">{nextMilestone}</div>
					</div>
				{/if}
			</div>

			{#if predictionRows.length > 0}
				<div
					data-testid="pred-panel"
					style="margin-top: 16px; padding: 12px; background: var(--lavender); border-radius: var(--radius-sm);"
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
	{:else if stats}
		<!-- Chart A: 30-Day Stacked Area Trend -->
		{#if stats.stackedArea.nightPath}
			<div class="stats-section">
				<h3 class="stats-section-title">Søvntrend (30 dagar)</h3>
				<div class="stats-chart-wrap">
					<svg viewBox="0 0 {TS_CHART.W} {TS_CHART.H}" width="100%" class="stats-chart">
						{#each stats.stackedArea.gridLines as y}
							<line x1={TS_CHART.PAD_L} x2={TS_CHART.W - TS_CHART.PAD_R} y1={y} y2={y} stroke="var(--cream-dark)" stroke-width="1" />
						{/each}
						{#each stats.stackedArea.yTicks as tick}
							<text x={TS_CHART.PAD_L - 4} y={tick.y + 4} text-anchor="end" fill="var(--text-light)" font-size="10" font-family="var(--font)">{tick.label}</text>
						{/each}
						<path d={stats.stackedArea.nightPath} fill="var(--moon)" opacity="0.7" />
						<path d={stats.stackedArea.napPath} fill="var(--peach-dark)" opacity="0.7" />
						{#if stats.stackedArea.rollingAvgPath}
							<path d={stats.stackedArea.rollingAvgPath} fill="none" stroke="var(--text)" stroke-width="1.5" stroke-dasharray="4,2" opacity="0.6" />
						{/if}
						{#each stats.stackedArea.xLabels as lbl}
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
		{#if stats.sleepVsNorm && stats.sleepVsNorm.actualPath}
			<div class="stats-section">
				<h3 class="stats-section-title">Total søvn vs. anbefalt</h3>
				<div class="stats-chart-wrap">
					<svg viewBox="0 0 {TS_CHART.W} {TS_CHART.H}" width="100%" class="stats-chart">
						{#each stats.sleepVsNorm.gridLines as y}
							<line x1={TS_CHART.PAD_L} x2={TS_CHART.W - TS_CHART.PAD_R} y1={y} y2={y} stroke="var(--cream-dark)" stroke-width="1" />
						{/each}
						{#each stats.sleepVsNorm.yTicks as tick}
							<text x={TS_CHART.PAD_L - 4} y={tick.y + 4} text-anchor="end" fill="var(--text-light)" font-size="10" font-family="var(--font)">{tick.label}</text>
						{/each}
						<!-- Galland norm band -->
						<path d={stats.sleepVsNorm.bandPath} fill="var(--lavender)" opacity="0.4" />
						<!-- Typical line -->
						<path d={stats.sleepVsNorm.typicalPath} fill="none" stroke="var(--lavender-dark)" stroke-width="1" stroke-dasharray="4,3" />
						<!-- Actual sleep area -->
						<path d={stats.sleepVsNorm.actualPath} fill="var(--moon)" opacity="0.6" />
						<!-- Dots -->
						{#each stats.sleepVsNorm.dots as dot}
							<circle cx={dot.x} cy={dot.y} r="2.5" fill="var(--moon)" stroke="var(--white)" stroke-width="0.5" />
						{/each}
						{#each stats.sleepVsNorm.xLabels as lbl}
							<text x={lbl.x} y={TS_CHART.H - 6} text-anchor="middle" fill="var(--text-light)" font-size="10" font-family="var(--font)">{lbl.label}</text>
						{/each}
					</svg>
					<div class="stats-legend">
						<span class="stats-legend-item"><span class="stats-dot" style="background: var(--moon)"></span> Faktisk søvn</span>
						<span class="stats-legend-item"><span class="stats-dot" style="background: var(--lavender)"></span> Anbefalt</span>
					</div>
				</div>
			</div>
		{/if}

		<!-- Chart C: Night Stretch Growth -->
		{#if stats.nightStretchChart.linePath}
			<div class="stats-section">
				<h3 class="stats-section-title">Lengste nattestrekk</h3>
				<div class="stats-chart-wrap">
					<svg viewBox="0 0 {TS_CHART.W} {TS_CHART.H}" width="100%" class="stats-chart">
						{#each stats.nightStretchChart.gridLines as y}
							<line x1={TS_CHART.PAD_L} x2={TS_CHART.W - TS_CHART.PAD_R} y1={y} y2={y} stroke="var(--cream-dark)" stroke-width="1" />
						{/each}
						{#each stats.nightStretchChart.yTicks as tick}
							<text x={TS_CHART.PAD_L - 4} y={tick.y + 4} text-anchor="end" fill="var(--text-light)" font-size="10" font-family="var(--font)">{tick.label}</text>
						{/each}
						<!-- Area fill -->
						<path d={stats.nightStretchChart.areaPath} fill="var(--moon-glow)" opacity="0.3" />
						<!-- Rolling average -->
						{#if stats.nightStretchChart.rollingAvgPath}
							<path d={stats.nightStretchChart.rollingAvgPath} fill="none" stroke="var(--text)" stroke-width="1.5" stroke-dasharray="4,2" opacity="0.5" />
						{/if}
						<!-- Line -->
						<path d={stats.nightStretchChart.linePath} fill="none" stroke="var(--moon)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
						<!-- Dots -->
						{#each stats.nightStretchChart.dots as dot}
							<circle cx={dot.x} cy={dot.y} r="3" fill="var(--moon)" stroke="var(--white)" stroke-width="1" />
						{/each}
						{#each stats.nightStretchChart.xLabels as lbl}
							<text x={lbl.x} y={TS_CHART.H - 6} text-anchor="middle" fill="var(--text-light)" font-size="10" font-family="var(--font)">{lbl.label}</text>
						{/each}
					</svg>
				</div>
			</div>
		{/if}

		<!-- Chart: Bedtime Consistency -->
		{#if stats.bedtimeChart.linePath}
			<div class="stats-section">
				<h3 class="stats-section-title">Leggetid</h3>
				<div class="stats-chart-wrap">
					<svg viewBox="0 0 {TS_CHART.W} {TS_CHART.H}" width="100%" class="stats-chart">
						{#each stats.bedtimeChart.gridLines as y}
							<line x1={TS_CHART.PAD_L} x2={TS_CHART.W - TS_CHART.PAD_R} y1={y} y2={y} stroke="var(--cream-dark)" stroke-width="1" />
						{/each}
						{#each stats.bedtimeChart.yTicks as tick}
							<text x={TS_CHART.PAD_L - 4} y={tick.y + 4} text-anchor="end" fill="var(--text-light)" font-size="10" font-family="var(--font)">{tick.label}</text>
						{/each}
						<!-- Average line -->
						<line x1={TS_CHART.PAD_L} x2={TS_CHART.W - TS_CHART.PAD_R} y1={stats.bedtimeChart.avgY} y2={stats.bedtimeChart.avgY} stroke="var(--lavender-dark)" stroke-width="1" stroke-dasharray="4,3" />
						<text x={TS_CHART.W - TS_CHART.PAD_R} y={stats.bedtimeChart.avgY - 4} text-anchor="end" fill="var(--lavender-dark)" font-size="10" font-family="var(--font)">snitt {stats.bedtimeChart.avgLabel}</text>
						<!-- Line -->
						<path d={stats.bedtimeChart.linePath} fill="none" stroke="var(--moon)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
						<!-- Dots -->
						{#each stats.bedtimeChart.dots as dot}
							<circle cx={dot.x} cy={dot.y} r="3" fill="var(--moon)" stroke="var(--white)" stroke-width="1" />
						{/each}
						{#each stats.bedtimeChart.xLabels as lbl}
							<text x={lbl.x} y={TS_CHART.H - 6} text-anchor="middle" fill="var(--text-light)" font-size="10" font-family="var(--font)">{lbl.label}</text>
						{/each}
					</svg>
				</div>
			</div>
		{/if}

		<!-- Nap Count Trend -->
		{#if stats.napCountChart.linePath}
			<div class="stats-section">
				<h3 class="stats-section-title">Lurar per dag</h3>
				<div class="stats-chart-wrap">
					<svg viewBox="0 0 {TS_CHART.W} {TS_CHART.H}" width="100%" class="stats-chart">
						{#each stats.napCountChart.gridLines as y}
							<line x1={TS_CHART.PAD_L} x2={TS_CHART.W - TS_CHART.PAD_R} y1={y} y2={y} stroke="var(--cream-dark)" stroke-width="1" />
						{/each}
						{#each stats.napCountChart.yTicks as tick}
							<text x={TS_CHART.PAD_L - 4} y={tick.y + 4} text-anchor="end" fill="var(--text-light)" font-size="10" font-family="var(--font)">{tick.label}</text>
						{/each}
						{#if stats.napCountChart.rollingAvgPath}
							<path d={stats.napCountChart.rollingAvgPath} fill="none" stroke="var(--text)" stroke-width="1.5" stroke-dasharray="4,2" opacity="0.5" />
						{/if}
						<path d={stats.napCountChart.linePath} fill="none" stroke="var(--peach-dark)" stroke-width="2" stroke-linecap="round" />
						{#each stats.napCountChart.dots as dot}
							<circle cx={dot.x} cy={dot.y} r="3" fill="var(--peach-dark)" stroke="var(--white)" stroke-width="1" />
						{/each}
						{#each stats.napCountChart.xLabels as lbl}
							<text x={lbl.x} y={TS_CHART.H - 6} text-anchor="middle" fill="var(--text-light)" font-size="10" font-family="var(--font)">{lbl.label}</text>
						{/each}
					</svg>
				</div>
			</div>
		{/if}

		<!-- Wake windows -->
		<div class="stats-section">
			<h3 class="stats-section-title">Vakevindu</h3>
			<div class="stats-row">
				<div class="stats-card">
					<div class="stat-value">{stats.wakeAvg ? formatDuration(stats.wakeAvg * 60000) : '—'}</div>
					<div class="stat-label">Snitt vakevindu</div>
				</div>
			</div>
		</div>

		<!-- Sleep trends 7d vs 30d -->
		<div class="stats-section">
			<h3 class="stats-section-title">Søvntrendar</h3>
			<div class="stats-trends-table">
				{#each stats.trendRows as row}
					<div class="stats-trend-row" class:stats-trend-header={row.isHeader}>
						<div class="stats-trend-label">{row.label}</div>
						<div class="stats-trend-val">{row.val7}</div>
						<div class="stats-trend-val">{row.val30}</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- Best/worst days -->
		{#if stats.bestWorst}
			<div class="stats-section">
				<h3 class="stats-section-title">Best og verst</h3>
				<div class="stats-row">
					<div class="stats-card">
						<div class="stat-value">{stats.bestWorst.best.label}</div>
						<div class="stat-label">Mest søvn: {stats.bestWorst.best.duration}</div>
					</div>
					<div class="stats-card">
						<div class="stat-value">{stats.bestWorst.worst.label}</div>
						<div class="stat-label">Minst søvn: {stats.bestWorst.worst.duration}</div>
					</div>
				</div>
			</div>
		{/if}

		<!-- Diaper stats -->
		{#if stats.diaperStats7}
			<div class="stats-section">
				<h3 class="stats-section-title">Bleie/Do</h3>
				<div class="stats-row">
					<div class="stats-card">
						<div class="stat-value">{stats.diaperStats7.perDay}</div>
						<div class="stat-label">Bleier/dag (7d)</div>
					</div>
					<div class="stats-card">
						<div class="stat-value">{stats.diaperStats7.wetCount}/{stats.diaperStats7.dirtyCount}/{stats.diaperStats7.bothCount}</div>
						<div class="stat-label">{pottyMode ? 'Tiss/Bæsj/Begge' : 'Våt/Skitten/Begge'}</div>
					</div>
					{#if stats.diaperStats30 && stats.diaperStats30.pottyCount > 0 && stats.diaperStats30.pottySuccessRate != null}
						<div class="stats-card">
							<div class="stat-value">{stats.diaperStats30.pottySuccessRate}%</div>
							<div class="stat-label">Suksessrate do</div>
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<!-- Advanced toggle -->
		<div class="stats-section" style="text-align: center;">
			<button
				class="btn btn-ghost"
				style="font-size: 0.85rem; color: var(--text-light);"
				onclick={toggleAdvanced}
			>
				{showAdvanced ? 'Gøym fleire diagram' : 'Vis fleire diagram'}
			</button>
		</div>

		<!-- Tier 2: Advanced charts -->
		{#if showAdvanced}
			<!-- Chart D: Sleep Timeline (Gantt) -->
			{#if stats.gantt.rows.length > 0}
				<div class="stats-section">
					<h3 class="stats-section-title">Døgnrytme (14 dagar)</h3>
					<div class="stats-chart-wrap" style="overflow-x: auto;">
						<svg viewBox="0 0 {GANTT.W} {stats.gantt.height}" width="100%" class="stats-chart" shape-rendering="crispEdges">
							<!-- Hour labels -->
							{#each stats.gantt.hourLabels as lbl}
								<text x={lbl.x} y={14} text-anchor="middle" fill="var(--text-light)" font-size="10" font-family="var(--font)" shape-rendering="auto">{lbl.label}</text>
							{/each}
							<!-- Rows -->
							{#each stats.gantt.rows as row}
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
			{@const hm = fullHeatmap ?? stats.heatmapChart}
			{#if hm.cells.length > 0}
				<div class="stats-section">
					<h3 class="stats-section-title">
						Søvnkart {fullHeatmap ? '(all data)' : '(14 dagar)'}
					</h3>
					<div class="stats-chart-wrap" style="overflow-y: auto; max-height: {fullHeatmap ? '70vh' : 'none'};">
						<svg viewBox="0 0 {hm.width} {hm.height}" width="100%" class="stats-chart" shape-rendering="crispEdges" style={fullHeatmap ? `height: ${hm.height}px; width: 100%;` : ''}>
							<!-- Hour labels -->
							{#each hm.hourLabels as lbl}
								<text x={lbl.x} y={12} text-anchor="middle" fill="var(--text-light)" font-size="9" font-family="var(--font)" shape-rendering="auto">{lbl.label}</text>
							{/each}
							<!-- Date labels -->
							{#each hm.dateLabels as lbl}
								<text x={lbl.x} y={lbl.y} text-anchor="end" fill="var(--text-light)" font-size="8" font-family="var(--font)" shape-rendering="auto">{lbl.label}</text>
							{/each}
							<!-- Cells -->
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
					{#if !fullHeatmap}
						<button
							class="btn btn-ghost"
							style="margin-top: 8px; font-size: 0.8rem; color: var(--text-light);"
							onclick={loadFullHeatmap}
							disabled={loadingFullHeatmap}
						>
							{loadingFullHeatmap ? 'Lastar...' : 'Vis heile historia'}
						</button>
					{/if}
				</div>
			{/if}

			<!-- Chart F: Wake Window Scatter -->
			{#if stats.wakeScatter.dots.length > 0}
				<div class="stats-section">
					<h3 class="stats-section-title">Vakevindu-spreiing (7 dagar)</h3>
					<div class="stats-chart-wrap">
						<svg viewBox="0 0 {TS_CHART.W} {TS_CHART.H}" width="100%" class="stats-chart">
							{#each stats.wakeScatter.gridLines as y}
								<line x1={TS_CHART.PAD_L} x2={TS_CHART.W - TS_CHART.PAD_R} y1={y} y2={y} stroke="var(--cream-dark)" stroke-width="1" />
							{/each}
							{#each stats.wakeScatter.yTicks as tick}
								<text x={TS_CHART.PAD_L - 4} y={tick.y + 4} text-anchor="end" fill="var(--text-light)" font-size="10" font-family="var(--font)">{tick.label}</text>
							{/each}
							<!-- Recommended range band -->
							{#if stats.wakeScatter.bandY}
								<rect
									x={TS_CHART.PAD_L}
									y={stats.wakeScatter.bandY.top}
									width={TS_CHART.W - TS_CHART.PAD_L - TS_CHART.PAD_R}
									height={stats.wakeScatter.bandY.bottom - stats.wakeScatter.bandY.top}
									fill="var(--lavender)"
									opacity="0.3"
									rx="4"
								/>
							{/if}
							<!-- Dots -->
							{#each stats.wakeScatter.dots as dot}
								<circle cx={dot.x} cy={dot.y} r="4" fill="var(--peach-dark)" stroke="var(--white)" stroke-width="1" opacity="0.8" />
							{/each}
						</svg>
					</div>
				</div>
			{/if}
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
