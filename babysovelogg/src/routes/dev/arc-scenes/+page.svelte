<script lang="ts">
	import Arc from '$lib/components/Arc.svelte';
	import { formatTime } from '$lib/utils.js';

	// Focused snapshot page: 8 canonical arc scenes on a deterministic local
	// clock so Playwright `toHaveScreenshot()` is stable. Each card has a
	// stable testid the e2e test asserts on individually — one screenshot
	// per scene keeps diffs scoped instead of a single big page snapshot.
	//
	// Scenes mirror the unit tests in tests/unit/arc-scene.unit.ts and add a
	// few visual-only cases (bubble stacking, label baseline, glow rendering)
	// that wouldn't show up in object-level assertions.
	//
	// To regenerate baselines after an intentional visual change:
	//   bunx playwright test arc-scenes --update-snapshots

	// Anchor everything to a FIXED local date at midnight, then pick an explicit
	// hour-of-day per scene. Each scene also passes an explicit `nowMs`, so the
	// rendered arcs are fully deterministic — independent of the real wall clock
	// (X-3). A fixed local-midnight date keeps the night arc's local-hour
	// wrapping correct in the server TZ while never drifting between runs.
	const today = new Date(2026, 5, 14, 0, 0, 0, 0); // 2026-06-14 local midnight
	const baseMs = today.getTime();
	const iso = (h: number, m = 0) => new Date(baseMs + h * 3600_000 + m * 60_000).toISOString();
	const hm = (h: number, m = 0) => formatTime(iso(h, m));

	type ArcProps = {
		todaySleeps: Array<{ start_time: string; end_time: string | null; type: 'nap' | 'night' }>;
		activeSleep: {
			start_time: string;
			type: 'nap' | 'night';
			isPaused?: boolean;
			pauseTime?: string;
		} | null;
		prediction: {
			nextNap: string;
			bedtime?: string;
			predictedNaps?: Array<{ startTime: string; endTime: string }>;
		} | null;
		isNightMode: boolean;
		wakeUpTime?: string | null;
		bedtime?: string | null;
		nightEnd?: string | null;
		startTimeLabel?: string | null;
		endTimeLabel?: string | null;
		napConfidenceBands?: Array<{ lo: string; hi: string }>;
		activeWakeAt?: string | null;
		activeWakeBand?: { lo: string; hi: string } | null;
		skippedNap?: { plannedAt: string } | null;
		rescueWindow?: { earliest: string; latest: string } | null;
		nowMs?: number;
	};

	type Scene = {
		id: string;
		title: string;
		caption: string;
		nowH: number;
		nowM?: number;
		props: ArcProps;
	};

	const scenes: Scene[] = [
		{
			id: 'active-night-13min',
			title: 'Aktiv natt — 13 min inn',
			caption: 'Dot-anker, månefarga vakeband, marker undertrykt (label = endepunkt)',
			nowH: 18,
			nowM: 43,
			props: {
				todaySleeps: [],
				activeSleep: { start_time: iso(18, 30), type: 'night' },
				prediction: null,
				isNightMode: true,
				bedtime: iso(18, 30),
				nightEnd: iso(29, 49),
				startTimeLabel: hm(18, 30),
				endTimeLabel: hm(29, 49),
				activeWakeAt: iso(29, 49),
				activeWakeBand: { lo: iso(29, 30), hi: iso(30, 10) },
				nowMs: baseMs + 18 * 3600_000 + 43 * 60_000,
			},
		},
		{
			id: 'active-nap-mid',
			title: 'Aktiv lur — midt i syklus',
			caption: 'Sti-boble, fersken vakeband, vakemarkør synleg',
			nowH: 13,
			nowM: 30,
			props: {
				todaySleeps: [{ start_time: iso(9, 0), end_time: iso(10, 15), type: 'nap' }],
				activeSleep: { start_time: iso(12, 30), type: 'nap' },
				prediction: null,
				isNightMode: false,
				wakeUpTime: iso(7, 0),
				bedtime: iso(19, 0),
				startTimeLabel: hm(7, 0),
				endTimeLabel: hm(19, 0),
				activeWakeAt: iso(14, 0),
				activeWakeBand: { lo: iso(13, 45), hi: iso(14, 15) },
				nowMs: baseMs + 13 * 3600_000 + 30 * 60_000,
			},
		},
		{
			id: 'overrun-past-wake',
			title: 'Overtid — forbi forventa vake',
			caption: 'Bobla strekker seg forbi planlagt vake, band framleis synleg',
			nowH: 13,
			nowM: 30,
			props: {
				todaySleeps: [],
				activeSleep: { start_time: iso(12, 0), type: 'nap' },
				prediction: null,
				isNightMode: false,
				wakeUpTime: iso(7, 0),
				bedtime: iso(19, 0),
				startTimeLabel: hm(7, 0),
				endTimeLabel: hm(19, 0),
				activeWakeAt: iso(13, 0),
				activeWakeBand: { lo: iso(12, 45), hi: iso(13, 15) },
				nowMs: baseMs + 13 * 3600_000 + 30 * 60_000,
			},
		},
		{
			id: 'skipped-with-rescue',
			title: 'Hoppa lur + kort ekstralur',
			caption: 'Strikethrough-blob + soft rescue-blob, ortogonale meldingar',
			nowH: 11,
			props: {
				todaySleeps: [],
				activeSleep: null,
				prediction: { nextNap: iso(19, 0), bedtime: iso(19, 0) },
				isNightMode: false,
				wakeUpTime: iso(7, 0),
				bedtime: iso(19, 0),
				startTimeLabel: hm(7, 0),
				endTimeLabel: hm(19, 0),
				skippedNap: { plannedAt: iso(9, 30) },
				rescueWindow: { earliest: iso(11, 30), latest: iso(12, 30) },
				nowMs: baseMs + 11 * 3600_000,
			},
		},
		{
			id: 'two-naps-with-bands',
			title: 'To planlagde lurar med konfidensband',
			caption: 'Predicted-boble + ±20 min band, ein i fortid (skjult)',
			nowH: 11,
			props: {
				todaySleeps: [{ start_time: iso(8, 0), end_time: iso(9, 15), type: 'nap' }],
				activeSleep: null,
				prediction: {
					nextNap: iso(12, 30),
					bedtime: iso(19, 0),
					predictedNaps: [
						{ startTime: iso(12, 30), endTime: iso(14, 0) },
						{ startTime: iso(15, 30), endTime: iso(16, 30) },
					],
				},
				isNightMode: false,
				wakeUpTime: iso(7, 0),
				bedtime: iso(19, 0),
				startTimeLabel: hm(7, 0),
				endTimeLabel: hm(19, 0),
				napConfidenceBands: [
					{ lo: iso(12, 10), hi: iso(12, 50) },
					{ lo: iso(15, 10), hi: iso(15, 50) },
				],
				nowMs: baseMs + 11 * 3600_000,
			},
		},
		{
			id: 'morning-empty',
			title: 'Morgon — ingen lurar enno',
			caption: 'Tom dagboge med oppvakning-endepunkt',
			nowH: 8,
			props: {
				todaySleeps: [],
				activeSleep: null,
				prediction: { nextNap: iso(10, 0), bedtime: iso(19, 0) },
				isNightMode: false,
				wakeUpTime: iso(7, 0),
				bedtime: iso(19, 0),
				startTimeLabel: hm(7, 0),
				endTimeLabel: hm(19, 0),
				nowMs: baseMs + 8 * 3600_000,
			},
		},
		{
			id: 'after-bedtime',
			title: 'Etter leggetid',
			caption: 'Dagboge nær slutten, nextNap kollapsa til bedtime',
			nowH: 18,
			nowM: 30,
			props: {
				todaySleeps: [
					{ start_time: iso(9, 30), end_time: iso(11, 0), type: 'nap' },
					{ start_time: iso(13, 0), end_time: iso(14, 30), type: 'nap' },
				],
				activeSleep: null,
				prediction: { nextNap: iso(18, 0), bedtime: iso(18, 0) },
				isNightMode: false,
				wakeUpTime: iso(7, 0),
				bedtime: iso(19, 0),
				startTimeLabel: hm(7, 0),
				endTimeLabel: hm(19, 0),
				nowMs: baseMs + 18 * 3600_000 + 30 * 60_000,
			},
		},
		{
			id: 'active-nap-paused',
			title: 'Lur på pause',
			caption: 'Bobla stoppar ved pauseTime, ikkje "no"',
			nowH: 13,
			props: {
				todaySleeps: [],
				activeSleep: {
					start_time: iso(12, 0),
					type: 'nap',
					isPaused: true,
					pauseTime: iso(12, 45),
				},
				prediction: null,
				isNightMode: false,
				wakeUpTime: iso(7, 0),
				bedtime: iso(19, 0),
				startTimeLabel: hm(7, 0),
				endTimeLabel: hm(19, 0),
				activeWakeAt: iso(13, 30),
				activeWakeBand: { lo: iso(13, 15), hi: iso(13, 45) },
				nowMs: baseMs + 13 * 3600_000,
			},
		},
		{
			id: 'night-past-wake',
			title: 'Natt — sove forbi forventa vake',
			caption: 'Arc utvidar seg til no, sol-ikon glir opp til forventa vake',
			nowH: 31,
			nowM: 30,
			props: {
				// 2h 30m overrun (planned wake 06:00, now 07:30). Snapshot keeps
				// the slide visually obvious — a small 30-min overrun shifted
				// the icon by ~17 px and wasn't strong enough to guard slide
				// distance.
				todaySleeps: [],
				activeSleep: { start_time: iso(19, 0), type: 'night' },
				prediction: null,
				isNightMode: true,
				bedtime: iso(19, 0),
				nightEnd: iso(30, 0),
				startTimeLabel: hm(19, 0),
				endTimeLabel: hm(30, 0),
				activeWakeAt: iso(30, 0),
				activeWakeBand: { lo: iso(29, 40), hi: iso(30, 20) },
				nowMs: baseMs + 31 * 3600_000 + 30 * 60_000,
			},
		},
	];
