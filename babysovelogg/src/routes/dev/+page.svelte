<script lang="ts">
	import Arc from '$lib/components/Arc.svelte';
	import Timer from '$lib/components/Timer.svelte';
	import type { Prediction } from '$lib/stores/app.svelte.js';
	import type { SleepLogRow, SleepPauseRow } from '$lib/types.js';
	import type { ConfidenceResult, NapPredictionWithRange } from '$lib/engine/confidence.js';
	import type { CalibrationReport } from '$lib/engine/calibration.js';
	import { formatTime } from '$lib/utils.js';

	// --- Global time control ---
	function defaultTime() {
		const d = new Date();
		return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
	}

	let nowStr = $state(defaultTime());

	// Playground "now" derived from the time input, using today's date
	const playgroundNow = $derived.by(() => {
		const parts = nowStr.split(':');
		const h = parseInt(parts[0] ?? '10', 10);
		const m = parseInt(parts[1] ?? '0', 10);
		const d = new Date();
		d.setHours(isNaN(h) ? 10 : h, isNaN(m) ? 0 : m, 0, 0);
		return d.getTime();
	});

	// --- Per-card tweakable state (for bedtime cards) ---
	let bdFeasible = $state(true);
	let bdTarget = $state('19:00');
	let confSD = $state(20);

	// --- Type aliases ---
	type ArcSleep = { start_time: string; end_time: string | null; type: 'nap' | 'night' };
	type ArcActive = { start_time: string; type: 'nap' | 'night'; isPaused?: boolean; pauseTime?: string } | null;
	type ArcPred = { nextNap: string; bedtime?: string; predictedNaps?: Array<{ startTime: string; endTime: string }> } | null;

	interface ScenarioCard {
		label: string;
		group: string;
		modeKind: string;
		nowMs: number;
		// Timer props
		activeSleep: SleepLogRow | null;
		prediction: Prediction | null;
		todayWakeUp: { wake_time: string } | null;
		todaySleeps: SleepLogRow[];
		targetBedtime?: string | null;
		// Arc props
		arcSleeps: ArcSleep[];
		arcActive: ArcActive;
		arcPred: ArcPred;
		arcIsNight: boolean;
		arcWakeUpTime?: string | null;
		arcStartLabel: string | null;
		arcEndLabel: string | null;
		arcBands: Array<{ lo: string; hi: string }>;
		arcActiveWakeAt?: string | null;
		arcActiveWakeBand?: { lo: string; hi: string } | null;
		arcSkippedNap?: { plannedAt: string } | null;
		arcRescueWindow?: { earliest: string; latest: string } | null;
	}

	// --- Factories ---
	function makeSleep(o: Partial<SleepLogRow> = {}): SleepLogRow {
		return {
			id: 1, baby_id: 1,
			start_time: new Date().toISOString(),
			end_time: null,
			type: 'nap',
			notes: null, mood: null, method: null,
			fall_asleep_time: null, onset_note: null,
			woke_by: null, wake_notes: null, wake_mood: null,
			deleted: 0, domain_id: 'dev-1',
			created_by_event_id: null, updated_by_event_id: null,
			...o,
		};
	}

	function makePrediction(o: Partial<Prediction> = {}): Prediction {
		return {
			strategy: 'routine_schedule',
			feasible: true,
			nextNap: null,
			bedtime: null,
			predictedNaps: null,
			expectedNapCount: 2,
			napsAllDone: false,
			expectedNapEnd: null,
			expectedNightEnd: null,
			expectedWakeRange: null,
			skippedNap: null,
			postSkipPlan: null,
			confidence: null,
			calibration: null,
			sleepWindow: null,
			sleepPressure: null,
			totalSleep24h: null,
			longestStretch: null,
			longestStretchTrend: null,
			longestStretchDetail: null,
			ageNorms: null,
			rolling: null,
			learnedSchedule: null,
			rescueNap: null,
			continuationWindow: null,
			napBudget: null,
			dailyTrendTotalMin: null,
			...o,
		};
	}

	function isoOffset(base: number, mins: number) {
		return new Date(base + mins * 60000).toISOString();
	}

	function makeCalibration(trust: CalibrationReport['trust']): CalibrationReport {
		const learned = { source: 'learned' as const, sampleCount: 28 };
		const ageDefault = { source: 'age-default' as const, sampleCount: 0 };
		const src = trust === 'age-default' ? ageDefault : learned;
		return {
			trust,
			napCount: src,
			wakeWindows: src,
			bedtimeWakeWindow: src,
			napDuration: src,
			daysWithData: trust === 'age-default' ? 0 : 14,
			completedNaps: trust === 'age-default' ? 0 : 28,
			warnings: [],
		};
	}

	function makeConfidence(sdMin: number, napStarts: string[]): ConfidenceResult {
		const napRanges: NapPredictionWithRange[] = napStarts.map((start) => ({
			startTime: start,
			endTime: new Date(new Date(start).getTime() + 90 * 60000).toISOString(),
			startRange: {
				point: start,
				lo: new Date(new Date(start).getTime() - sdMin * 60000).toISOString(),
				hi: new Date(new Date(start).getTime() + sdMin * 60000).toISOString(),
				sdMinutes: sdMin,
			},
		}));
		const bdPoint = new Date(Date.now() + 8 * 3600000).toISOString();
		return {
			napRanges,
			bedtimeRange: {
				point: bdPoint,
				lo: new Date(new Date(bdPoint).getTime() - sdMin * 60000).toISOString(),
				hi: new Date(new Date(bdPoint).getTime() + sdMin * 60000).toISOString(),
				sdMinutes: sdMin,
			},
			level: sdMin < 15 ? 'high' : sdMin < 30 ? 'medium' : 'low',
			dataPoints: 10,
		};
	}

	// --- Scenario matrix (reactive to playgroundNow and per-card tweaks) ---
	const scenarios = $derived.by((): ScenarioCard[] => {
		const n = playgroundNow;
		// Offset helper: n + minutes → ISO string
		const o = (mins: number) => new Date(n + mins * 60000).toISOString();
		const hm = (iso: string) => formatTime(iso);

		// Fixed 2am for deep-night scenario
		const twoAm = (() => { const d = new Date(); d.setHours(2, 0, 0, 0); return d.getTime(); })();

		// Fixed 21:00 for evening bedtime scenario (isEvening check in getTimerMode)
		const eveningBase = (() => { const d = new Date(); d.setHours(21, 0, 0, 0); return d.getTime(); })();
		const oe = (mins: number) => new Date(eveningBase + mins * 60000).toISOString();

		// A completed nap earlier in the day (arc background)
		const prevNap: ArcSleep = { start_time: o(-180), end_time: o(-120), type: 'nap' };

		// Helper: build a ±sd band around a point time (minutes offset from now)
		const wakeBand = (pointMins: number, sdMin: number) => ({
			lo: o(pointMins - sdMin),
			hi: o(pointMins + sdMin),
		});

		// Bedtime prediction with tweakable controls
		const bdPred = makePrediction({
			napsAllDone: true,
			bedtime: o(+90),
			nextNap: o(+90),
			feasible: bdFeasible,
			confidence: confSD > 0 ? makeConfidence(confSD, [o(+90)]) : null,
			calibration: makeCalibration('learned'),
		});

		return [
			// ─── Søver ───────────────────────────────────────────────────────
			{
				label: 'Lurar – 45 min, ingen forventa slutt',
				group: 'Søver',
				modeKind: 'sleeping',
				nowMs: n,
				activeSleep: makeSleep({ start_time: o(-45), type: 'nap' }),
				prediction: makePrediction({ nextNap: o(+90), bedtime: o(+480) }),
				todayWakeUp: { wake_time: o(-300) },
				todaySleeps: [makeSleep({ start_time: o(-45), type: 'nap' })],
				arcSleeps: [{ start_time: o(-240), end_time: o(-150), type: 'nap' }],
				arcActive: { start_time: o(-45), type: 'nap' },
				arcPred: { nextNap: o(+90), bedtime: o(+480) },
				arcIsNight: false,
				arcWakeUpTime: o(-300),
				arcStartLabel: hm(o(-300)),
				arcEndLabel: hm(o(+420)),
				arcBands: [],
			},
			{
				label: 'Lurar – nett starta, høg uvisse',
				group: 'Søver',
				modeKind: 'sleeping',
				nowMs: n,
				activeSleep: makeSleep({ start_time: o(-5), type: 'nap' }),
				prediction: makePrediction({ expectedNapEnd: o(+85), nextNap: o(+180), bedtime: o(+480) }),
				todayWakeUp: { wake_time: o(-90) },
				todaySleeps: [makeSleep({ start_time: o(-5), type: 'nap' })],
				arcSleeps: [prevNap],
				arcActive: { start_time: o(-5), type: 'nap' },
				arcPred: null,
				arcIsNight: false,
				arcStartLabel: hm(o(-90)),
				arcEndLabel: hm(o(+480)),
				arcBands: [],
				arcActiveWakeAt: o(+85),
				arcActiveWakeBand: wakeBand(+85, 25),
			},
			{
				label: 'Lurar – vaknar om 15 min',
				group: 'Søver',
				modeKind: 'sleeping',
				nowMs: n,
				activeSleep: makeSleep({ start_time: o(-30), type: 'nap' }),
				prediction: makePrediction({ expectedNapEnd: o(+15), nextNap: o(+90), bedtime: o(+480) }),
				todayWakeUp: { wake_time: o(-120) },
				todaySleeps: [makeSleep({ start_time: o(-30), type: 'nap' })],
				arcSleeps: [prevNap],
				arcActive: { start_time: o(-30), type: 'nap' },
				arcPred: { nextNap: o(+90), bedtime: o(+480) },
				arcIsNight: false,
				arcStartLabel: hm(o(-120)),
				arcEndLabel: hm(o(+480)),
				arcBands: [],
				arcActiveWakeAt: o(+15),
				arcActiveWakeBand: wakeBand(+15, 15),
			},
			{
				label: 'Lurar – 20 min over forventa',
				group: 'Søver',
				modeKind: 'sleeping',
				nowMs: n,
				activeSleep: makeSleep({ start_time: o(-80), type: 'nap' }),
				prediction: makePrediction({ expectedNapEnd: o(-20), nextNap: o(+120), bedtime: o(+480) }),
				todayWakeUp: { wake_time: o(-180) },
				todaySleeps: [makeSleep({ start_time: o(-80), type: 'nap' })],
				arcSleeps: [],
				arcActive: { start_time: o(-80), type: 'nap' },
				arcPred: null,
				arcIsNight: false,
				arcStartLabel: hm(o(-180)),
				arcEndLabel: hm(o(+480)),
				arcBands: [],
				arcActiveWakeAt: o(-20),
				// Band hi is in the past → Arc should hide it (overtime)
				arcActiveWakeBand: wakeBand(-20, 15),
			},
			{
				label: 'Lur på pause',
				group: 'Søver',
				modeKind: 'sleeping',
				nowMs: n,
				activeSleep: makeSleep({
					start_time: o(-60), type: 'nap',
					pauses: [{ id: 1, sleep_id: 1, pause_time: o(-10), resume_time: null, created_by_event_id: null } satisfies SleepPauseRow],
				}),
				prediction: makePrediction({ expectedNapEnd: o(+30), nextNap: o(+90), bedtime: o(+480) }),
				todayWakeUp: { wake_time: o(-180) },
				todaySleeps: [makeSleep({ start_time: o(-60), type: 'nap' })],
				arcSleeps: [],
				arcActive: { start_time: o(-60), type: 'nap', isPaused: true, pauseTime: o(-10) },
				arcPred: null,
				arcIsNight: false,
				arcStartLabel: hm(o(-180)),
				arcEndLabel: hm(o(+480)),
				arcBands: [],
				arcActiveWakeAt: o(+30),
				arcActiveWakeBand: wakeBand(+30, 20),
			},
			{
				label: 'Nattesøvn – 6 timar',
				group: 'Søver',
				modeKind: 'sleeping',
				nowMs: n,
				activeSleep: makeSleep({ start_time: o(-360), type: 'night' }),
				prediction: makePrediction({ expectedNightEnd: o(+120) }),
				todayWakeUp: null,
				todaySleeps: [makeSleep({ start_time: o(-360), type: 'night' })],
				arcSleeps: [],
				arcActive: { start_time: o(-360), type: 'night' },
				arcPred: null,
				arcIsNight: true,
				arcStartLabel: hm(o(-360)),
				arcEndLabel: hm(o(+120)),
				arcBands: [],
				arcActiveWakeAt: o(+120),
				arcActiveWakeBand: wakeBand(+120, 30),
			},
			// ─── Vaken ───────────────────────────────────────────────────────
			{
				label: 'Neste lur om 2 timar',
				group: 'Vaken',
				modeKind: 'next-nap',
				nowMs: n,
				activeSleep: null,
				prediction: makePrediction({
					nextNap: o(+120), bedtime: o(+480),
					predictedNaps: [{ startTime: o(+120), endTime: o(+210) }, { startTime: o(+300), endTime: o(+390) }],
					calibration: makeCalibration('learned'),
				}),
				todayWakeUp: { wake_time: o(-90) },
				todaySleeps: [makeSleep({ start_time: o(-180), end_time: o(-90), type: 'nap' })],
				arcSleeps: [{ start_time: o(-180), end_time: o(-90), type: 'nap' }],
				arcActive: null,
				arcPred: { nextNap: o(+120), bedtime: o(+480), predictedNaps: [{ startTime: o(+120), endTime: o(+210) }, { startTime: o(+300), endTime: o(+390) }] },
				arcIsNight: false,
				arcStartLabel: hm(o(-90)),
				arcEndLabel: hm(o(+480)),
				arcBands: [],
			},
			{
				label: 'Neste lur om 10 min',
				group: 'Vaken',
				modeKind: 'next-nap',
				nowMs: n,
				activeSleep: null,
				prediction: makePrediction({ nextNap: o(+10), bedtime: o(+300) }),
				todayWakeUp: { wake_time: o(-110) },
				todaySleeps: [makeSleep({ start_time: o(-240), end_time: o(-110), type: 'nap' })],
				arcSleeps: [{ start_time: o(-240), end_time: o(-110), type: 'nap' }],
				arcActive: null,
				arcPred: { nextNap: o(+10), bedtime: o(+300) },
				arcIsNight: false,
				arcStartLabel: hm(o(-110)),
				arcEndLabel: hm(o(+300)),
				arcBands: [],
			},
			{
				label: 'Neste lur med konfidensband (±20 min)',
				group: 'Vaken',
				modeKind: 'next-nap',
				nowMs: n,
				activeSleep: null,
				prediction: makePrediction({
					nextNap: o(+60), bedtime: o(+420),
					confidence: makeConfidence(20, [o(+60), o(+240)]),
					calibration: makeCalibration('partial'),
				}),
				todayWakeUp: { wake_time: o(-90) },
				todaySleeps: [makeSleep({ start_time: o(-180), end_time: o(-90), type: 'nap' })],
				arcSleeps: [{ start_time: o(-180), end_time: o(-90), type: 'nap' }],
				arcActive: null,
				arcPred: {
					nextNap: o(+60), bedtime: o(+420),
					predictedNaps: [{ startTime: o(+60), endTime: o(+150) }, { startTime: o(+240), endTime: o(+330) }],
				},
				arcIsNight: false,
				arcStartLabel: hm(o(-90)),
				arcEndLabel: hm(o(+420)),
				arcBands: [
					{ lo: new Date(n + 40 * 60000).toISOString(), hi: new Date(n + 80 * 60000).toISOString() },
					{ lo: new Date(n + 220 * 60000).toISOString(), hi: new Date(n + 260 * 60000).toISOString() },
				],
			},
			{
				label: 'Overtid – 30 min',
				group: 'Vaken',
				modeKind: 'overtime',
				nowMs: n,
				activeSleep: null,
				prediction: makePrediction({ nextNap: o(-30), bedtime: o(+300) }),
				todayWakeUp: { wake_time: o(-150) },
				todaySleeps: [makeSleep({ start_time: o(-210), end_time: o(-150), type: 'nap' })],
				arcSleeps: [{ start_time: o(-210), end_time: o(-150), type: 'nap' }],
				arcActive: null,
				arcPred: { nextNap: o(-30), bedtime: o(+300) },
				arcIsNight: false,
				arcStartLabel: hm(o(-150)),
				arcEndLabel: hm(o(+300)),
				arcBands: [],
			},
			// ─── Leggetid ─────────────────────────────────────────────────────
			{
				label: 'Leggetid om 90 min – tweakbar',
				group: 'Leggetid',
				modeKind: 'bedtime',
				nowMs: n,
				activeSleep: null,
				prediction: bdPred,
				todayWakeUp: { wake_time: o(-480) },
				todaySleeps: [],
				targetBedtime: bdTarget,
				arcSleeps: [],
				arcActive: null,
				arcPred: { nextNap: o(+90), bedtime: o(+90) },
				arcIsNight: false,
				arcStartLabel: hm(o(-480)),
				arcEndLabel: hm(o(+90)),
				arcBands: confSD > 0 ? [{ lo: new Date(n + (90 - confSD) * 60000).toISOString(), hi: new Date(n + (90 + confSD) * 60000).toISOString() }] : [],
			},
			{
				label: 'Leggetid – ikkje nåeleg (feasible=false)',
				group: 'Leggetid',
				modeKind: 'bedtime',
				nowMs: n,
				activeSleep: null,
				prediction: makePrediction({ napsAllDone: true, bedtime: o(+90), nextNap: o(+90), feasible: false }),
				todayWakeUp: { wake_time: o(-480) },
				todaySleeps: [],
				targetBedtime: '18:30',
				arcSleeps: [],
				arcActive: null,
				arcPred: { nextNap: o(+90), bedtime: o(+90) },
				arcIsNight: false,
				arcStartLabel: hm(o(-480)),
				arcEndLabel: hm(o(+90)),
				arcBands: [],
			},
			{
				label: 'Etter leggetid',
				group: 'Leggetid',
				modeKind: 'after-bedtime',
				nowMs: n,
				activeSleep: null,
				prediction: makePrediction({ napsAllDone: true, bedtime: o(-30), nextNap: o(-30) }),
				todayWakeUp: { wake_time: o(-540) },
				todaySleeps: [],
				arcSleeps: [],
				arcActive: null,
				arcPred: { nextNap: o(-30), bedtime: o(-30) },
				arcIsNight: false,
				arcStartLabel: hm(o(-540)),
				arcEndLabel: hm(o(-30)),
				arcBands: [],
			},
			{
				// isEvening path: nowMs locked to 21:00 so getTimerMode sees hour>=20
				label: 'Leggetid (kveld, lurer ikkje ferdige) — fastlåst kl. 21:00',
				group: 'Leggetid',
				modeKind: 'bedtime',
				nowMs: eveningBase,
				activeSleep: null,
				prediction: makePrediction({ nextNap: oe(-60), bedtime: oe(+60), napsAllDone: false }),
				todayWakeUp: { wake_time: oe(-780) },
				todaySleeps: [],
				arcSleeps: [],
				arcActive: null,
				arcPred: { nextNap: oe(-60), bedtime: oe(+60) },
				arcIsNight: false,
				arcStartLabel: hm(oe(-780)),
				arcEndLabel: hm(oe(+60)),
				arcBands: [],
			},
			// ─── Nyfødde / Framveksande ───────────────────────────────────────
			{
				label: 'Søvnvindauge – kjem (lågt press)',
				group: 'Nyfødde',
				modeKind: 'sleep-window',
				nowMs: n,
				activeSleep: null,
				prediction: makePrediction({
					strategy: 'newborn_guidance',
					nextNap: null, bedtime: null,
					sleepWindow: { earliest: o(+20), latest: o(+40) },
					sleepPressure: 'low',
				}),
				todayWakeUp: { wake_time: o(-60) },
				todaySleeps: [],
				arcSleeps: [],
				arcActive: null,
				arcPred: null,
				arcIsNight: false,
				arcStartLabel: hm(o(-60)),
				arcEndLabel: null,
				arcBands: [],
			},
			{
				label: 'Søvnvindauge – ope (stigande press)',
				group: 'Nyfødde',
				modeKind: 'sleep-window',
				nowMs: n,
				activeSleep: null,
				prediction: makePrediction({
					strategy: 'newborn_guidance',
					nextNap: null, bedtime: null,
					sleepWindow: { earliest: o(-10), latest: o(+20) },
					sleepPressure: 'rising',
				}),
				todayWakeUp: { wake_time: o(-90) },
				todaySleeps: [],
				arcSleeps: [],
				arcActive: null,
				arcPred: null,
				arcIsNight: false,
				arcStartLabel: hm(o(-90)),
				arcEndLabel: null,
				arcBands: [],
			},
			{
				label: 'Søvnvindauge – høgt press',
				group: 'Nyfødde',
				modeKind: 'sleep-window',
				nowMs: n,
				activeSleep: null,
				prediction: makePrediction({
					strategy: 'newborn_guidance',
					nextNap: null, bedtime: null,
					sleepWindow: { earliest: o(-20), latest: o(+10) },
					sleepPressure: 'high',
				}),
				todayWakeUp: { wake_time: o(-120) },
				todaySleeps: [],
				arcSleeps: [],
				arcActive: null,
				arcPred: null,
				arcIsNight: false,
				arcStartLabel: hm(o(-120)),
				arcEndLabel: null,
				arcBands: [],
			},
			{
				label: 'Framveksande – søvnvindauge (utan nextNap)',
				group: 'Nyfødde',
				modeKind: 'sleep-window',
				nowMs: n,
				activeSleep: null,
				prediction: makePrediction({
					strategy: 'emerging_rhythm',
					nextNap: null, bedtime: null,
					sleepWindow: { earliest: o(+10), latest: o(+30) },
					sleepPressure: 'rising',
				}),
				todayWakeUp: { wake_time: o(-100) },
				todaySleeps: [],
				arcSleeps: [],
				arcActive: null,
				arcPred: null,
				arcIsNight: false,
				arcStartLabel: hm(o(-100)),
				arcEndLabel: null,
				arcBands: [],
			},
			// ─── Hoppa over lur ────────────────────────────────────────────────
			{
				// Halldis-scenario: woke 06:25, predicted nap 09:53, now 10:59.
				// Plenty of room before 19:00 bedtime → rescue suggestion.
				label: 'Hoppa over lur – reddingslur mogeleg',
				group: 'Hoppa over',
				modeKind: 'skipped-nap',
				nowMs: n,
				activeSleep: null,
				prediction: makePrediction({
					nextNap: o(+480), // collapsed to bedtime by engine
					bedtime: o(+480),
					napsAllDone: true,
					skippedNap: { plannedAt: o(-66) },
					postSkipPlan: {
						kind: 'rescue',
						recommendedStart: o(+30),
						latestStart: o(+90),
						wakeBy: o(+90),
					},
					calibration: makeCalibration('learned'),
				}),
				todayWakeUp: { wake_time: o(-274) },
				todaySleeps: [],
				arcSleeps: [],
				arcActive: null,
				arcPred: { nextNap: o(+480), bedtime: o(+480) },
				arcIsNight: false,
				arcStartLabel: hm(o(-274)),
				arcEndLabel: hm(o(+480)),
				arcBands: [],
				arcSkippedNap: { plannedAt: o(-66) },
				arcRescueWindow: { earliest: o(+30), latest: o(+90) },
			},
			{
				// Skipped nap late in day → bedtime is too close for a rescue.
				// Engine recommends earlier bedtime instead.
				label: 'Hoppa over lur – for seint, tidlegare leggetid',
				group: 'Hoppa over',
				modeKind: 'skipped-nap',
				nowMs: n,
				activeSleep: null,
				prediction: makePrediction({
					nextNap: o(+120),
					bedtime: o(+120),
					napsAllDone: true,
					skippedNap: { plannedAt: o(-75) },
					postSkipPlan: {
						kind: 'earlier-bedtime',
						suggestedBedtime: o(+90),
						minutesEarlier: 30,
					},
					calibration: makeCalibration('learned'),
				}),
				todayWakeUp: { wake_time: o(-360) },
				todaySleeps: [],
				arcSleeps: [],
				arcActive: null,
				arcPred: { nextNap: o(+120), bedtime: o(+120) },
				arcIsNight: false,
				arcStartLabel: hm(o(-360)),
				arcEndLabel: hm(o(+120)),
				arcBands: [],
				arcSkippedNap: { plannedAt: o(-75) },
				arcRescueWindow: null,
			},
			{
				// Toddler scenario: one nap, no rescue possible, parent should
				// just go to an earlier bedtime. Long awake-stretch context.
				label: 'Hoppa over lur – småbarn, 5h vaken',
				group: 'Hoppa over',
				modeKind: 'skipped-nap',
				nowMs: n,
				activeSleep: null,
				prediction: makePrediction({
					nextNap: o(+180),
					bedtime: o(+180),
					napsAllDone: true,
					skippedNap: { plannedAt: o(-90) },
					postSkipPlan: {
						kind: 'earlier-bedtime',
						suggestedBedtime: o(+150),
						minutesEarlier: 30,
					},
					calibration: makeCalibration('partial'),
				}),
				todayWakeUp: { wake_time: o(-300) },
				todaySleeps: [],
				arcSleeps: [],
				arcActive: null,
				arcPred: { nextNap: o(+180), bedtime: o(+180) },
				arcIsNight: false,
				arcStartLabel: hm(o(-300)),
				arcEndLabel: hm(o(+180)),
				arcBands: [],
				arcSkippedNap: { plannedAt: o(-90) },
				arcRescueWindow: null,
			},
			// ─── Spesialtilfelle ──────────────────────────────────────────────
			{
				label: 'Idle – ingen prediksjon',
				group: 'Spesialtilfelle',
				modeKind: 'idle',
				nowMs: n,
				activeSleep: null,
				prediction: null,
				todayWakeUp: { wake_time: o(-120) },
				todaySleeps: [],
				arcSleeps: [],
				arcActive: null,
				arcPred: null,
				arcIsNight: false,
				arcStartLabel: hm(o(-120)),
				arcEndLabel: null,
				arcBands: [],
			},
			{
				// deep-night: nowMs locked to 02:00 so getTimerMode sees hour in 0-4
				label: 'Djup natt – fastlåst kl. 02:00',
				group: 'Spesialtilfelle',
				modeKind: 'deep-night',
				nowMs: twoAm,
				activeSleep: null,
				prediction: null,
				todayWakeUp: { wake_time: isoOffset(twoAm, +300) }, // wakes at 2am + 5h = 7am
				todaySleeps: [],
				arcSleeps: [],
				arcActive: null,
				arcPred: null,
				arcIsNight: true,
				arcStartLabel: null,
				arcEndLabel: hm(isoOffset(twoAm, +300)),
				arcBands: [],
			},
		];
	});

	// Group scenarios for rendering
	const groups = $derived.by(() => {
		const map = new Map<string, ScenarioCard[]>();
		for (const s of scenarios) {
			if (!map.has(s.group)) map.set(s.group, []);
			map.get(s.group)!.push(s);
		}
		return [...map.entries()].map(([name, cards]) => ({ name, cards }));
	});
