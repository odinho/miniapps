<script lang="ts">
	import type { SleepLogRow } from '$lib/types.js';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { appState } from '$lib/stores/app.svelte.js';
	import { sync } from '$lib/stores/sync.svelte.js';
	import Arc from '$lib/components/Arc.svelte';
	import Timer from '$lib/components/Timer.svelte';
	import SleepButton from '$lib/components/SleepButton.svelte';
	import TagSheet from '$lib/components/TagSheet.svelte';
	import DiaperForm from '$lib/components/DiaperForm.svelte';
	import WakeUpSheet from '$lib/components/WakeUpSheet.svelte';
	import EditSleepModal from '$lib/components/EditSleepModal.svelte';
	import NightWakingEditSheet from '$lib/components/NightWakingEditSheet.svelte';
	import { formatDuration, formatTime, formatTimeWindow } from '$lib/utils.js';
	import { generateNightWakingId } from '$lib/identity.js';
	import { buildSleepInfoRows } from '$lib/settings-utils.js';
	import TimeInput from '$lib/components/TimeInput.svelte';
	import DateInput from '$lib/components/DateInput.svelte';
	import DstBanner from '$lib/components/DstBanner.svelte';
	import ContextCard from '$lib/components/ContextCard.svelte';
	import ManualSleepModal from '$lib/components/ManualSleepModal.svelte';
	import TodayCard from '$lib/components/TodayCard.svelte';
	import FamilyHome from '$lib/components/FamilyHome.svelte';
	import { isoToDateInTz } from '$lib/tz.js';

	// --- modal state ---
	let showTagSheet = $state(false);
	let tagSheetSleepId = $state('');
	let tagSheetStartTime = $state('');

	let showWakeUpSheet = $state(false);
	let wakeUpSleepId = $state('');
	let wakeUpSnapshot = $state<SleepLogRow | null>(null);
	// Set when the wake-up sheet is closing an over-a-day stale session (shows
	// a date picker, defaults to the sleep start, always records an end_time).
	let wakeUpClosingStale = $state(false);

	// Stale-session resolution.
	let confirmDiscardStale = $state(false);
	let staleBusy = $state(false);

	function openStaleWakeUp() {
		if (!staleActiveSleep) return;
		wakeUpSleepId = staleActiveSleep.domain_id;
		wakeUpSnapshot = staleActiveSleep;
		wakeUpClosingStale = true;
		showWakeUpSheet = true;
	}

	async function discardStaleSleep() {
		if (staleBusy || !staleActiveSleep) return;
		staleBusy = true;
		try {
			await sync.sendEvents([
				{ type: 'sleep.deleted', payload: { sleepDomainId: staleActiveSleep.domain_id } },
			]);
			confirmDiscardStale = false;
		} finally {
			staleBusy = false;
		}
	}

	let showDiaperForm = $state(false);
	let diaperFromTagSheet = $state(false);

	let editingSleep = $state<SleepLogRow | null>(null);
	let editingNightWakingId = $state<string | null>(null);
	let addingWakingForNight = $state<SleepLogRow | null>(null);

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
	// `?baby=<id>` focuses one child's full dashboard (opened from a family
	// lane); otherwise the primary baby (single-baby default). At 2+ children
	// with no focus, the home is the family lane view instead.
	const focusedId = $derived(Number(page.url.searchParams.get('baby')) || null);
	const babies = $derived(appState.babies);
	const showFamilyHome = $derived(babies.length > 1 && focusedId == null);
	const s = $derived(
		focusedId != null ? (appState.babyById(focusedId) ?? appState.state) : appState.state,
	);
	const loaded = $derived(appState.loaded);
	const baby = $derived(s.baby);
	const activeSleep = $derived(s.activeSleep);
	// An open sleep that's run over a day (forgotten wake). The server hides it
	// from the engine and surfaces it here so we can prompt the parent to
	// resolve it; at 48h we additionally force the morning re-onboarding.
	const staleActiveSleep = $derived(s.staleActiveSleep);
	const todaySleeps = $derived(s.todaySleeps);
	const prediction = $derived(s.prediction);
	const stats = $derived(s.stats);
	const ageMonths = $derived(s.ageMonths);
	const todayWakeUp = $derived(s.todayWakeUp);
	const pottyMode = $derived(baby?.potty_mode === 1);
	const trackDiaper = $derived(baby?.track_diaper === 1);

	// Open night-waking (no end_time) inside the active night sleep — drives
	// the Nattvaking button between "start" and "Sov att" states.
	const todayNightWakings = $derived(s.todayNightWakings);
	const activeNightWaking = $derived(
		activeSleep?.type === 'night' && !activeSleep.end_time
			? todayNightWakings.find((w) => !w.end_time) ?? null
			: null,
	);
	const strategy = $derived(prediction?.strategy ?? 'routine_schedule');
	const isNewborn = $derived(strategy === 'newborn_guidance');
	const isEmerging = $derived(strategy === 'emerging_rhythm');
	const showContextCard = $derived(isNewborn || isEmerging);
	/**
	 * Heim's "I dag" card replaces the older multi-day Søvnoversikt panel
	 * (the 2026-05-20 mislabeling complaint). It surfaces actuals so far
	 * today + a forward-looking "Neste" line. Show whenever the engine
	 * isn't in newborn/emerging mode AND the parent has any learned
	 * calibration — otherwise the calibration-light path renders the
	 * population-norms block instead.
	 */
	const showTodayCard = $derived(!showContextCard && prediction?.calibration?.trust !== 'age-default');
	const showPopulationNorms = $derived(!showContextCard && !showTodayCard && prediction?.calibration?.trust === 'age-default');
	const populationNormsRows = $derived(showPopulationNorms ? buildSleepInfoRows(ageMonths) : []);
	// The bottom summary row is the default surface; tap it to reveal the
	// detailed "I dag" rows (per-sleep windows + Leggetid hint). Per-mount
	// state so a refresh resets to the clean default.
	let summaryExpanded = $state(false);

	let nightWakingBusy = $state(false);
	async function handleNightWakingToggle() {
		if (nightWakingBusy || !activeSleep || !baby) return;
		nightWakingBusy = true;
		try {
			if (activeNightWaking) {
				await sync.sendEvents([
					{
						type: 'night_waking.ended',
						payload: {
							wakingDomainId: activeNightWaking.domain_id,
							endTime: new Date().toISOString(),
						},
					},
				]);
			} else {
				await sync.sendEvents([
					{
						type: 'night_waking.started',
						payload: {
							babyId: baby.id,
							startTime: new Date().toISOString(),
							wakingDomainId: generateNightWakingId(),
						},
					},
				]);
			}
		} finally {
			nightWakingBusy = false;
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

	// Periodically refresh state during active sleep so predictions stay current.
	// Goes through sync.refresh() so the normalize + pending-queue overlay isn't
	// bypassed (a raw appState.set would drop optimistic queued events).
	$effect(() => {
		if (!activeSleep || activeSleep.end_time) return;
		const iv = setInterval(() => { void sync.refresh(); }, 5 * 60_000); // every 5 minutes
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
	const arcNightWakings = $derived(
		todayNightWakings.map((w) => ({
			startTime: w.start_time,
			endTime: w.end_time,
			domainId: w.domain_id,
		})),
	);

	// Active-sleep progress meter: predicted wake + ±1 SD band.
	//
	// When the engine has emitted an actionable wake recommendation
	// (napBudget cap for over-trend days, rescueNap cap for short-prior /
	// extra naps) we point the arc at *that* deadline instead of the
	// natural expected wake — otherwise the marker on the arc tells the
	// parent one time and the banner tells them another. The natural
	// expected wake is only used when no cap is in play.
	//
	// Band: a ±1 SD natural-wake band makes sense around a *predicted*
	// wake. A cap is a deadline, not a range; we hide the band when a cap
	// overrides so the arc stops painting a phantom natural window past
	// the actionable target.
	const arcActiveWakeOverride = $derived.by(() => {
		if (!arcActiveSleep || !prediction) return null;
		if (arcActiveSleep.type === 'nap' && prediction.napBudget?.wakeBy) {
			return prediction.napBudget.wakeBy;
		}
		if (prediction.rescueNap?.recommendedWakeTime) {
			return prediction.rescueNap.recommendedWakeTime;
		}
		return null;
	});
	const arcActiveWakeAt = $derived.by(() => {
		if (!arcActiveSleep || !prediction) return null;
		if (arcActiveWakeOverride) return arcActiveWakeOverride;
		if (prediction.expectedWakeRange) return prediction.expectedWakeRange.point;
		return arcActiveSleep.type === 'night'
			? prediction.expectedNightEnd
			: prediction.expectedNapEnd;
	});
	const arcActiveWakeBand = $derived(
		arcActiveSleep && prediction?.expectedWakeRange && !arcActiveWakeOverride
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

	// Arc endpoint ISO anchors. The Arc uses these BOTH as displayed labels and
	// as the time-window the time→fraction math runs in — so an active sleep
	// starting at the bedtime label sits at the start endpoint instead of
	// floating up the arc (2026-05-21 bug). Day arcs use bedtime on the end.
	const arcBedtimeIso = $derived.by(() => {
		if (isNightMode) {
			const nightSleep = activeSleep?.type === 'night' ? activeSleep :
				todaySleeps.toReversed().find(sl => sl.type === 'night');
			if (nightSleep) return nightSleep.start_time;
			// No logged night yet: predicted bedtime is the next-best anchor.
			return prediction?.bedtime ?? null;
		}
		// Day arc end = predicted bedtime (when available).
		return isNewborn ? null : prediction?.bedtime ?? null;
	});
	const arcNightEndIso = $derived(
		isNightMode ? prediction?.expectedNightEnd ?? null : null,
	);

	const arcStartLabel = $derived.by(() => {
		if (isNightMode) {
			// Night: only show a label when we have a logged sleep — predicted bedtimes
			// shouldn't impersonate "this is when she went to bed".
			const nightSleep = activeSleep?.type === 'night' ? activeSleep :
				todaySleeps.toReversed().find(sl => sl.type === 'night');
			return nightSleep ? formatTime(nightSleep.start_time) : null;
		}
		// Day: start = wake-up time
		return todayWakeUp?.wake_time ? formatTime(todayWakeUp.wake_time) : null;
	});

	const arcEndLabel = $derived.by(() => {
		if (isNightMode) {
			if (prediction?.expectedNightEnd) return formatTime(prediction.expectedNightEnd);
			return null;
		}
		if (isNewborn) return null;
		return prediction?.bedtime ? formatTime(prediction.bedtime) : null;
	});

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
			const elapsed = now - new Date(activeSleep.start_time).getTime();
			return base + Math.max(0, elapsed);
		}
		return base;
	});

	// Subtract any night_waking intervals that fall inside an active night sleep
	// (open wakings net out time-since-start; closed ones net out their span).
	// Returns 0 for naps (which have no wakings under the new design).
	function activeNightWakingMs(): number {
		if (!activeSleep || activeSleep.end_time || activeSleep.type !== 'night') return 0;
		const startMs = new Date(activeSleep.start_time).getTime();
		let ms = 0;
		for (const w of todayNightWakings) {
			const ws = new Date(w.start_time).getTime();
			if (ws < startMs) continue;
			const we = w.end_time ? new Date(w.end_time).getTime() : now;
			ms += Math.max(0, we - ws);
		}
		return ms;
	}

	const liveTotalMs = $derived.by(() => {
		// Wake-to-wake totals include the morning overnight that started
		// before midnight — without this, the bottom summary silently dropped
		// ~10–12h of night sleep the day after a normal overnight
		// (2026-05-20 user report). Falls back to `stats` if dayTotals is
		// missing (older cached state shape during offline reload).
		const dt = s.dayTotals;
		const napBase = (dt?.napMinutes ?? stats?.totalNapMinutes ?? 0) * 60_000;
		const todayNightBase = (dt?.todayNightMinutes ?? stats?.totalNightMinutes ?? 0) * 60_000;
		const priorNightBase = (dt?.priorNightMinutes ?? 0) * 60_000;
		let activeMs = 0;
		if (activeSleep && !activeSleep.end_time) {
			activeMs = Math.max(0, now - new Date(activeSleep.start_time).getTime() - activeNightWakingMs());
		}
		return napBase + todayNightBase + priorNightBase + activeMs;
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
		wakeUpClosingStale = false;
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
		wakeUpClosingStale = false;
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

	function onArcNightWakingClick(domainId: string) {
		editingNightWakingId = domainId;
	}

	const editingNightWaking = $derived(
		editingNightWakingId
			? todayNightWakings.find((w) => w.domain_id === editingNightWakingId) ?? null
			: null,
	);

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

	function onEditSleepClose() {
		editingSleep = null;
	}

	// --- Morning prompt (onboarding / cold start) ---
	// Shows when no todayWakeUp exists and no sleeps logged yet today.
	// Date keys are in the baby's timezone so dismissal and "today" stay
	// consistent across UTC-midnight crossings.
	const needsMorningPrompt = $derived.by(() => {
		void now; // re-derive when clock ticks
		if (!baby || todayWakeUp) return false;
		if (activeSleep && !activeSleep.end_time) return false;
		if (todaySleeps.length > 0) return false;
		const todayStr = isoToDateInTz(new Date().toISOString(), baby.timezone || 'UTC');
		if (morningDismissedDate === todayStr) return false;
		// Abandoned (>48h) open session: no meaningful recovery, so force the
		// "when did they wake" onboarding regardless of time of day.
		if (staleActiveSleep?.staleStatus === 'abandoned') return true;
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
		if (needsMorningPrompt && !morningDate && baby) {
			morningDate = isoToDateInTz(new Date().toISOString(), baby.timezone || 'UTC');
		}
	});

	function openMorningDialog() {
		if (baby) {
			morningDate = isoToDateInTz(new Date().toISOString(), baby.timezone || 'UTC');
		}
		if (todayWakeUp?.wake_time) {
			morningTime = formatTime(todayWakeUp.wake_time);
		} else {
			morningTime = '07:00';
		}
		showMorningDialog = true;
	}

	async function saveMorningWakeTime() {
		if (morningBusy || !baby) return;
		// Validate before constructing Date — calling toISOString() on an Invalid
		// Date (which is what `new Date("…")` returns for garbage input) throws.
		if (!/^\d{4}-\d{2}-\d{2}$/.test(morningDate) || !/^\d{2}:\d{2}$/.test(morningTime)) return;
		const candidate = new Date(`${morningDate}T${morningTime}:00`);
		if (Number.isNaN(candidate.getTime())) return;

		morningBusy = true;
		try {
			// Setting a fresh wake time also discards any orphaned over-a-day
			// session — recording today's wake is the parent's "start fresh".
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [{
				type: 'day.started',
				payload: { babyId: baby.id, wakeTime: candidate.toISOString() },
			}];
			if (staleActiveSleep) {
				events.push({
					type: 'sleep.deleted',
					payload: { sleepDomainId: staleActiveSleep.domain_id },
				});
			}
			const result = await sync.sendEvents(events);
			if (result == null) return;
			showMorningDialog = false;
		} finally {
			morningBusy = false;
		}
	}

	function skipMorningWakeTime() {
		morningDismissedDate = baby
			? isoToDateInTz(new Date().toISOString(), baby.timezone || 'UTC')
			: new Date().toISOString().slice(0, 10);
		showMorningDialog = false;
	}

	function openMorningManualSleep() {
		showMorningManualSleep = true;
	}

	function closeMorningManualSleep() {
		showMorningManualSleep = false;
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
{:else if showFamilyHome}
	<div class="dashboard" data-testid="dashboard">
		<div class="header-row">
			<span class="baby-name">Familien</span>
			{#if sync.pendingCount > 0}
				<span class="sync-badge sync-badge-pending" data-testid="sync-badge">{sync.pendingCount} ventande</span>
			{:else if sync.status === 'connected'}
				<span class="sync-badge sync-badge-ok" data-testid="sync-badge"></span>
			{:else if sync.status === 'connecting'}
				<span class="sync-badge sync-badge-pending" data-testid="sync-badge">...</span>
			{:else}
				<span class="sync-badge sync-badge-offline" data-testid="sync-badge">offline</span>
			{/if}
		</div>
		<FamilyHome {babies} isTwinMode={appState.state.family.isTwinMode} onUndo={showUndoToast} onFocus={(id) => goto(`/?baby=${id}`)} />
		{#if undoToast}
			<div class="undo-toast">
				<span>{undoToast.message}</span>
				<button class="btn btn-ghost" onclick={handleUndo}>Angre</button>
			</div>
		{/if}
	</div>
{:else}
	<div class="dashboard" data-testid="dashboard">
		{#if focusedId != null && babies.length > 1}
			<button
				class="btn btn-ghost"
				data-testid="back-to-family"
				style="align-self: flex-start; margin-bottom: 4px;"
				onclick={() => goto('/')}
			>
				← Familien
			</button>
		{/if}
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

		{#if staleActiveSleep}
			{@const staleElapsed = now - new Date(staleActiveSleep.start_time).getTime()}
			<div class="stale-sleep-banner" data-testid="stale-sleep-banner">
				<div class="stale-sleep-title">⚠️ Søvnøkta er ikkje avslutta</div>
				<div class="stale-sleep-body">
					Ei {staleActiveSleep.type === 'night' ? 'nattesøvn' : 'lur'} starta kl. {formatTime(staleActiveSleep.start_time)} og har vart i {formatDuration(staleElapsed)}. Du gløymde truleg å registrere vakning, så vi har sett dagen på pause.
				</div>
				<div class="stale-sleep-actions">
					<button class="btn btn-primary" onclick={openStaleWakeUp} data-testid="stale-set-wake">
						Sett vaknetid
					</button>
					<button class="btn btn-ghost" onclick={() => (confirmDiscardStale = true)} data-testid="stale-discard">
						Forkast økta
					</button>
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
				wakeCapActive={!!(activeSleep && !activeSleep.end_time && activeSleep.type === 'nap' && (prediction?.napBudget || prediction?.rescueNap))}
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
				bedtime={arcBedtimeIso}
				nightEnd={arcNightEndIso}
				startTimeLabel={arcStartLabel}
				endTimeLabel={arcEndLabel}
				napConfidenceBands={arcNapConfidenceBands}
				activeWakeAt={arcActiveWakeAt}
				activeWakeBand={arcActiveWakeBand}
				skippedNap={arcSkippedNap}
				rescueWindow={arcRescueWindow}
				nightWakings={arcNightWakings}
				onSleepClick={onArcBubbleClick}
				onStartClick={onArcStartClick}
				onNightWakingClick={onArcNightWakingClick}
			/>
			<Timer
				{activeSleep}
				{prediction}
				{todayWakeUp}
				{todaySleeps}
				{todayNightWakings}
				targetBedtime={baby?.target_bedtime ?? null}
				onEditStart={activeSleep && !activeSleep.end_time ? () => { editingSleep = activeSleep; } : undefined}
			/>
		</div>

		<!-- Action buttons -->
		<div class="arc-actions">
			{#if activeSleep && !activeSleep.end_time && activeSleep.type === 'night'}
				<button
					class="arc-action-btn {activeNightWaking ? 'morning' : 'night-waking'}"
					data-testid="night-waking-btn"
					onclick={handleNightWakingToggle}
					disabled={nightWakingBusy}
				>
					{activeNightWaking ? '💤 Sov att' : '🌙 Nattvaking'}
				</button>
			{/if}
			{#if trackDiaper}
				<button class="arc-action-btn diaper" onclick={openDiaper} data-testid="fab">
					{pottyMode ? '🚽 Do' : '🧷 Bleie'}
				</button>
			{/if}
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
						Vekk i vindauget {formatTimeWindow(nb.wakeBy)} ({formatDuration(wakeCountdown)})
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
					{@const cyc = prediction.learnedSchedule?.sleepCycle}
					{@const cycMin = cyc?.minutes ?? prediction.learnedSchedule?.sleepCycleMin ?? 55}
					{@const cycLabel = cyc?.source === 'learned' && cyc.confidence !== 'low'
						? `hennar lærte syklus (${cycMin} min)`
						: `typisk syklus for alderen (${cycMin} min)`}
					<div class="nap-budget-explain">
						{#if nb.cycleNudge}
							Vekkjingsvindauget tek omsyn til {cycLabel}.
							Vi kapper ved slutten av éin full syklus så ho vaknar i lett fase — mjukare oppvakning, mindre tilvenningsstress.
						{:else}
							Vi anbefaler å vakne litt før neste syklus startar så du får tid til å koma fram til henne. Trendmålet i dag er {Math.round(nb.context.blendedTrendMin / 60 * 10) / 10}t totalt søvn.
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
				<div class="rescue-nap-title">💡 Kort ekstralur</div>
				<div class="rescue-nap-body">
					{#if recCountdown > 0}
						Tilrådd å vekka kl. {formatTime(prediction.rescueNap.recommendedWakeTime)} ({formatDuration(recCountdown)})
					{:else}
						Tilrådd å vekka no — slike skal vere korte
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

		<!-- Spacer to push stats down -->
		<div style="flex: 1;"></div>

		<!-- Expanded details for "I dag" — only renders when the summary row
			 below is tapped. The card itself just paints its rows; visibility
			 is the parent's responsibility. -->
		{#if showTodayCard && summaryExpanded}
			<TodayCard
				priorOvernightSleep={s.priorOvernightSleep}
				dayTotals={s.dayTotals}
				todaySleeps={s.todaySleeps}
				{prediction}
				{activeSleep}
			/>
		{/if}

		<!-- Summary stats — tap to toggle the detailed I dag panel above. -->
		<button
			type="button"
			class="summary-row"
			class:summary-row-expanded={summaryExpanded}
			aria-expanded={summaryExpanded}
			data-testid="summary-row"
			onclick={() => (summaryExpanded = !summaryExpanded)}
		>
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
			{#if trackDiaper}
				<span class="summary-sep">·</span>
				<span>
					<span class="stat-value">{s.diaperCount}</span>
					<span class="summary-label">{pottyMode ? 'dobesøk' : (s.diaperCount === 1 ? 'bleie' : 'bleier')}</span>
				</span>
			{/if}
		</button>
	</div>

	<!-- Modals -->
	{#if showTagSheet}
		<TagSheet
			sleepDomainId={tagSheetSleepId}
			startTime={tagSheetStartTime}
			lastDiaperTime={s.lastDiaperTime}
			{pottyMode}
			{trackDiaper}
			{baby}
			offDays={s.offDays}
			onClose={onTagSheetClose}
			onOpenDiaper={onTagSheetOpenDiaper}
		/>
	{/if}

	{#if showWakeUpSheet && wakeUpSnapshot}
		<WakeUpSheet
			sleepDomainId={wakeUpSleepId}
			sleepSnapshot={wakeUpSnapshot}
			closingStale={wakeUpClosingStale}
			{baby}
			offDays={s.offDays}
			todaySleeps={s.todaySleeps}
			onClose={onWakeUpClose}
		/>
	{/if}

	{#if confirmDiscardStale}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="modal-overlay" onclick={() => (confirmDiscardStale = false)} data-testid="stale-discard-overlay" style="z-index: 1001;">
			<div class="morning-prompt" style="position: relative; max-width: 320px; margin: 25vh auto;" role="presentation" onclick={(e) => e.stopPropagation()}>
				<p style="margin-bottom: 16px;">Forkasta denne uavslutta økta? Vil du heller ta vare på henne, kan du registrere henne manuelt i loggen.</p>
				<div style="display: flex; gap: 8px;">
					<button class="btn btn-ghost" onclick={() => (confirmDiscardStale = false)} disabled={staleBusy}>Avbryt</button>
					<button class="btn btn-danger" onclick={discardStaleSleep} disabled={staleBusy} data-testid="stale-discard-confirm">Forkast</button>
				</div>
			</div>
		</div>
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
			onAddWaking={() => {
				addingWakingForNight = editingSleep;
				editingSleep = null;
			}}
		/>
	{/if}

	{#if editingNightWaking}
		<NightWakingEditSheet
			waking={editingNightWaking}
			onClose={() => (editingNightWakingId = null)}
			onDeleted={() => (editingNightWakingId = null)}
		/>
	{/if}

	{#if addingWakingForNight && baby}
		<NightWakingEditSheet
			create={{ babyId: baby.id, defaultStart: addingWakingForNight.start_time }}
			onClose={() => (addingWakingForNight = null)}
			onDeleted={() => (addingWakingForNight = null)}
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
