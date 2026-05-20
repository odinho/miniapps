<script lang="ts">
	import { goto } from '$app/navigation';
	import { appState } from '$lib/stores/app.svelte.js';
	import { sync } from '$lib/stores/sync.svelte.js';
	import {
		NAP_OPTIONS,
		POTTY_OPTIONS,
		buildBabyEvent,
		validateSettings,
	} from '$lib/settings-utils.js';
	import DateInput from '$lib/components/DateInput.svelte';
	import TimeInput from '$lib/components/TimeInput.svelte';
	import {
		isSupported as isNotifSupported,
		getStatus as getNotifStatus,
		subscribe as subscribeNotif,
		unsubscribe as unsubscribeNotif,
		sendTest as sendTestNotif,
		getPrefs as getNotifPrefs,
		setPrefs as setNotifPrefs,
		TRIGGER_LABELS,
		type NotificationStatus,
		type NotificationKind,
		type NotificationPrefs,
	} from '$lib/notifications.js';

	// --- derived state ---
	const s = $derived(appState.state);
	const baby = $derived(s.baby);
	const isOnboarding = $derived(!baby);

	// --- form state (initialized via $effect below) ---
	let name = $state('');
	let birthdate = $state('');
	let selectedNapCount = $state<number | null>(null);
	let pottyEnabled = $state(false);
	let targetBedtime = $state<string | null>(null);
	let bedtimeEnabled = $state(false);
	let nameError = $state(false);
	let dateError = $state(false);
	let saving = $state(false);
	let toast = $state<{ text: string; type: 'success' | 'error' | 'warning' } | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | null = null;

	// Keep form in sync when baby data changes (e.g. after SSE update)
	$effect(() => {
		if (baby) {
			name = baby.name;
			birthdate = baby.birthdate;
			selectedNapCount = baby.custom_nap_count;
			pottyEnabled = baby.potty_mode === 1;
			targetBedtime = baby.target_bedtime;
			bedtimeEnabled = !!baby.target_bedtime;
		}
	});

	// --- import state ---
	let importFile = $state<File | null>(null);
	let importing = $state(false);

	// --- notifications state ---
	let notifStatus = $state<NotificationStatus>('unsupported');
	let notifBusy = $state(false);
	let notifPrefs = $state<NotificationPrefs | null>(null);
	let notifKinds = $state<NotificationKind[]>([]);

	async function refreshNotifStatus() {
		notifStatus = await getNotifStatus();
	}

	async function loadPrefs() {
		const res = await getNotifPrefs();
		if (res) {
			notifPrefs = res.prefs;
			notifKinds = res.kinds;
		}
	}

	$effect(() => {
		if (isNotifSupported()) refreshNotifStatus();
		if (baby) loadPrefs();
	});

	async function onPrefToggle(kind: NotificationKind) {
		if (!notifPrefs) return;
		const previous = notifPrefs;
		const next = !notifPrefs[kind];
		// Optimistic update
		notifPrefs = { ...notifPrefs, [kind]: next };
		const result = await setNotifPrefs({ [kind]: next });
		if (result) {
			notifPrefs = result;
		} else {
			// Roll back on server failure so the UI doesn't drift from server truth.
			notifPrefs = previous;
			showToast('Kunne ikkje lagra valet', 'error');
		}
	}

	async function onNotifToggle() {
		if (notifBusy) return;
		notifBusy = true;
		try {
			if (notifStatus === 'subscribed') {
				await unsubscribeNotif();
				showToast('Varsel slått av', 'success');
			} else {
				const res = await subscribeNotif();
				if (res.ok) {
					showToast('Varsel slått på', 'success');
				} else if (res.error === 'permission_denied') {
					showToast('Du må tillate varsel i nettlesaren', 'warning');
				} else {
					showToast('Kunne ikkje slå på varsel', 'error');
				}
			}
			await refreshNotifStatus();
		} finally {
			notifBusy = false;
		}
	}

	async function onNotifTest() {
		if (notifBusy) return;
		notifBusy = true;
		try {
			const result = await sendTestNotif();
			if (result.ok) {
				showToast('Test sendt', 'success');
			} else if (result.error === 'no_active_subscriptions') {
				showToast('Ingen aktive varselabonnement', 'warning');
			} else {
				showToast('Kunne ikkje senda test', 'error');
			}
		} finally {
			notifBusy = false;
		}
	}

	// --- actions ---
	function showToast(text: string, type: 'success' | 'error' | 'warning') {
		toast = { text, type };
		if (toastTimer) clearTimeout(toastTimer);
		toastTimer = setTimeout(() => {
			toast = null;
			toastTimer = null;
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
				targetBedtime: bedtimeEnabled ? (targetBedtime || '19:00') : null,
			},
			isOnboarding,
		);

		try {
			const sendResult = await sync.sendEvents([event]);
			if (sendResult == null) {
				showToast(appState.error ?? 'Feil ved lagring', 'error');
				return;
			}
			goto('/');
		} catch (err) {
			showToast(`Feil ved lagring: ${err instanceof Error ? err.message : 'ukjend feil'}`, 'error');
		} finally {
			saving = false;
		}
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
				`Importerte ${result.sleeps} søvnøkter`,
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
			<DateInput
				bind:value={birthdate}
				data-testid="baby-date"
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

			<!-- Target bedtime -->
			<div class="form-group">
				<span class="form-label">Mål-leggetid</span>
				<div style="font-size: 0.75rem; color: var(--text-light); margin-bottom: 8px;">
					Set ein fast leggetid for bakoverplanlegging av lurar. Auto følgjer babyen sin rytme.
				</div>
				<div class="type-pills">
					<button
						class="type-pill"
						class:active={!bedtimeEnabled}
						onclick={() => { bedtimeEnabled = false; targetBedtime = null; }}
					>
						Auto
					</button>
					<button
						class="type-pill"
						class:active={bedtimeEnabled}
						onclick={() => { bedtimeEnabled = true; targetBedtime = targetBedtime || '19:00'; }}
						data-testid="bedtime-custom"
					>
						Fast tid
					</button>
				</div>
				{#if bedtimeEnabled && targetBedtime != null}
					<div style="margin-top: 8px; display: flex; justify-content: center;">
						<TimeInput bind:value={targetBedtime} data-testid="target-bedtime" />
					</div>
				{/if}
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

		<!-- Notifications (only when baby exists) -->
		{#if baby}
			<div
				style="margin-top: 32px; border-top: 1px solid var(--cream-dark); padding-top: 24px;"
				data-testid="notifications-section"
			>
				<h2 style="font-size: 1.1rem; margin-bottom: 8px;">Varsel</h2>
				<div style="font-size: 0.85rem; color: var(--text-light); margin-bottom: 12px;">
					Få varsel på telefonen når reddingslurar bør endast i lett fase.
				</div>
				{#if notifStatus === 'unsupported'}
					<div style="font-size: 0.85rem; color: var(--text-light);">
						Nettlesaren støttar ikkje varsel.
					</div>
				{:else if notifStatus === 'permission-denied'}
					<div style="font-size: 0.85rem; color: var(--danger-dark);">
						Varsel er blokkert i nettlesaren. Endra i nettstadinnstillingane for å slå på.
					</div>
				{:else}
					<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
						<button
							class="btn {notifStatus === 'subscribed' ? 'btn-ghost' : 'btn-primary'}"
							onclick={onNotifToggle}
							disabled={notifBusy}
							data-testid="notif-toggle"
						>
							{notifStatus === 'subscribed' ? 'Slå av varsel' : 'Slå på varsel'}
						</button>
						{#if notifStatus === 'subscribed'}
							<button
								class="btn btn-ghost"
								onclick={onNotifTest}
								disabled={notifBusy}
								data-testid="notif-test"
							>
								Send test
							</button>
						{/if}
					</div>

					{#if notifPrefs && notifKinds.length > 0}
						<div class="notif-prefs" data-testid="notif-prefs">
							{#each notifKinds as kind}
								<label class="notif-pref" class:on={notifPrefs[kind]}>
									<div class="notif-pref-text">
										<div class="notif-pref-title">{TRIGGER_LABELS[kind].title}</div>
										<div class="notif-pref-hint">{TRIGGER_LABELS[kind].hint}</div>
									</div>
									<input
										type="checkbox"
										class="toggle"
										checked={notifPrefs[kind]}
										onchange={() => onPrefToggle(kind)}
										data-testid="notif-pref-{kind}"
									/>
								</label>
							{/each}
						</div>
					{/if}
				{/if}
			</div>
		{/if}

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

<style>
	.notif-prefs {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 16px;
	}

	.notif-pref {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 12px 14px;
		background: var(--white);
		border: 1px solid var(--cream-dark);
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition: border-color 0.15s ease, background-color 0.15s ease;
	}

	.notif-pref:hover {
		border-color: var(--lavender-dark);
	}

	.notif-pref.on {
		background: color-mix(in srgb, var(--lavender) 38%, var(--white));
		border-color: var(--lavender-dark);
	}

	.notif-pref-text {
		flex: 1;
		min-width: 0;
	}

	.notif-pref-title {
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--text);
		line-height: 1.25;
	}

	.notif-pref-hint {
		font-size: 0.78rem;
		color: var(--text-light);
		line-height: 1.4;
		margin-top: 3px;
	}

	/* Toggle switch — accessible <input type="checkbox"> styled as a pill. */
	.toggle {
		appearance: none;
		-webkit-appearance: none;
		flex-shrink: 0;
		width: 40px;
		height: 22px;
		margin: 0;
		padding: 0;
		border: none;
		border-radius: 999px;
		background: var(--cream-dark);
		position: relative;
		cursor: pointer;
		transition: background-color 0.2s ease;
	}

	.toggle::after {
		content: '';
		position: absolute;
		top: 2px;
		left: 2px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--white);
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
		transition: transform 0.2s ease;
	}

	.toggle:checked {
		background: var(--lavender-dark);
	}

	.toggle:checked::after {
		transform: translateX(18px);
	}

	.toggle:focus-visible {
		outline: 2px solid var(--lavender-dark);
		outline-offset: 2px;
	}
</style>
