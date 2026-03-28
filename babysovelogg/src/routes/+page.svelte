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
		undoTimer = setTimeout(() => { undoToast = null; }, 5000);
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
		const h = new Date().getHours();
		// Stay night while active night sleep (even after 06:00)
		const activeNight = activeSleep && !activeSleep.end_time && activeSleep.type === 'night';
		return activeNight || h < 6 || h >= 18;
	});

	// Apply theme based on night mode (keeps layout theme in sync with dashboard state)
	$effect(() => {
		const mode = isNightMode ? 'night' : 'day';
		document.documentElement.setAttribute('data-theme', mode);
	});

	// Morning button visible at 4-5 AM (late night / early morning)
	const showMorningButton = $derived.by(() => {
		if (!baby || activeSleep) return false;
		const h = new Date().getHours();
		return h >= 4 && h < 6;
	});

	// Redirect to settings when no baby exists
	$effect(() => {
		if (loaded && !baby) {
			goto('/settings');
		}
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
		prediction
			? {
					nextNap: prediction.nextNap,
					bedtime: prediction.bedtime,
					predictedNaps: prediction.predictedNaps ?? undefined,
				}
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
			// Night: end = expected wake-up (use 07:00 as default or prediction)
			return null; // Will show ☀️ icon
		}
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

	/** Arc start endpoint click: open the relevant sleep for editing */
	function onArcStartClick() {
		if (isNightMode) {
			// Night mode start = bedtime → open active or last night sleep
			const target = activeSleep ?? todaySleeps.toReversed().find(sl => sl.type === 'night');
			if (target) editingSleep = target;
		} else {
			// Day mode start = wakeup → open last night sleep that ended this morning
			const nightSleep = todaySleeps.toReversed().find(sl => sl.type === 'night');
			if (nightSleep) editingSleep = nightSleep;
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

	// --- Morning prompt ---
	// Shows when baby exists, no todayWakeUp, and it's morning (5-12)
	const needsMorningPrompt = $derived.by(() => {
		if (!baby || todayWakeUp) return false;
		// Don't show while there's an active sleep (baby still sleeping)
		if (activeSleep && !activeSleep.end_time) return false;
		// If there are already sleeps today, skip prompt (wakeup was implicit)
		if (todaySleeps.length > 0) return false;
		const h = new Date().getHours();
		return h >= 5 && h < 13;
	});

	let morningDate = $state('');
	let morningTime = $state('07:00');
	let morningBusy = $state(false);

	$effect(() => {
		// Pre-fill date with today
		morningDate = new Date().toISOString().split('T')[0];
	});

	async function setMorningWakeTime() {
		if (morningBusy || !baby) return;
		morningBusy = true;
		try {
			const wakeTime = new Date(`${morningDate}T${morningTime}:00`).toISOString();
			const event = {
				type: 'day.started',
				payload: { babyId: baby.id, date: morningDate, wakeTime },
			};
			await sync.sendEvents([event]);
		} finally {
			morningBusy = false;
		}
	}

	async function skipMorningWakeTime() {
		if (morningBusy || !baby) return;
		morningBusy = true;
		try {
			const today = new Date();
			today.setHours(6, 0, 0, 0);
			const dateStr = today.toISOString().split('T')[0];
			const event = {
				type: 'day.started',
				payload: { babyId: baby.id, date: dateStr, wakeTime: today.toISOString() },
			};
			await sync.sendEvents([event]);
		} finally {
			morningBusy = false;
		}
	}

	function triggerMorning() {
		// Force the morning prompt to show by scrolling to top
		// The morning button acts as a shortcut for the morning workflow
		window.scrollTo({ top: 0, behavior: 'smooth' });
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
					<input type="date" bind:value={morningDate} />
					<input type="time" bind:value={morningTime} />
				</div>
				<div style="display: flex; gap: 8px;">
					<button class="btn btn-primary" onclick={setMorningWakeTime} disabled={morningBusy}>
						Sett vaknetid
					</button>
					<button class="btn btn-ghost" onclick={skipMorningWakeTime} disabled={morningBusy}>
						Hopp over
					</button>
				</div>
			</div>
		{/if}

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
				onSleepClick={onArcBubbleClick}
				onStartClick={onArcStartClick}
				onEndClick={onArcEndClick}
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
			{#if showMorningButton}
				<button class="arc-action-btn morning" onclick={triggerMorning}>
					☀️ Morgon
				</button>
			{/if}
			<button class="arc-action-btn diaper" onclick={openDiaper} data-testid="fab">
				{pottyMode ? '🚽 Do' : '🧷 Bleie'}
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

	<!-- Undo toast -->
	{#if undoToast}
		<div class="undo-toast">
			<span>{undoToast.message}</span>
			<button class="btn btn-ghost" onclick={handleUndo}>Angre</button>
		</div>
	{/if}
{/if}
