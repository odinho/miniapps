<script lang="ts">
	import type { SleepLogRow, DiaperLogRow } from '$lib/types.js';
	import { appState } from '$lib/stores/app.svelte.js';
	import { sync } from '$lib/stores/sync.svelte.js';
	import Arc from '$lib/components/Arc.svelte';
	import Timer from '$lib/components/Timer.svelte';
	import SleepButton from '$lib/components/SleepButton.svelte';
	import TagSheet from '$lib/components/TagSheet.svelte';
	import DiaperForm from '$lib/components/DiaperForm.svelte';
	import WakeUpSheet from '$lib/components/WakeUpSheet.svelte';
	import { formatDuration } from '$lib/utils.js';
	import { calcPauseMs } from '$lib/engine/classification.js';

	// --- modal state ---
	let showTagSheet = $state(false);
	let tagSheetSleepId = $state('');
	let tagSheetStartTime = $state('');

	let showWakeUpSheet = $state(false);
	let wakeUpSleepId = $state('');
	let wakeUpSnapshot = $state<SleepLogRow | null>(null);

	let showDiaperForm = $state(false);
	let diaperFromTagSheet = $state(false);

	// --- derived state from store ---
	const s = $derived(appState.state);
	const loaded = $derived(appState.loaded);
	const baby = $derived(s.baby);
	const activeSleep = $derived(s.activeSleep);
	const todaySleeps = $derived(s.todaySleeps);
	const prediction = $derived(s.prediction);
	const stats = $derived(s.stats);
	const ageMonths = $derived(s.ageMonths);
	const todayWakeUp = $derived(s.todayWakeUp);
	const pottyMode = $derived(baby?.potty_mode === 1);

	const isNightMode = $derived(() => {
		const h = new Date().getHours();
		return h < 6 || h >= 18;
	});

	// Adapt types for Arc.svelte which expects narrower types than AppState provides
	const arcSleeps = $derived(
		todaySleeps.map((s) => ({
			start_time: s.start_time,
			end_time: s.end_time,
			type: s.type as 'nap' | 'night',
		})),
	);
	const arcActiveSleep = $derived(
		activeSleep && !activeSleep.end_time
			? {
					start_time: activeSleep.start_time,
					type: activeSleep.type as 'nap' | 'night',
					isPaused: activeSleep.pauses?.some((p) => !p.resume_time) ?? false,
					pauseTime: activeSleep.pauses?.find((p) => !p.resume_time)?.pause_time,
				}
			: null,
	);
	const arcPrediction = $derived(
		prediction
			? {
					nextNap: prediction.nextNap,
					bedtime: prediction.bedtime,
					predictedNaps: prediction.predictedNaps ?? undefined,
				}
			: null,
	);

	// Synthesize a minimal DiaperLogRow array for TagSheet's diaper nudge check.
	// The nudge only needs the latest diaper time — we don't have the full array in state.
	const diaperStub = $derived<DiaperLogRow[]>(
		s.lastDiaperTime
			? [{ id: 0, baby_id: baby?.id ?? 0, time: s.lastDiaperTime, type: '', amount: null, note: null, deleted: 0, domain_id: '', created_by_event_id: null, updated_by_event_id: null }]
			: [],
	);

	// --- live stats (includes active sleep contribution) ---
	let now = $state(Date.now());
	$effect(() => {
		const ms = activeSleep ? 1000 : 60_000;
		const iv = setInterval(() => { now = Date.now(); }, ms);
		return () => clearInterval(iv);
	});

	const liveNapCount = $derived(() => {
		const base = stats?.napCount ?? 0;
		return base + (activeSleep?.type === 'nap' && !activeSleep.end_time ? 1 : 0);
	});

	const liveNapMs = $derived(() => {
		const base = (stats?.totalNapMinutes ?? 0) * 60_000;
		if (activeSleep?.type === 'nap' && !activeSleep.end_time) {
			const elapsed = now - new Date(activeSleep.start_time).getTime() - calcPauseMs(activeSleep.pauses ?? []);
			return base + Math.max(0, elapsed);
		}
		return base;
	});

	const liveTotalMs = $derived(() => {
		const napBase = (stats?.totalNapMinutes ?? 0) * 60_000;
		const nightBase = (stats?.totalNightMinutes ?? 0) * 60_000;
		let activeMs = 0;
		if (activeSleep && !activeSleep.end_time) {
			activeMs = Math.max(0, now - new Date(activeSleep.start_time).getTime() - calcPauseMs(activeSleep.pauses ?? []));
		}
		return napBase + nightBase + activeMs;
	});

	const showTotal = $derived(
		Math.round(liveTotalMs() / 60_000) !== Math.round(liveNapMs() / 60_000),
	);

	// --- callbacks ---
	function onSleepStarted(sleepDomainId: string, startTime: string) {
		tagSheetSleepId = sleepDomainId;
		tagSheetStartTime = startTime;
		showTagSheet = true;
	}

	function onSleepEnded(domainId: string, sleepSnapshot: SleepLogRow) {
		wakeUpSleepId = domainId;
		wakeUpSnapshot = sleepSnapshot;
		showWakeUpSheet = true;
	}

	function onTagSheetClose() {
		showTagSheet = false;
	}

	function onTagSheetOpenDiaper() {
		showTagSheet = false;
		diaperFromTagSheet = true;
		showDiaperForm = true;
	}

	function onWakeUpClose() {
		showWakeUpSheet = false;
	}

	function onDiaperClose() {
		showDiaperForm = false;
		diaperFromTagSheet = false;
	}

	function openDiaper() {
		diaperFromTagSheet = false;
		showDiaperForm = true;
	}
