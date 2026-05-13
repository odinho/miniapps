<script lang="ts">
	import type { SleepLogRow, DiaperLogRow } from '$lib/types.js';
	import { goto } from '$app/navigation';
	import { appState } from '$lib/stores/app.svelte.js';
	import { sync } from '$lib/stores/sync.svelte.js';
	import Arc from '$lib/components/Arc.svelte';
	import Timer from '$lib/components/Timer.svelte';
	import SleepButton from '$lib/components/SleepButton.svelte';
	import TagSheet from '$lib/components/TagSheet.svelte';
	import DiaperForm from '$lib/components/DiaperForm.svelte';
	import WakeUpSheet from '$lib/components/WakeUpSheet.svelte';
	import EditSleepModal from '$lib/components/EditSleepModal.svelte';
	import { formatDuration, formatTime } from '$lib/utils.js';
	import { calcPauseMs } from '$lib/engine/classification.js';
	import { buildPause, buildResume, isPaused } from '$lib/sleep-actions.js';
	import { buildSleepInfoRows } from '$lib/settings-utils.js';
	import TimeInput from '$lib/components/TimeInput.svelte';
	import DateInput from '$lib/components/DateInput.svelte';
	import DstBanner from '$lib/components/DstBanner.svelte';
	import ContextCard from '$lib/components/ContextCard.svelte';
	import ManualSleepModal from '$lib/components/ManualSleepModal.svelte';
	import SleepInsightsCard from '$lib/components/SleepInsightsCard.svelte';

	// --- modal state ---
	let showTagSheet = $state(false);
	let tagSheetSleepId = $state('');
	let tagSheetStartTime = $state('');

	let showWakeUpSheet = $state(false);
	let wakeUpSleepId = $state('');
	let wakeUpSnapshot = $state<SleepLogRow | null>(null);

	let showDiaperForm = $state(false);
	let diaperFromTagSheet = $state(false);

	let editingSleep = $state<SleepLogRow | null>(null);

	// --- undo toast ---
	let undoToast = $state<{ message: string; undoEvents: Array<{ type: string; payload: Record<string, unknown> }> } | null>(null);
	let undoTimer: ReturnType<typeof setTimeout> | null = null;

	function showUndoToast(message: string, undoEvents: Array<{ type: string; payload: Record<string, unknown> }>) {
		if (undoTimer) clearTimeout(undoTimer);
		undoToast = { message, undoEvents };
		undoTimer = setTimeout(() => { undoToast = null; }, 8000);
	}

	async function handleUndo() {
		if (!undoToast) return;
		const events = undoToast.undoEvents;
		undoToast = null;
		if (undoTimer) clearTimeout(undoTimer);
		// Close any modals that may reference the entity being undone
		showTagSheet = false;
		showWakeUpSheet = false;
		editingSleep = null;
		await sync.sendEvents(events);
	}

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

	const paused = $derived(isPaused(activeSleep?.pauses));
	const strategy = $derived(prediction?.strategy ?? 'routine_schedule');
	const isNewborn = $derived(strategy === 'newborn_guidance');
	const isEmerging = $derived(strategy === 'emerging_rhythm');
	const showContextCard = $derived(isNewborn || isEmerging);
	const showInsightsCard = $derived(!showContextCard && prediction?.learnedSchedule && prediction?.calibration?.trust !== 'age-default');
	const showPopulationNorms = $derived(!showContextCard && !showInsightsCard && prediction?.calibration?.trust === 'age-default');
	const populationNormsRows = $derived(showPopulationNorms ? buildSleepInfoRows(ageMonths) : []);
	let pauseBusy = $state(false);

	async function handlePauseToggle() {
		if (pauseBusy || !activeSleep) return;
		pauseBusy = true;
		try {
			const event = paused
				? buildResume(activeSleep.domain_id)
				: buildPause(activeSleep.domain_id);
			await sync.sendEvents([event]);
		} finally {
			pauseBusy = false;
		}
	}

	const isNightMode = $derived.by(() => {
		void now; // re-derive when clock ticks
		const h = new Date().getHours();
		// Night while active night sleep (even after 06:00)
		if (activeSleep && !activeSleep.end_time && activeSleep.type === 'night') return true;
		// Day once baby has been marked awake today (until next night sleep starts)
		if (todayWakeUp) return false;
		// Fallback to clock when no sleep context
		return h < 6 || h >= 18;
	});

	// Apply theme based on night mode (keeps layout theme in sync with dashboard state)
	$effect(() => {
		const mode = isNightMode ? 'night' : 'day';
		document.documentElement.setAttribute('data-theme', mode);
	});


	// Redirect to settings when no baby exists
	$effect(() => {
		if (loaded && !baby) {
			goto('/settings');
		}
	});

	// Periodically refresh state during active sleep so predictions stay current
	$effect(() => {
		if (!activeSleep || activeSleep.end_time) return;
		const iv = setInterval(async () => {
			try {
				const res = await fetch('/api/state');
				if (res.ok) {
					const data = await res.json();
					appState.set(data);
				}
			} catch { /* offline — skip refresh */ }
		}, 5 * 60_000); // every 5 minutes
		return () => clearInterval(iv);
	});

	// Adapt types for Arc.svelte which expects narrower types than AppState provides
	const arcSleeps = $derived(
		todaySleeps.map((sl) => ({
			start_time: sl.start_time,
			end_time: sl.end_time,
			type: sl.type as 'nap' | 'night',
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
		prediction?.nextNap
			? {
					nextNap: prediction.nextNap,
					bedtime: prediction.bedtime ?? undefined,
					predictedNaps: prediction.predictedNaps ?? undefined,
				}
			: null,
	);
	const arcNapConfidenceBands = $derived(
		prediction?.confidence?.napRanges.map((nr) => ({
			lo: nr.startRange.lo,
			hi: nr.startRange.hi,
		})) ?? [],
	);

	// Active-sleep progress meter: predicted wake + ±1 SD band.
	// Falls back to expectedNapEnd/expectedNightEnd if the engine didn't supply
	// a range (older app states / tests). No band in that fallback case.
	const arcActiveWakeAt = $derived.by(() => {
		if (!arcActiveSleep || !prediction) return null;
		if (prediction.expectedWakeRange) return prediction.expectedWakeRange.point;
		return arcActiveSleep.type === 'night'
			? prediction.expectedNightEnd
			: prediction.expectedNapEnd;
	});
	const arcActiveWakeBand = $derived(
		arcActiveSleep && prediction?.expectedWakeRange
			? { lo: prediction.expectedWakeRange.lo, hi: prediction.expectedWakeRange.hi }
			: null,
	);

	// Skipped-nap visuals: keep the missed slot on the arc + render the rescue
	// window when the engine suggests one. Earlier-bedtime suggestions live in
	// the Timer, not the arc (they're a time shift, not a new blob).
	const arcSkippedNap = $derived(prediction?.skippedNap ?? null);
	// Arc rescue blob spans the recommended start → wake-by cap, mirroring the
	// "put down kl. X, vekk innan Y" Timer copy.
	const arcRescueWindow = $derived(
		prediction?.postSkipPlan?.kind === 'rescue'
			? { earliest: prediction.postSkipPlan.recommendedStart, latest: prediction.postSkipPlan.wakeBy }
			: null,
	);

	// Arc endpoint time labels
	const arcStartLabel = $derived.by(() => {
		if (isNightMode) {
			// Night: start = bedtime (last night sleep start or active sleep start)
			const nightSleep = activeSleep?.type === 'night' ? activeSleep :
				todaySleeps.toReversed().find(sl => sl.type === 'night');
			return nightSleep ? formatTime(nightSleep.start_time) : null;
		}
		// Day: start = wake-up time
		return todayWakeUp?.wake_time ? formatTime(todayWakeUp.wake_time) : null;
	});

	const arcEndLabel = $derived.by(() => {
		if (isNightMode) {
			// Night: end = expected wake-up from learned night duration
			if (prediction?.expectedNightEnd) return formatTime(prediction.expectedNightEnd);
			return null;
		}
		// Newborn: no bedtime concept
		if (isNewborn) return null;
		// Day: end = predicted bedtime
		return prediction?.bedtime ? formatTime(prediction.bedtime) : null;
	});

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

	const liveNapCount = $derived.by(() => {
		const base = stats?.napCount ?? 0;
		return base + (activeSleep?.type === 'nap' && !activeSleep.end_time ? 1 : 0);
	});

	const liveNapMs = $derived.by(() => {
		const base = (stats?.totalNapMinutes ?? 0) * 60_000;
		if (activeSleep?.type === 'nap' && !activeSleep.end_time) {
			const elapsed = now - new Date(activeSleep.start_time).getTime() - calcPauseMs(activeSleep.pauses ?? []);
			return base + Math.max(0, elapsed);
		}
		return base;
	});

	const liveTotalMs = $derived.by(() => {
		const napBase = (stats?.totalNapMinutes ?? 0) * 60_000;
		const nightBase = (stats?.totalNightMinutes ?? 0) * 60_000;
		let activeMs = 0;
		if (activeSleep && !activeSleep.end_time) {
			activeMs = Math.max(0, now - new Date(activeSleep.start_time).getTime() - calcPauseMs(activeSleep.pauses ?? []));
		}
		return napBase + nightBase + activeMs;
	});

	const showTotal = $derived(
		Math.round(liveTotalMs / 60_000) !== Math.round(liveNapMs / 60_000),
	);

	// --- callbacks ---
	function onSleepStarted(sleepDomainId: string, startTime: string) {
		tagSheetSleepId = sleepDomainId;
		tagSheetStartTime = startTime;
		showTagSheet = true;
		showUndoToast('Søvn starta', [{
			type: 'sleep.deleted',
			payload: { sleepDomainId },
		}]);
	}

	function onSleepEnded(domainId: string, sleepSnapshot: SleepLogRow) {
		wakeUpSleepId = domainId;
		wakeUpSnapshot = sleepSnapshot;
		showWakeUpSheet = true;
		showUndoToast('Søvn avslutta', [{
			type: 'sleep.restarted',
			payload: { sleepDomainId: domainId },
		}]);
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

	function onArcBubbleClick(sleepIndex: number) {
		const sleep = todaySleeps[sleepIndex];
		if (sleep) {
			editingSleep = sleep;
		}
	}

	/** Arc start endpoint click: open night sleep or morning dialog */
	function onArcStartClick() {
		if (isNightMode) {
			const target = activeSleep ?? todaySleeps.toReversed().find(sl => sl.type === 'night');
			if (target) editingSleep = target;
		} else {
			const nightSleep = todaySleeps.toReversed().find(sl => sl.type === 'night');
			if (nightSleep) {
				editingSleep = nightSleep;
			} else {
				openMorningDialog();
			}
		}
	}

	/** Arc end endpoint click: in day mode it's bedtime prediction (no-op), in night mode open wakeup */
	function onArcEndClick() {
		if (isNightMode) {
			// Night mode end = morning → no action (prediction)
		} else {
			// Day mode end = bedtime prediction → no action
		}
	}

	function onEditSleepClose() {
		editingSleep = null;
	}

	// --- Morning prompt (onboarding / cold start) ---
	// Shows when no todayWakeUp exists and no sleeps logged yet today
	const needsMorningPrompt = $derived.by(() => {
		void now; // re-derive when clock ticks
		if (!baby || todayWakeUp) return false;
		if (activeSleep && !activeSleep.end_time) return false;
		if (todaySleeps.length > 0) return false;
		const todayStr = new Date().toISOString().slice(0, 10);
		if (morningDismissedDate === todayStr) return false;
		const h = new Date().getHours();
		return h >= 5 && h < 13;
	});

	let showMorningDialog = $state(false);
	let morningDate = $state('');
	let morningTime = $state('07:00');
	let morningBusy = $state(false);
	let morningDismissedDate = $state('');
	let showMorningManualSleep = $state(false);
	let showNapBudgetExplain = $state(false);

	$effect(() => {
		if (needsMorningPrompt && !morningDate) {
			const d = new Date();
			morningDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
		}
	});

	function openMorningDialog() {
		const d = new Date();
		morningDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
		if (todayWakeUp) {
			morningTime = formatTime(todayWakeUp.wake_time);
		} else {
			morningTime = '07:00';
		}
		showMorningDialog = true;
	}

	async function saveMorningWakeTime() {
		if (morningBusy || !baby) return;
		morningBusy = true;
		try {
			const wakeTime = new Date(`${morningDate}T${morningTime}:00`).toISOString();
			await sync.sendEvents([{
				type: 'day.started',
				payload: { babyId: baby.id, wakeTime },
			}]);
			showMorningDialog = false;
		} finally {
			morningBusy = false;
		}
	}

	function skipMorningWakeTime() {
		morningDismissedDate = new Date().toISOString().slice(0, 10);
		showMorningDialog = false;
	}

	function openMorningManualSleep() {
		showMorningManualSleep = true;
	}

	function closeMorningManualSleep() {
		showMorningManualSleep = false;
	}

	// Off-day toggle. Sick/travel/spurt/DST days that should be excluded
	// from the napBudget trend so a bad week doesn't pull the engine's
	// recommendations sideways. Reason is free-text for now (v1).
	const isOffDay = $derived((todayWakeUp?.off_day ?? 0) === 1);
	let offDayBusy = $state(false);
	async function toggleOffDay() {
		if (offDayBusy || !baby) return;
		offDayBusy = true;
		try {
			const date = todayWakeUp?.date
				?? new Date().toISOString().slice(0, 10);
			if (isOffDay) {
				await sync.sendEvents([{
					type: 'day.unmarked_off',
					payload: { babyId: baby.id, date },
				}]);
			} else {
				await sync.sendEvents([{
					type: 'day.marked_off',
					payload: { babyId: baby.id, date, reason: null },
				}]);
			}
		} finally {
			offDayBusy = false;
		}
	}
</script>

{#if !loaded}
	<div class="dashboard">
		<p style="color: var(--text-light); margin-top: 4rem;">Lastar...</p>
	</div>
{:else if !baby}
	<div class="dashboard">
		<p style="color: var(--text-light); margin-top: 4rem;">Lastar...</p>
	</div>
{:else}
	<div class="dashboard" data-testid="dashboard">
		{#if needsMorningPrompt}
			<div class="morning-prompt" data-testid="morning-prompt">
				<div class="morning-icon" data-testid="morning-icon">🌅</div>
				<h2>God morgon!</h2>
				<p>Når vakna {baby.name}?</p>
				<div style="display: flex; gap: 8px; margin: 8px 0;">
					<DateInput bind:value={morningDate} />
					<TimeInput bind:value={morningTime} />
				</div>
				<div style="display: flex; gap: 8px;">
					<button class="btn btn-primary" onclick={saveMorningWakeTime} disabled={morningBusy}>
						Sett vaknetid
					</button>
					<button class="btn btn-ghost" onclick={skipMorningWakeTime} disabled={morningBusy}>
						Hopp over
					</button>
				</div>
				<button
					class="btn btn-ghost"
					style="margin-top: 8px; font-size: 0.85rem; width: 100%;"
					data-testid="morning-add-sleep"
					onclick={openMorningManualSleep}
				>
					🌙 Legg til nattesøvn i går
				</button>
			</div>
		{/if}

		{#if showMorningDialog && !needsMorningPrompt}
			<div class="modal-overlay" data-testid="morning-dialog-overlay" role="presentation" onclick={() => showMorningDialog = false}>
				<div class="morning-prompt" style="position: relative; max-width: 320px; margin: 20vh auto;" role="presentation" onclick={(e) => e.stopPropagation()}>
					<h2>Endra vaknetid</h2>
					<div style="display: flex; gap: 8px; margin: 8px 0;">
						<DateInput bind:value={morningDate} />
						<TimeInput bind:value={morningTime} />
					</div>
					<div style="display: flex; gap: 8px;">
						<button class="btn btn-primary" onclick={saveMorningWakeTime} disabled={morningBusy}>
							Lagra
						</button>
						<button class="btn btn-ghost" onclick={() => showMorningDialog = false}>
							Avbryt
						</button>
					</div>
				</div>
			</div>
		{/if}

		<DstBanner timezone={baby.timezone} bedtime={prediction?.bedtime} />

		<!-- Header: baby info + sync badge -->
		<div class="header-row">
			<button class="baby-info" onclick={() => goto('/events')} style="cursor: pointer; background: none; border: none; padding: 0; text-align: left; font: inherit;">
				<span class="baby-name" data-testid="baby-name">{baby.name}</span>
				<span class="baby-age" data-testid="baby-age">{ageMonths} mnd</span>
				{#if sync.pendingCount > 0}
					<span class="sync-badge sync-badge-pending" data-testid="sync-badge">{sync.pendingCount} ventande</span>
				{:else if sync.status === 'connected'}
					<span class="sync-badge sync-badge-ok" data-testid="sync-badge"></span>
				{:else if sync.status === 'connecting'}
					<span class="sync-badge sync-badge-pending" data-testid="sync-badge">...</span>
				{:else}
					<span class="sync-badge sync-badge-offline" data-testid="sync-badge">offline</span>
				{/if}
			</button>
			<SleepButton
				{activeSleep}
				{todaySleeps}
				{ageMonths}
				{baby}
				napsAllDone={prediction?.napsAllDone && prediction?.postSkipPlan?.kind !== 'rescue'}
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
				isNightMode={isNightMode}
				wakeUpTime={todayWakeUp?.wake_time}
				startTimeLabel={arcStartLabel}
				endTimeLabel={arcEndLabel}
				napConfidenceBands={arcNapConfidenceBands}
				activeWakeAt={arcActiveWakeAt}
				activeWakeBand={arcActiveWakeBand}
				skippedNap={arcSkippedNap}
				rescueWindow={arcRescueWindow}
				onSleepClick={onArcBubbleClick}
				onStartClick={onArcStartClick}
				onEndClick={onArcEndClick}
			/>
			<Timer
				{activeSleep}
				{prediction}
				{todayWakeUp}
				{todaySleeps}
				targetBedtime={baby?.target_bedtime ?? null}
				onEditStart={activeSleep && !activeSleep.end_time ? () => { editingSleep = activeSleep; } : undefined}
			/>
		</div>

		<!-- Action buttons -->
		<div class="arc-actions">
			{#if activeSleep && !activeSleep.end_time}
				<button
					class="arc-action-btn {paused ? 'morning' : 'nap'}"
					data-testid="pause-btn"
					onclick={handlePauseToggle}
					disabled={pauseBusy}
				>
					{paused ? '▶️ Fortset' : '⏸️ Pause'}
				</button>
			{/if}
			<button class="arc-action-btn diaper" onclick={openDiaper} data-testid="fab">
				{pottyMode ? '🚽 Do' : '🧷 Bleie'}
			</button>
		</div>

		{#if prediction?.continuationWindow && (!activeSleep || activeSleep.end_time)}
			{@const cw = prediction.continuationWindow}
			{@const closesIn = new Date(cw.closesAt).getTime() - now}
			<div class="continuation-banner" data-testid="continuation-banner">
				<div class="continuation-title">💤 Forleng luren</div>
				<div class="continuation-body">
					{#if closesIn > 0}
						Førre lur var altfor kort. Prøv å la henne sove att no — vindauget stenger {formatTime(cw.closesAt)} ({formatDuration(closesIn)}).
					{:else}
						Vindauget for forlenging er over. Vent på neste lur.
					{/if}
				</div>
				<div class="continuation-hint">
					Lite stimuli, mørkt rom. Viss ho sov inn, vekk innan {formatTime(cw.capLatestEnd)} så dagen heng saman.
				</div>
			</div>
		{/if}

		{#if prediction?.napBudget && activeSleep && !activeSleep.end_time && activeSleep.type === 'nap'}
			{@const nb = prediction.napBudget}
			{@const wakeAt = new Date(nb.wakeBy)}
			{@const wakeCountdown = wakeAt.getTime() - now}
			<div class="nap-budget-banner" data-testid="nap-budget-banner">
				<div class="nap-budget-row">
					<div class="nap-budget-title">💡 Vekk for å treffe trenden</div>
					<button
						class="nap-budget-explain-btn"
						onclick={() => (showNapBudgetExplain = !showNapBudgetExplain)}
						aria-label="Forklar trendmål"
					>?</button>
				</div>
				<div class="nap-budget-body">
					{#if wakeCountdown > 0}
						Vekk innan kl. {formatTime(nb.wakeBy)} ({formatDuration(wakeCountdown)})
					{:else}
						Vekk no — kappet er over.
					{/if}
					{#if nb.mode === 'established'}
						<span class="nap-budget-mode">· presis modus</span>
					{:else}
						<span class="nap-budget-mode">· éin syklus</span>
					{/if}
				</div>
				{#if showNapBudgetExplain}
					<div class="nap-budget-explain">
						{#if nb.cycleNudge}
							Vekkjingsvindauget tek omsyn til hennar lærte syklus ({prediction.learnedSchedule?.sleepCycleMin ?? '~50'} min).
							Vi kapper ved slutten av éin full syklus så ho vaknar i lett fase — mjukare oppvakning, mindre tilvenningsstress.
						{:else}
							Vi anbefaler å vakne litt før neste syklus startar så du får tid til å koma fram til henne. Trendmålet i dag er {Math.round(nb.context.blendedTrendMin / 60 * 10) / 10}t totalt søvn ({nb.context.sourceLabel}).
						{/if}
						<button class="nap-budget-explain-close" onclick={() => (showNapBudgetExplain = false)}>Lukk</button>
					</div>
				{/if}
			</div>
		{/if}

		{#if prediction?.rescueNap && activeSleep && !activeSleep.end_time && activeSleep.type === 'nap'}
			{@const recWake = new Date(prediction.rescueNap.recommendedWakeTime)}
			{@const recCountdown = recWake.getTime() - now}
			<div class="rescue-nap-banner" data-testid="rescue-nap-banner">
				<div class="rescue-nap-title">💡 Reddingslur</div>
				<div class="rescue-nap-body">
					{#if recCountdown > 0}
						Tilrådd å vekka kl. {formatTime(prediction.rescueNap.recommendedWakeTime)} ({formatDuration(recCountdown)})
					{:else}
						Tilrådd å vekka no — reddingslurar bør vera korte
					{/if}
				</div>
				<div class="rescue-nap-hint">
					{#if prediction.rescueNap.reason === 'short_prior_nap'}
						Førre lur var under forventa. Vekking i lett fase gjev mjukare oppvakning og held søvntrykket til natta.
					{:else if prediction.rescueNap.reason === 'extra_nap'}
						Ekstra lur utover forventa — vekking i lett fase gjev mjukare oppvakning og beskyttar leggetida.
					{:else}
						Kort førre lur + ekstra lur — vekking i lett fase beskyttar både mjuk oppvakning og leggetida.
					{/if}
				</div>
			</div>
		{/if}

		{#if showContextCard && prediction}
			<ContextCard {prediction} {ageMonths} birthdate={baby.birthdate} />
		{/if}

		{#if showPopulationNorms}
			<div class="population-norms" data-testid="population-norms">
				<div class="population-norms-title">Typisk for {ageMonths} mnd</div>
				{#each populationNormsRows as row}
					<div class="population-norms-row">
						<span class="population-norms-label">{row.label}</span>
						<span class="population-norms-value">{row.value}</span>
					</div>
				{/each}
				{#if prediction?.calibration?.warnings?.length}
					<div class="population-norms-hint">
						{prediction.calibration.warnings[prediction.calibration.warnings.length - 1]}
					</div>
				{/if}
			</div>
		{/if}

		{#if showInsightsCard && prediction?.learnedSchedule}
			<SleepInsightsCard
				schedule={prediction.learnedSchedule}
				calibration={prediction.calibration}
				dailyTrendTotalMin={prediction.dailyTrendTotalMin}
			/>
		{/if}

		<div class="off-day-row">
			<button
				class="off-day-btn"
				class:active={isOffDay}
				onclick={toggleOffDay}
				disabled={offDayBusy}
				data-testid="off-day-toggle"
				aria-pressed={isOffDay}
			>
				{#if isOffDay}
					✅ Dagen er markert som av · trekk frå trenden
				{:else}
					🤒 Marker som av (sjuk / reise)
				{/if}
			</button>
		</div>

		<!-- Spacer to push stats down -->
		<div style="flex: 1;"></div>

		<!-- Summary stats -->
		<div class="summary-row">
			<span>
				<span class="stat-value">{liveNapCount}</span>
				<span class="summary-label">{liveNapCount === 1 ? 'lur' : 'lurar'}</span>
			</span>
			<span class="summary-sep">·</span>
			<span>
				<span class="stat-value">{formatDuration(liveNapMs)}</span>
				<span class="summary-label">lurtid</span>
			</span>
			{#if showTotal}
				<span class="summary-sep">·</span>
				<span>
					<span class="stat-value">{formatDuration(liveTotalMs)}</span>
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

	{#if editingSleep}
		<EditSleepModal
			entry={editingSleep}
			onClose={onEditSleepClose}
			onDeleted={onEditSleepClose}
		/>
	{/if}

	{#if showMorningManualSleep && baby}
		<ManualSleepModal
			babyId={baby.id}
			onClose={closeMorningManualSleep}
		/>
	{/if}

	<!-- Undo toast -->
	{#if undoToast}
		<div class="undo-toast">
			<span>{undoToast.message}</span>
			<button class="btn btn-ghost" onclick={handleUndo}>Angre</button>
		</div>
	{/if}
{/if}
