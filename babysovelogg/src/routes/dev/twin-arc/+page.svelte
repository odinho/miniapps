<script lang="ts">
	import TwinArc from '$lib/components/TwinArc.svelte';
	import { getDayArcConfig, getNightArcConfig, unionArcConfig } from '$lib/arc-utils.js';
	import type { ArcProps } from '$lib/arc-props.js';

	// Deterministic local-midnight base so Playwright snapshots are stable.
	const today = new Date(2026, 5, 14, 0, 0, 0, 0);
	const baseMs = today.getTime();
	const iso = (h: number, m = 0) => new Date(baseMs + h * 3600_000 + m * 60_000).toISOString();

	const blank = {
		napConfidenceBands: [],
		activeWakeAt: null,
		activeWakeBand: null,
		skippedNap: null,
		rescueWindow: null,
		nightWakings: [],
	};

	// --- Day scenario: both twins awake, mid-afternoon ---
	const dayA: ArcProps = {
		isNightMode: false,
		todaySleeps: [
			{ start_time: iso(9, 0), end_time: iso(10, 15), type: 'nap' },
			{ start_time: iso(13, 0), end_time: iso(14, 30), type: 'nap' },
		],
		activeSleep: null,
		prediction: { nextNap: iso(16, 30), bedtime: iso(19, 0), predictedNaps: [{ startTime: iso(16, 30), endTime: iso(17, 15) }] },
		wakeUpTime: iso(6, 30),
		bedtime: iso(19, 0),
		nightEnd: null,
		startTimeLabel: '06:30',
		endTimeLabel: '19:00',
		...blank,
	};
	const dayB: ArcProps = {
		isNightMode: false,
		todaySleeps: [{ start_time: iso(9, 45), end_time: iso(11, 0), type: 'nap' }],
		activeSleep: { start_time: iso(14, 0), type: 'nap' },
		prediction: { nextNap: iso(17, 0), bedtime: iso(19, 30) },
		wakeUpTime: iso(7, 15),
		bedtime: iso(19, 30),
		nightEnd: null,
		startTimeLabel: '07:15',
		endTimeLabel: '19:30',
		activeWakeAt: iso(15, 15),
		napConfidenceBands: [],
		activeWakeBand: null,
		skippedNap: null,
		rescueWindow: null,
		nightWakings: [],
	};
	const dayConfig = unionArcConfig(
		getDayArcConfig(dayA.wakeUpTime, dayA.bedtime, undefined, 'Europe/Oslo'),
		getDayArcConfig(dayB.wakeUpTime, dayB.bedtime, undefined, 'Europe/Oslo'),
	);
	const dayNow = baseMs + 14 * 3600_000 + 40 * 60_000;

	// --- Night scenario: both in night sleep, with a waking ---
	const nightA: ArcProps = {
		isNightMode: true,
		todaySleeps: [],
		activeSleep: { start_time: iso(19, 30), type: 'night' },
		prediction: { nextNap: iso(30, 0), bedtime: iso(19, 30) },
		wakeUpTime: null,
		bedtime: iso(19, 30),
		nightEnd: iso(30, 15),
		startTimeLabel: '19:30',
		endTimeLabel: '06:15',
		activeWakeAt: iso(30, 15),
		napConfidenceBands: [],
		activeWakeBand: null,
		skippedNap: null,
		rescueWindow: null,
		nightWakings: [],
	};
	const nightB: ArcProps = {
		isNightMode: true,
		todaySleeps: [],
		activeSleep: { start_time: iso(20, 15), type: 'night' },
		prediction: { nextNap: iso(29, 30), bedtime: iso(20, 15) },
		wakeUpTime: null,
		bedtime: iso(20, 15),
		nightEnd: iso(29, 30),
		startTimeLabel: '20:15',
		endTimeLabel: '05:30',
		activeWakeAt: iso(29, 30),
		napConfidenceBands: [],
		activeWakeBand: null,
		skippedNap: null,
		rescueWindow: null,
		nightWakings: [{ startTime: iso(25, 0), endTime: iso(25, 20), domainId: 'w1' }],
	};
	const nightConfig = unionArcConfig(
		getNightArcConfig(nightA.bedtime, nightA.nightEnd, undefined, 'Europe/Oslo'),
		getNightArcConfig(nightB.bedtime, nightB.nightEnd, undefined, 'Europe/Oslo'),
	);
	const nightNow = baseMs + 26 * 3600_000;
</script>

<div class="wrap">
	<div class="scene-card" data-testid="twin-scene-day">
		<h2>Tvilling — dag (begge vakne)</h2>
		<TwinArc a={dayA} b={dayB} config={dayConfig} nowMs={dayNow} nameA="Aud" nameB="Bjørn" />
	</div>
	<div class="scene-card" data-testid="twin-scene-night">
		<h2>Tvilling — natt (begge søv)</h2>
		<TwinArc a={nightA} b={nightB} config={nightConfig} nowMs={nightNow} nameA="Aud" nameB="Bjørn" />
	</div>
</div>

<style>
	.wrap {
		display: flex;
		flex-wrap: wrap;
		gap: 24px;
		padding: 24px;
		background: var(--bg);
	}
	.scene-card {
		width: 340px;
		background: var(--cream);
		border: 1px solid var(--cream-dark);
		border-radius: 20px;
		padding: 16px;
	}
	h2 {
		font-size: 1rem;
		text-align: center;
		margin: 0 0 8px;
	}
</style>
