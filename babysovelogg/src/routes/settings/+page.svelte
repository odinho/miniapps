<script lang="ts">
	import { goto } from '$app/navigation';
	import { appState } from '$lib/stores/app.svelte.js';
	import { sync } from '$lib/stores/sync.svelte.js';
	import { calculateAgeMonths } from '$lib/engine/schedule.js';
	import {
		NAP_OPTIONS,
		POTTY_OPTIONS,
		buildBabyEvent,
		validateSettings,
		buildSleepInfoRows,
		buildPredictionRows,
		getNextSleepMilestone,
		formatAge,
	} from '$lib/settings-utils.js';

	// --- derived state ---
	const s = $derived(appState.state);
	const baby = $derived(s.baby);
	const isOnboarding = $derived(!baby);

	// --- form state (initialized via $effect below) ---
	let name = $state('');
	let birthdate = $state('');
	let selectedNapCount = $state<number | null>(null);
	let pottyEnabled = $state(false);
	let nameError = $state(false);
	let dateError = $state(false);
	let saving = $state(false);
	let toast = $state<{ text: string; type: 'success' | 'error' | 'warning' } | null>(null);

	// Keep form in sync when baby data changes (e.g. after SSE update)
	$effect(() => {
		if (baby) {
			name = baby.name;
			birthdate = baby.birthdate;
			selectedNapCount = baby.custom_nap_count;
			pottyEnabled = baby.potty_mode === 1;
		}
	});

	// --- computed ---
	const ageMonths = $derived(baby ? calculateAgeMonths(baby.birthdate) : 0);
	const sleepInfoRows = $derived(baby ? buildSleepInfoRows(ageMonths) : []);
	const nextMilestone = $derived(baby ? getNextSleepMilestone(ageMonths) : null);

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

	// --- import state ---
	let importFile = $state<File | null>(null);
	let importing = $state(false);

	// --- actions ---
	function showToast(text: string, type: 'success' | 'error' | 'warning') {
		toast = { text, type };
		setTimeout(() => {
			toast = null;
		}, 3000);
	}

	async function save() {
		const result = validateSettings(name, birthdate);
		nameError = result.nameError;
		dateError = result.dateError;
		if (!result.valid) {
			showToast(result.message!, 'error');
			return;
		}

		saving = true;
		const event = buildBabyEvent(
			{
				name: name.trim(),
				birthdate,
				customNapCount: selectedNapCount,
				pottyMode: pottyEnabled,
			},
			isOnboarding,
		);

		try {
			await sync.sendEvents([event]);
		} catch (err) {
			showToast(`Feil ved lagring: ${err instanceof Error ? err.message : 'ukjend feil'}`, 'error');
		} finally {
			saving = false;
		}

		goto('/');
	}

	function onFileChange(e: Event) {
		const input = e.target as HTMLInputElement;
		importFile = input.files?.[0] ?? null;
	}

	async function importNapper() {
		if (!importFile) return;
		importing = true;
		try {
			const csvText = await importFile.text();
			const res = await fetch('/api/import/napper', {
				method: 'POST',
				headers: { 'Content-Type': 'text/csv' },
				body: csvText,
			});
			const result = await res.json();
			if (!res.ok) {
				showToast(result.error || 'Import feila', 'error');
				return;
			}
			showToast(
				`Importerte ${result.sleeps} søvnøkter og ${result.dayStarts} vekkingar`,
				'success',
			);
			// Re-fetch state after import
			await sync.init();
		} catch {
			showToast('Import feila — sjekk fila og prøv igjen', 'error');
		} finally {
			importing = false;
		}
	}
</script>