</script>

{#if !loaded}
	<div class="dashboard">
		<p style="color: var(--text-light); margin-top: 4rem;">Lastar...</p>
	</div>
{:else if !baby}
	<div class="dashboard">
		<p style="color: var(--text-light); margin-top: 4rem;">Ingen baby funnen. <a href="/settings">Innstillingar</a></p>
	</div>
{:else}
	<div class="dashboard">
		<!-- Header: baby info + sync badge -->
		<div class="header-row">
			<div class="baby-info">
				<span class="baby-name">{baby.name}</span>
				<span class="baby-age">{ageMonths} md</span>
				{#if sync.status === 'connected'}
					<span class="sync-badge sync-badge-ok"></span>
				{:else if sync.status === 'connecting'}
					<span class="sync-badge sync-badge-pending">...</span>
				{:else}
					<span class="sync-badge sync-badge-offline">offline</span>
				{/if}
			</div>
			<SleepButton
				{activeSleep}
				{todaySleeps}
				{ageMonths}
				{baby}
				{onSleepStarted}
				{onSleepEnded}
			/>
		</div>

		<!-- Arc + Timer -->
		<div class="arc-container">
			<Arc
				todaySleeps={arcSleeps}
				activeSleep={arcActiveSleep}
				prediction={arcPrediction}
				isNightMode={isNightMode()}
				wakeUpTime={todayWakeUp?.wake_time}
			/>
			<Timer
				{activeSleep}
				{prediction}
				{todayWakeUp}
				{todaySleeps}
			/>
		</div>

		<!-- Action buttons -->
		<div class="arc-actions">
			<button class="arc-action-btn diaper" onclick={openDiaper}>
				{pottyMode ? '🚽 Do' : '🧷 Bleie'}
			</button>
		</div>

		<!-- Summary stats -->
		<div class="summary-row">
			<span>
				<span class="stat-value">{liveNapCount()}</span>
				<span class="summary-label">{liveNapCount() === 1 ? 'lur' : 'lurar'}</span>
			</span>
			<span class="summary-sep">·</span>
			<span>
				<span class="stat-value">{formatDuration(liveNapMs())}</span>
				<span class="summary-label">lurtid</span>
			</span>
			{#if showTotal}
				<span class="summary-sep">·</span>
				<span>
					<span class="stat-value">{formatDuration(liveTotalMs())}</span>
					<span class="summary-label">totalt</span>
				</span>
			{/if}
			<span class="summary-sep">·</span>
			<span>
				<span class="stat-value">{s.diaperCount}</span>
				<span class="summary-label">{pottyMode ? 'dobesøk' : (s.diaperCount === 1 ? 'bleie' : 'bleier')}</span>
			</span>
		</div>
	</div>

	<!-- Modals -->
	{#if showTagSheet}
		<TagSheet
			sleepDomainId={tagSheetSleepId}
			startTime={tagSheetStartTime}
			diapers={diaperStub}
			{pottyMode}
			onClose={onTagSheetClose}
			onOpenDiaper={onTagSheetOpenDiaper}
		/>
	{/if}

	{#if showWakeUpSheet && wakeUpSnapshot}
		<WakeUpSheet
			sleepDomainId={wakeUpSleepId}
			sleepSnapshot={wakeUpSnapshot}
			onClose={onWakeUpClose}
		/>
	{/if}

	{#if showDiaperForm && baby}
		<DiaperForm
			babyId={baby.id}
			{pottyMode}
			onClose={onDiaperClose}
		/>
	{/if}
{/if}