</script>

<svelte:head>
	<title>Dev Playground</title>
</svelte:head>

<div class="dev-page">
	<header class="dev-header">
		<h1>Widget Playground</h1>

		<div class="dev-controls">
			<label class="ctrl-group">
				<span>No</span>
				<input type="text" bind:value={nowStr} placeholder="HH:MM" class="ctrl-short" />
			</label>
			<div class="ctrl-divider"></div>
			<span class="ctrl-section-label">Leggetid-kort:</span>
			<label class="ctrl-group">
				<input type="checkbox" bind:checked={bdFeasible} />
				<span>feasible</span>
			</label>
			<label class="ctrl-group">
				<span>Mål</span>
				<input type="text" bind:value={bdTarget} class="ctrl-short" placeholder="19:00" />
			</label>
			<label class="ctrl-group">
				<span>Konf SD {confSD}m</span>
				<input type="range" min="0" max="60" step="5" bind:value={confSD} />
			</label>
		</div>
	</header>

	{#each groups as group}
		<section class="scenario-group">
			<h2 class="group-heading">{group.name}</h2>
			<div class="scenario-grid">
				{#each group.cards as s}
					<div class="scenario-card">
						<div class="scenario-meta">
							<span class="scenario-label">{s.label}</span>
							<code class="mode-badge">{s.modeKind}</code>
						</div>
						<div class="arc-container mini-arc">
							<Arc
								todaySleeps={s.arcSleeps}
								activeSleep={s.arcActive}
								prediction={s.arcPred}
								isNightMode={s.arcIsNight}
								wakeUpTime={s.arcWakeUpTime ?? null}
								startTimeLabel={s.arcStartLabel}
								endTimeLabel={s.arcEndLabel}
								napConfidenceBands={s.arcBands}
								activeWakeAt={s.arcActiveWakeAt ?? null}
								activeWakeBand={s.arcActiveWakeBand ?? null}
								skippedNap={s.arcSkippedNap ?? null}
								rescueWindow={s.arcRescueWindow ?? null}
								nowMs={s.nowMs}
							/>
							<Timer
								activeSleep={s.activeSleep}
								prediction={s.prediction}
								todayWakeUp={s.todayWakeUp}
								todaySleeps={s.todaySleeps}
								targetBedtime={s.targetBedtime ?? null}
								nowMs={s.nowMs}
							/>
						</div>
					</div>
				{/each}
			</div>
		</section>
	{/each}
</div>

<style>
	/* Override app shell constraints for full-width dev layout */
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

	.dev-page {
		padding: 16px;
		max-width: 1400px;
		margin: 0 auto;
		font-family: var(--font, system-ui, sans-serif);
	}

	.dev-header {
		margin-bottom: 24px;
	}

	.dev-header h1 {
		font-size: 1.4rem;
		font-weight: 700;
		margin: 0 0 12px;
	}

	.dev-controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
		background: var(--lavender-dark, #ece8f5);
		padding: 10px 14px;
		border-radius: 10px;
	}

	.ctrl-group {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.85rem;
		cursor: pointer;
	}

	.ctrl-group input[type="text"] {
		padding: 2px 6px;
		border: 1px solid var(--lavender-dark, #c8bedb);
		border-radius: 4px;
		font-family: var(--font, system-ui, sans-serif);
		font-size: 0.85rem;
	}

	.ctrl-short {
		width: 72px;
	}

	.ctrl-group input[type="range"] {
		width: 100px;
	}

	.ctrl-divider {
		width: 1px;
		height: 24px;
		background: var(--lavender-dark, #c8bedb);
	}

	.ctrl-section-label {
		font-size: 0.75rem;
		color: var(--text-light, #888);
		font-weight: 600;
	}

	.scenario-group {
		margin-bottom: 32px;
	}

	.group-heading {
		font-size: 1rem;
		font-weight: 600;
		margin: 0 0 12px;
		padding-bottom: 6px;
		border-bottom: 1px solid var(--lavender-dark, #ece8f5);
	}

	.scenario-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 16px;
	}

	.scenario-card {
		border: 1px solid var(--lavender-dark, #e0dce8);
		border-radius: 12px;
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		background: var(--bg, #fff);
	}

	.scenario-meta {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.scenario-label {
		font-size: 0.75rem;
		line-height: 1.3;
		color: var(--text, #333);
	}

	.mode-badge {
		font-size: 0.65rem;
		background: var(--lavender, #ddd8ee);
		color: var(--text, #333);
		padding: 1px 6px;
		border-radius: 4px;
		display: inline-block;
		align-self: flex-start;
		font-family: monospace;
	}

	/* Override arc-container to be compact for the cards */
	:global(.mini-arc) {
		max-width: 200px !important;
		align-self: center;
	}
</style>