</script>

<svelte:head>
	<title>Arc Scenes</title>
</svelte:head>

<div class="arc-scenes-page">
	<header>
		<h1>Arc-scener</h1>
		<p class="lede">
			Stabile snapshot-scener for visuell regresjonstest. Kvar boge har
			deterministisk klokke — Playwright bruker desse til kort-for-kort
			screenshots.
		</p>
	</header>

	<div class="scene-grid">
		{#each scenes as s}
			<div class="scene-card" data-testid={`arc-scene-${s.id}`}>
				<div class="scene-meta">
					<h2>{s.title}</h2>
					<p class="caption">{s.caption}</p>
				</div>
				<div class="scene-arc">
					<Arc {...s.props} />
				</div>
			</div>
		{/each}
	</div>
</div>

<style>
	:global(#app) {
		max-width: none;
		width: 100%;
	}
	:global(.nav-bar) {
		display: none;
	}
	:global(.view) {
		padding-bottom: 0;
	}

	.arc-scenes-page {
		padding: 16px;
		max-width: 1400px;
		margin: 0 auto;
		font-family: var(--font, system-ui, sans-serif);
	}

	header {
		margin-bottom: 20px;
	}

	header h1 {
		font-size: 1.4rem;
		font-weight: 700;
		margin: 0 0 6px;
	}

	.lede {
		font-size: 0.85rem;
		color: var(--text-light, #888);
		max-width: 64ch;
		margin: 0;
		line-height: 1.4;
	}

	.scene-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 16px;
	}

	.scene-card {
		border: 1px solid var(--lavender-dark, #e0dce8);
		border-radius: 12px;
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		background: var(--bg, #fff);
	}

	.scene-meta {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.scene-meta h2 {
		font-size: 0.9rem;
		font-weight: 600;
		margin: 0;
	}

	.caption {
		font-size: 0.72rem;
		color: var(--text-light, #888);
		line-height: 1.35;
		margin: 0;
	}

	.scene-arc {
		max-width: 240px;
		align-self: center;
		width: 100%;
	}
</style>