<div class="view">
	<div class="settings">
		{#if isOnboarding}
			<div class="onboarding-icon">👶</div>
			<h1>Velkomen til Babysovelogg</h1>
			<p style="color: var(--text-light); margin-bottom: 24px;">
				Fortel oss om den vesle, så kjem me i gang.
			</p>
		{:else}
			<h1>Innstillingar</h1>
		{/if}

		<!-- Baby name -->
		<div class="form-group">
			<label for="baby-name">Namn</label>
			<input
				id="baby-name"
				type="text"
				placeholder="Namn på babyen"
				bind:value={name}
				style:border-color={nameError ? 'var(--danger)' : ''}
			/>
		</div>

		<!-- Birth date -->
		<div class="form-group">
			<label for="baby-date">Termindato</label>
			<input
				id="baby-date"
				type="date"
				bind:value={birthdate}
				style:border-color={dateError ? 'var(--danger)' : ''}
			/>
			<div style="font-size: 0.75rem; color: var(--text-light); margin-top: 4px;">
				Brukt for å rekna ut søvnbehov etter alder
			</div>
		</div>

		<!-- Nap count pills (only when baby exists) -->
		{#if baby}
			<div class="form-group">
				<span class="form-label">Tal lurar per dag</span>
				<div style="font-size: 0.75rem; color: var(--text-light); margin-bottom: 8px;">
					Overstyrer aldersbasert tal. Auto brukar standard for alderen.
				</div>
				<div class="type-pills">
					{#each NAP_OPTIONS as opt}
						<button
							class="type-pill"
							class:active={selectedNapCount === opt.value}
							onclick={() => (selectedNapCount = opt.value)}
						>
							{opt.label}
						</button>
					{/each}
				</div>
			</div>

			<!-- Potty mode toggle -->
			<div class="form-group">
				<span class="form-label">Bleie / potte</span>
				<div class="type-pills">
					{#each POTTY_OPTIONS as opt}
						<button
							class="type-pill"
							class:active={pottyEnabled === opt.value}
							onclick={() => (pottyEnabled = opt.value)}
						>
							{opt.label}
						</button>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Save button -->
		<div style="margin-top: 24px;">
			<button class="btn btn-primary" onclick={save} disabled={saving}>
				{isOnboarding ? 'Kom i gang ✨' : 'Lagra'}
			</button>
		</div>

		<!-- Napper import section (only when baby exists) -->
		{#if baby}
			<div
				style="margin-top: 32px; border-top: 1px solid var(--cream-dark); padding-top: 24px;"
			>
				<h2 style="font-size: 1.1rem; margin-bottom: 8px;">Importer frå Napper</h2>
				<div style="font-size: 0.85rem; color: var(--text-light); margin-bottom: 12px;">
					Last opp ei CSV-fil eksportert frå Napper-appen.
				</div>
				<div style="display: flex; gap: 8px; align-items: center;">
					<input
						type="file"
						accept=".csv"
						data-testid="napper-file-input"
						onchange={onFileChange}
					/>
					<button
						class="btn btn-primary"
						data-testid="napper-import-btn"
						disabled={!importFile || importing}
						onclick={importNapper}
					>
						{importing ? 'Importerer...' : 'Importer'}
					</button>
				</div>
			</div>

			<!-- Sleep info panel -->
			<div
				style="margin-top: 32px; border-top: 1px solid var(--cream-dark); padding-top: 24px;"
			>
				<h2 style="font-size: 1.1rem; margin-bottom: 16px;">
					Søvninfo for {formatAge(baby.birthdate)}
				</h2>

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

				<!-- Reactive prediction panel -->
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

		<!-- App footer -->
		<div
			style="margin-top: 32px; text-align: center; color: var(--text-light); font-size: 0.75rem;"
		>
			<div>Babysovelogg v{__APP_VERSION__}</div>
			<div style="margin-top: 4px;">Søvnsporing for den vesle</div>
		</div>
	</div>
</div>

<!-- Toast -->
{#if toast}
	<div
		class="toast"
		class:toast-success={toast.type === 'success'}
		class:toast-error={toast.type === 'error'}
		class:toast-warning={toast.type === 'warning'}
	>
		{toast.text}
	</div>
{/if}
