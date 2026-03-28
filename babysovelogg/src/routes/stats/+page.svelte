<script lang="ts">
	import { formatDuration } from '$lib/utils.js';
	import {
		CHART,
		fetchStatsData,
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
					serverPrediction: s.prediction,
					totalSleepMinutes:
						(s.stats?.totalNapMinutes ?? 0) + (s.stats?.totalNightMinutes ?? 0),
				})
			: [],
	);

	let loading = $state(true);
	let error = $state(false);
	let empty = $state(false);
	let stats = $state<ComputedStats | null>(null);

	async function load() {
		loading = true;
		error = false;
		try {
			const data = await fetchStatsData();
			if (data.sleeps.length === 0 && data.diapers.length === 0) {
				empty = true;
			} else {
				empty = false;
				stats = computeAllStats(data.sleeps, data.diapers);
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
		<!-- 1. Weekly bar chart -->
		<div class="stats-section">
			<h3 class="stats-section-title">Siste 7 dagar</h3>
			<div class="stats-chart-wrap">
				{#if stats.bars.length === 0}
					<svg viewBox="0 0 {CHART.W} {CHART.H}" width="100%" class="stats-chart">
						<text
							x={CHART.W / 2}
							y={CHART.H / 2}
							text-anchor="middle"
							fill="var(--text-light)"
							font-size="14"
						>
							Ingen data enno
						</text>
					</svg>
				{:else}
					<svg viewBox="0 0 {CHART.W} {CHART.H}" width="100%" class="stats-chart">
						<!-- Grid lines -->
						{#each stats.gridLines as y}
							<line
								x1={CHART.PAD_L}
								x2={CHART.W - CHART.PAD_R}
								y1={y}
								y2={y}
								stroke="var(--cream-dark)"
								stroke-width="1"
							/>
						{/each}

						<!-- Y-axis labels -->
						{#each stats.yTicks as tick}
							<text
								x={CHART.PAD_L - 4}
								y={tick.y + 4}
								text-anchor="end"
								fill="var(--text-light)"
								font-size="10"
								font-family="var(--font)"
							>
								{tick.label}
							</text>
						{/each}

						<!-- Bars -->
						{#each stats.barGeometries as g}
							<!-- Night bar (bottom) -->
							{#if g.nightH > 0}
								<rect
									x={g.x}
									y={g.baseY - g.napH - g.nightH}
									width={g.barW}
									height={g.nightH}
									rx="4"
									fill="var(--moon)"
								/>
							{/if}
							<!-- Nap bar (top of night) -->
							{#if g.napH > 0}
								<rect
									x={g.x}
									y={g.baseY - g.napH}
									width={g.barW}
									height={g.napH}
									rx="4"
									fill="var(--peach-dark)"
								/>
							{/if}
							<!-- Day label -->
							<text
								x={g.x + g.barW / 2}
								y={CHART.H - 6}
								text-anchor="middle"
								fill="var(--text-light)"
								font-size="10"
								font-family="var(--font)"
							>
								{g.bar.dayLabel}
							</text>
						{/each}
					</svg>
				{/if}

				<!-- Legend -->
				<div class="stats-legend">
					<span class="stats-legend-item">
						<span class="stats-dot" style="background: var(--peach-dark)"></span>
						Lurar
					</span>
					<span class="stats-legend-item">
						<span class="stats-dot" style="background: var(--moon)"></span>
						Natt
					</span>
				</div>
			</div>
		</div>

		<!-- 2. Wake windows -->
		<div class="stats-section">
			<h3 class="stats-section-title">Vakevindu</h3>
			<div class="stats-row">
				<div class="stats-card">
					<div class="stat-value">{stats.wakeAvg ? formatDuration(stats.wakeAvg * 60000) : '—'}</div>
					<div class="stat-label">Snitt vakevindu</div>
				</div>
			</div>
		</div>

		<!-- 3. Sleep trends 7d vs 30d -->
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

		<!-- 4. Best/worst days -->
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

		<!-- 5. Diaper stats -->
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
						<div class="stat-label">Våt/Skitten/Begge</div>
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

		<!-- 6. Export -->
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
