/**
 * Comprehensive engine-scenario sweep.
 *
 * Six synthetic baby archetypes, each driven through ~10–50 "current-state"
 * scenarios. Each scenario renders the full Prediction shape into a compact
 * line-oriented block; one inline snapshot per archetype shows pattern drift
 * across the archetype's whole scenario set in a single readable diff.
 *
 * Universal invariants (see assertInvariants below) run BEFORE the snapshot
 * compare for every scenario, so `bun test --update-snapshots` cannot paste a
 * regression away. Each contract is tagged with the bug class it protects.
 *
 * The engine is fully deterministic when `data.now` is supplied (see the
 * preceding refactor that threaded `now` through `buildContext` and
 * `recommendBedtime`). Birthdates are anchored to a fixed TODAY so ageMonths
 * is stable across runs.
 *
 * Codex pair-reviewed the architecture; see docs/followups.md for the design
 * trail and the bug pins this suite is meant to make impossible to miss.
 */
import { describe, expect, it } from "bun:test";
import { assembleState, type DayData } from "$lib/engine/state.js";
import type { Baby, SleepLogRow, DayStartRow } from "$lib/types.js";
import type { Prediction } from "$lib/stores/app.svelte.js";

// ─── Time anchor ────────────────────────────────────────────────────────────
//
// All scenarios run as if "now" is somewhere on TODAY in TZ. Birthdates are
// back-computed from TODAY so ageMonths is stable. The engine takes `now` via
// DayData; we pass it everywhere — no setSystemTime needed.

const TODAY = "2026-05-15"; // Friday, CEST
const TZ = "Europe/Oslo";

// ─── Time helpers ───────────────────────────────────────────────────────────

/** Convert an Oslo-local "HH:MM" on a given YYYY-MM-DD to a UTC ISO string. */
function osloIso(date: string, hhmm: string): string {
  // CEST = UTC+2 from late March to late October. May 15 is firmly CEST.
  const [h, m] = hhmm.split(":").map(Number);
  const utcH = h - 2;
  if (utcH >= 0) {
    return `${date}T${pad(utcH)}:${pad(m)}:00.000Z`;
  }
  // Roll back to previous calendar day.
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const prev = d.toISOString().slice(0, 10);
  return `${prev}T${pad(24 + utcH)}:${pad(m)}:00.000Z`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Add `minutes` to "HH:MM" and return "HH:MM" (clamped to same day). */
function addMin(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + minutes;
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/**
 * Format a learned-minute value with at most 1 decimal place. Without this,
 * snapshots show noise like `ww=183.07692307692307m`, which both hides real
 * shifts and produces large diffs on tiny engine tweaks.
 */
function fmtMin(value: number): string {
  return Number.isInteger(value)
    ? value.toString()
    : (Math.round(value * 10) / 10).toString();
}

/** Convert a UTC ISO timestamp to "HH:MM" in Oslo. */
function osloHHMM(iso: string): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
  });
  return fmt.format(new Date(iso));
}

/** Add `days` to a YYYY-MM-DD date string, returning YYYY-MM-DD. */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Render a delta from now to an ISO time, e.g. "+2h 14m" or "-1h 02m". */
function delta(fromIso: number, toIso: string | null): string {
  if (toIso == null) return "—";
  const ms = new Date(toIso).getTime() - fromIso;
  const sign = ms >= 0 ? "+" : "-";
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  return h === 0
    ? `${sign}${pad(m)}m`
    : `${sign}${h}h ${pad(m)}m`;
}

// ─── Sleep / wake row builders ──────────────────────────────────────────────

let nextSleepId = 1;

interface NapShorthand {
  /** "HH:MM-HH:MM" or "HH:MM-HH:MM!" (woken cut-short) or "HH:MM-" (active) */
  spec: string;
  /** Day offset from TODAY, default 0. Negative = past day. */
  dayOffset?: number;
  type?: "nap" | "night";
}

function buildSleep(spec: NapShorthand): SleepLogRow {
  const date = addDays(TODAY, spec.dayOffset ?? 0);
  const [startStr, endStr] = spec.spec.split("-");
  const wokeBy = endStr?.endsWith("!") ? "woken" : "self";
  const cleanEnd = endStr?.replace("!", "");
  const start_time = osloIso(date, startStr.trim());
  let end_time: string | null = null;
  if (cleanEnd && cleanEnd.trim() !== "") {
    // Night sleeps that cross midnight: the spec encodes the end on the same
    // day; if end < start we roll to next day.
    const [sh] = startStr.split(":").map(Number);
    const [eh] = cleanEnd.split(":").map(Number);
    const endDate = eh < sh ? addDays(date, 1) : date;
    end_time = osloIso(endDate, cleanEnd.trim());
  }
  return {
    id: nextSleepId++,
    baby_id: 1,
    start_time,
    end_time,
    type: spec.type ?? "nap",
    notes: null, mood: null, method: null,
    fall_asleep_time: null, onset_note: null,
    woke_by: end_time === null ? null : wokeBy,
    wake_notes: null, wake_mood: null,
    deleted: 0, domain_id: `slp_${nextSleepId}`,
    created_by_event_id: null, updated_by_event_id: null,
  };
}

function wakeRow(date: string, hhmm: string): DayStartRow {
  return {
    id: 1, baby_id: 1, date,
    wake_time: osloIso(date, hhmm),
    created_at: osloIso(date, hhmm),
    created_by_event_id: null,
  };
}

// ─── Base baby template ─────────────────────────────────────────────────────

function baseBaby(overrides: Partial<Baby>): Baby {
  return {
    id: 1, name: "Test",
    birthdate: "2025-09-15",
    created_at: `${TODAY}T00:00:00.000Z`,
    custom_nap_count: null, potty_mode: 0,
    timezone: TZ, target_bedtime: null,
    created_by_event_id: null, updated_by_event_id: null,
    ...overrides,
  };
}

// ─── Archetype builders ─────────────────────────────────────────────────────
//
// Each archetype returns a Baby + history that locks the strategy selector to
// the intended strategy across the full 7-day hysteresis replay (see
// strategy.ts for the rules). Routine archetypes need 14+ days of consistent
// data so the earliest replay day still sees ≥7 complete days.

interface Archetype {
  name: string;
  baby: Baby;
  /** 7-day window — feeds duration/wake-window learning. */
  recentSleeps: SleepLogRow[];
  /** 21-day window — feeds strategy hysteresis + extended self-median. */
  strategySleeps: SleepLogRow[];
  expectedStrategy: "newborn_guidance" | "emerging_rhythm" | "routine_schedule";
  /** A short summary used in snapshot headers. */
  summary: string;
}

/** Newborn (~4 weeks): noisy 5-7 short naps/day, target 20:30, 5 days only. */
function buildNora(): Archetype {
  const baby = baseBaby({
    name: "Nora Newborn",
    birthdate: addDays(TODAY, -28), // 4 weeks
    target_bedtime: "20:30",
  });
  const recent: SleepLogRow[] = [];
  // 5 days of irregular short naps + fragmented night.
  for (let d = 5; d >= 1; d--) {
    const day = addDays(TODAY, -d);
    void day;
    // 5–7 short naps spread across the day, durations 20–55 min.
    const napTimes = [
      ["07:30", "08:00"],
      ["09:45", "10:25"],
      ["11:30", "11:55"],
      ["13:30", "14:15"],
      ["15:30", "15:55"],
      ["17:30", "18:00"],
    ];
    if (d % 2 === 0) napTimes.push(["19:00", "19:25"]);
    for (const [s, e] of napTimes) {
      recent.push(buildSleep({ spec: `${s}-${e}`, dayOffset: -d, type: "nap" }));
    }
    // Fragmented night: long stretch + 2 short ones (newborn pattern).
    recent.push(buildSleep({ spec: "21:00-23:30", dayOffset: -d, type: "night" }));
    recent.push(buildSleep({ spec: "23:50-03:00", dayOffset: -d, type: "night" }));
    recent.push(buildSleep({ spec: "03:30-06:30", dayOffset: -d, type: "night" }));
  }
  return {
    name: "Nora Newborn",
    baby,
    recentSleeps: recent,
    strategySleeps: recent,
    expectedStrategy: "newborn_guidance",
    summary: "4w, 5–7 fragmented naps, target 20:30",
  };
}

/** Emerging (~3.5 mo): 4 naps, transitional, target 19:45, 21 days. */
function buildEli(): Archetype {
  const baby = baseBaby({
    name: "Eli Emerging",
    birthdate: addDays(TODAY, -106), // ~3.5 months
    target_bedtime: "19:45",
  });
  const sleeps: SleepLogRow[] = [];
  // 21 days of 4-nap pattern with strong noise on first-nap start so
  // firstNapConsistency stays > 30 min (else the early-graduation rule would
  // promote Eli to routine_schedule). Spread first-nap starts across a 105-min
  // band so SD comfortably exceeds 30.
  for (let d = 21; d >= 1; d--) {
    const firstJitter = (d % 8) * 15; // 0..105 min, SD ≈ 32 min
    const napStarts = [
      addMin("08:00", firstJitter),
      addMin("11:30", (d % 5) * 10),
      addMin("14:30", (d % 4) * 10),
      addMin("17:00", (d % 3) * 10),
    ];
    const durations = [50, 55, 50, 45];
    for (let i = 0; i < napStarts.length; i++) {
      const start = napStarts[i];
      const end = addMin(start, durations[i]);
      sleeps.push(buildSleep({ spec: `${start}-${end}`, dayOffset: -d, type: "nap" }));
    }
    sleeps.push(buildSleep({ spec: "19:30-06:00", dayOffset: -d, type: "night" }));
  }
  return {
    name: "Eli Emerging",
    baby,
    recentSleeps: sleeps.filter((s) => {
      const startMs = new Date(s.start_time).getTime();
      const todayStartMs = new Date(`${TODAY}T00:00:00.000Z`).getTime();
      return startMs >= todayStartMs - 7 * 24 * 3_600_000;
    }),
    strategySleeps: sleeps,
    expectedStrategy: "emerging_rhythm",
    summary: "3.5mo, 4-nap, target 19:45, 21d",
  };
}

/** Routine 3-nap (~8 mo): tight schedule, target 19:15, 45 days consistent. */
function buildMina(): Archetype {
  const baby = baseBaby({
    name: "Mina Learned",
    birthdate: addDays(TODAY, -243), // ~8 months
    target_bedtime: "19:15",
    custom_nap_count: 3,
  });
  // 21 days for strategy lookback, 7 of which feed recent learning.
  const sleeps: SleepLogRow[] = [];
  for (let d = 21; d >= 1; d--) {
    sleeps.push(
      buildSleep({ spec: "08:50-09:35", dayOffset: -d, type: "nap" }),
      buildSleep({ spec: "12:10-13:20", dayOffset: -d, type: "nap" }),
      buildSleep({ spec: "15:55-16:35", dayOffset: -d, type: "nap" }),
      buildSleep({ spec: "19:15-06:30", dayOffset: -d, type: "night" }),
    );
  }
  const todayStartMs = new Date(`${TODAY}T00:00:00.000Z`).getTime();
  return {
    name: "Mina Learned",
    baby,
    recentSleeps: sleeps.filter(
      (s) => new Date(s.start_time).getTime() >= todayStartMs - 7 * 24 * 3_600_000,
    ),
    strategySleeps: sleeps,
    expectedStrategy: "routine_schedule",
    summary: "8mo, 3-nap, target 19:15, 21d",
  };
}

/** Routine 1-nap (~12 mo): the Halldis-shape, target 19:30, primary cut-short surface. */
function buildOskar(): Archetype {
  const baby = baseBaby({
    name: "Oskar OneNap",
    birthdate: addDays(TODAY, -365), // ~12 months
    target_bedtime: "19:30",
    custom_nap_count: 1,
  });
  const sleeps: SleepLogRow[] = [];
  for (let d = 21; d >= 1; d--) {
    sleeps.push(
      buildSleep({ spec: "11:30-13:20", dayOffset: -d, type: "nap" }),
      buildSleep({ spec: "19:30-06:00", dayOffset: -d, type: "night" }),
    );
  }
  const todayStartMs = new Date(`${TODAY}T00:00:00.000Z`).getTime();
  return {
    name: "Oskar OneNap",
    baby,
    recentSleeps: sleeps.filter(
      (s) => new Date(s.start_time).getTime() >= todayStartMs - 7 * 24 * 3_600_000,
    ),
    strategySleeps: sleeps,
    expectedStrategy: "routine_schedule",
    summary: "12mo, 1-nap, target 19:30, 21d",
  };
}

/** Routine 2-nap (~10 mo): no target_bedtime, 30 days normal. */
function buildAda(): Archetype {
  const baby = baseBaby({
    name: "Ada NoTarget",
    birthdate: addDays(TODAY, -304), // ~10 months
    target_bedtime: null,
    custom_nap_count: 2,
  });
  const sleeps: SleepLogRow[] = [];
  for (let d = 21; d >= 1; d--) {
    sleeps.push(
      buildSleep({ spec: "09:30-10:50", dayOffset: -d, type: "nap" }),
      buildSleep({ spec: "13:30-14:50", dayOffset: -d, type: "nap" }),
      buildSleep({ spec: "19:00-06:00", dayOffset: -d, type: "night" }),
    );
  }
  const todayStartMs = new Date(`${TODAY}T00:00:00.000Z`).getTime();
  return {
    name: "Ada NoTarget",
    baby,
    recentSleeps: sleeps.filter(
      (s) => new Date(s.start_time).getTime() >= todayStartMs - 7 * 24 * 3_600_000,
    ),
    strategySleeps: sleeps,
    expectedStrategy: "routine_schedule",
    summary: "10mo, 2-nap, no target, 21d",
  };
}

// ─── Scenario DSL ───────────────────────────────────────────────────────────

interface ScenarioInput {
  /** Free-form label rendered in the snapshot. */
  label: string;
  /** "HH:MM" Oslo local time on TODAY. */
  now: string;
  /**
   * Today's completed sleeps (most recent first, mirrors prod ORDER BY DESC).
   * Specs: "HH:MM-HH:MM" (self-wake), "HH:MM-HH:MM!" (woken/cut-short).
   */
  done?: string[];
  /** Active sleep, e.g. "15:00" or "15:00 night". */
  active?: string;
  /** Today's wake-up time. Defaults from archetype's history; "none" = absent. */
  wake?: string | "none";
  /** Override target_bedtime for this scenario, e.g. "null" to clear it. */
  target?: string | "null";
  /**
   * Per-archetype expectations. Lets one scenario be reused across archetypes
   * with archetype-specific assertions about what fields should be null vs
   * populated, or skipped entirely with a reason.
   *
   * Example:
   *   expect: {
   *     newborn_guidance: { bedtime: "null", predictedNaps: "null" },
   *     emerging_rhythm: { bedtime: "set" },
   *     routine_schedule: { bedtime: "set", confidence: "set" },
   *   }
   */
  expect?: Partial<Record<
    "newborn_guidance" | "emerging_rhythm" | "routine_schedule",
    ScenarioExpectation
  >>;
  /**
   * Skip this scenario for these archetype names (matched against
   * Archetype.name) or these strategies. Use either / both — strategy is
   * coarse, archetype name is exact.
   */
  skipFor?: {
    archetype?: string[];
    strategy?: Array<"newborn_guidance" | "emerging_rhythm" | "routine_schedule">;
  };
}

interface ScenarioExpectation {
  /** Assert prediction.bedtime is null ("null") or non-null ("set"). */
  bedtime?: "null" | "set";
  /** Assert prediction.nextNap is null ("null") or non-null ("set"). */
  nextNap?: "null" | "set";
  /** Assert prediction.predictedNaps is null ("null") or has items ("set"). */
  predictedNaps?: "null" | "set";
  /** Assert prediction.confidence is null ("null") or non-null ("set"). */
  confidence?: "null" | "set";
  /** Assert prediction itself is null (e.g. routine with no wake reference). */
  prediction?: "null";
}

interface BuiltScenario {
  label: string;
  data: DayData;
  nowMs: number;
}

function buildScenario(arch: Archetype, input: ScenarioInput): BuiltScenario {
  const baby = input.target !== undefined
    ? { ...arch.baby, target_bedtime: input.target === "null" ? null : input.target }
    : arch.baby;

  const nowIso = osloIso(TODAY, input.now);
  const nowMs = new Date(nowIso).getTime();

  const todaySleeps: SleepLogRow[] = [];
  // Today's completed sleeps, most-recent-first to mirror prod query order.
  if (input.done) {
    const built = input.done.map((spec) => buildSleep({ spec, dayOffset: 0, type: "nap" }));
    // Build appended in input order; the "most recent first" expectation is
    // that the test author lists newest first.
    todaySleeps.push(...built);
  }

  let activeSleep: SleepLogRow | undefined;
  if (input.active) {
    const parts = input.active.split(" ");
    const spec = `${parts[0]}-`;
    const type = (parts[1] === "night" ? "night" : "nap") as "nap" | "night";
    activeSleep = buildSleep({ spec, dayOffset: 0, type });
    // Active comes first in the DESC ordering.
    todaySleeps.unshift(activeSleep);
  }

  const wakeSpec = input.wake;
  let todayWakeUp: DayStartRow | undefined;
  if (wakeSpec !== "none") {
    todayWakeUp = wakeRow(TODAY, wakeSpec ?? defaultWakeFor(arch));
  }

  return {
    label: input.label,
    data: {
      baby,
      activeSleep,
      todaySleeps,
      recentSleeps: arch.recentSleeps,
      strategySleeps: arch.strategySleeps,
      todayWakeUp,
      pausesBySleep: new Map(),
      diaperCount: 0,
      lastDiaperTime: null,
      now: nowMs,
    },
    nowMs,
  };
}

function defaultWakeFor(arch: Archetype): string {
  // Pick a plausible wake time per archetype.
  switch (arch.name) {
    case "Nora Newborn": return "06:30";
    case "Eli Emerging": return "06:00";
    case "Mina Learned": return "06:30";
    case "Oskar OneNap": return "06:00";
    case "Ada NoTarget": return "06:00";
    case "Iben Sparse": return "06:30";
    default: return "06:00";
  }
}

// ─── Renderer ───────────────────────────────────────────────────────────────

function renderInputs(scn: BuiltScenario): string {
  const parts: string[] = [];
  const wake = scn.data.todayWakeUp ? osloHHMM(scn.data.todayWakeUp.wake_time) : "none";
  parts.push(`wake=${wake}`);
  const completed = scn.data.todaySleeps.filter((s) => s.end_time);
  if (completed.length) {
    const naps = completed.map((s) => {
      const start = osloHHMM(s.start_time);
      const end = osloHHMM(s.end_time!);
      const cs = s.woke_by === "woken" ? "!" : "";
      return `${start}-${end}${cs}`;
    });
    parts.push(`done=[${naps.join(", ")}]`);
  }
  if (scn.data.activeSleep) {
    const start = osloHHMM(scn.data.activeSleep.start_time);
    parts.push(`active=${start}(${scn.data.activeSleep.type})`);
  }
  if (scn.data.baby.target_bedtime) parts.push(`target=${scn.data.baby.target_bedtime}`);
  else parts.push(`target=none`);
  return parts.join(" ");
}

function renderPrediction(scn: BuiltScenario, p: Prediction | null): string {
  const lines: string[] = [];
  lines.push(`scenario: ${scn.label}`);
  lines.push(`  now: ${osloHHMM(new Date(scn.nowMs).toISOString())}`);
  lines.push(`  inputs: ${renderInputs(scn)}`);
  if (p === null) {
    lines.push(`  prediction: none (no wake reference)`);
    return lines.join("\n");
  }
  lines.push(`  strategy: ${p.strategy}`);
  lines.push(`  nextNap: ${fmtTime(p.nextNap, scn.nowMs)}`);
  lines.push(`  bedtime: ${fmtTime(p.bedtime, scn.nowMs)}`);
  lines.push(`  predictedNaps: ${fmtPredicted(p.predictedNaps)}`);
  lines.push(`  napsAllDone: ${p.napsAllDone} (${p.expectedNapCount} expected)`);
  lines.push(`  expectedNapEnd: ${fmtTime(p.expectedNapEnd, scn.nowMs)}`);
  lines.push(`  expectedNightEnd: ${fmtTime(p.expectedNightEnd, scn.nowMs)}`);
  lines.push(`  rescueNap: ${p.rescueNap ? `${osloHHMM(p.rescueNap.recommendedWakeTime)} (${p.rescueNap.reason})` : "none"}`);
  lines.push(`  continuationWindow: ${fmtContinuation(p.continuationWindow)}`);
  if (p.confidence) {
    const ranges = p.confidence.napRanges?.length ?? 0;
    const level = p.confidence.level;
    lines.push(`  confidence: ${level} (${ranges} napRanges)`);
  } else {
    lines.push(`  confidence: none`);
  }
  if (p.learnedSchedule) {
    const ls = p.learnedSchedule;
    lines.push(`  learned: nap=${fmtMin(ls.napDurationMin)}m night=${fmtMin(ls.nightDurationMin)}m ww=${fmtMin(ls.wakeWindowMin)}m bedww=${fmtMin(ls.bedtimeWakeWindowMin)}m`);
  }
  if (p.sleepWindow) {
    lines.push(`  sleepWindow: ${osloHHMM(p.sleepWindow.earliest)}–${osloHHMM(p.sleepWindow.latest)}`);
  }
  if (p.sleepPressure) lines.push(`  sleepPressure: ${p.sleepPressure}`);
  return lines.join("\n");
}

function fmtTime(iso: string | null, nowMs: number): string {
  if (iso === null) return "none";
  return `${osloHHMM(iso)} (${delta(nowMs, iso)})`;
}

function fmtPredicted(naps: Prediction["predictedNaps"]): string {
  if (!naps || naps.length === 0) return "none";
  return naps.map((n) => `${osloHHMM(n.startTime)}-${osloHHMM(n.endTime)}`).join(", ");
}

function fmtContinuation(cw: Prediction["continuationWindow"]): string {
  if (!cw) return "none";
  return `closes ${osloHHMM(cw.closesAt)} cap ${osloHHMM(cw.capLatestEnd)}`;
}

// ─── Universal invariants ───────────────────────────────────────────────────
//
// Every scenario runs these BEFORE the snapshot is rendered, so a `--update`
// can never mask a violation. Each contract names the bug class it protects.

interface InvariantContext {
  archetype: Archetype;
  scenario: BuiltScenario;
  prediction: Prediction | null;
}

function assertInvariants({ archetype, scenario, prediction }: InvariantContext): void {
  const where = `${archetype.name} :: ${scenario.label}`;
  const p = prediction;
  const data = scenario.data;
  const nowMs = scenario.nowMs;
  const arch = archetype;

  // I-strategy: archetype's expected strategy is whatever the engine produces
  // a prediction for. Newborn/emerging always produce one (with or without
  // wake); routine returns null only when wake is unset. Earlier this was
  // gated on `data.todayWakeUp` too, which silently dropped no-wake
  // newborn/emerging cases — the snapshot could change strategy without the
  // invariant noticing.
  if (p) {
    expect(p.strategy, `${where}: expected strategy ${arch.expectedStrategy}`)
      .toBe(arch.expectedStrategy);
  }

  // I-1: no NaN, "Invalid Date", or undefined where a value is expected.
  // (Intentional null is allowed — newborn fields, missing wake reference, etc.)
  if (p) checkNoNaN(p, where);

  // I-2: bedtime is on today's local date (May-7 22h-17m bug).
  if (p?.bedtime) {
    const bedtimeLocal = osloDate(p.bedtime);
    expect(bedtimeLocal, `${where}: bedtime must land on TODAY in local tz`)
      .toBe(TODAY);
  }

  // I-3: bedtime is within 18h of now.
  if (p?.bedtime) {
    const bedtimeMs = new Date(p.bedtime).getTime();
    const dt = Math.abs(bedtimeMs - nowMs);
    expect(dt, `${where}: bedtime within 18h of now`).toBeLessThan(18 * 3_600_000);
  }

  // I-7: napsAllDone implies nextNap == bedtime AND predictedNaps is null
  // AND (when idle) rescueNap is null.
  //
  // The engine treats an active night as ending the day's nap budget, so
  // the napsAllDone collapse (nextNap = bedtime, predictedNaps = null)
  // applies uniformly — no active-night gate needed.
  if (p?.napsAllDone) {
    expect(p.nextNap, `${where}: napsAllDone → nextNap == bedtime`).toBe(p.bedtime);
    expect(p.predictedNaps, `${where}: napsAllDone → predictedNaps null`).toBeNull();
    if (!data.activeSleep) {
      expect(p.rescueNap, `${where}: napsAllDone (idle) → rescueNap null`).toBeNull();
    }
  }

  // I-9: predictedNaps chronological, non-overlapping.
  if (p?.predictedNaps) {
    for (let i = 1; i < p.predictedNaps.length; i++) {
      const prevEnd = new Date(p.predictedNaps[i - 1].endTime).getTime();
      const nextStart = new Date(p.predictedNaps[i].startTime).getTime();
      expect(prevEnd, `${where}: predictedNaps non-overlapping at index ${i}`)
        .toBeLessThanOrEqual(nextStart);
    }
    for (const n of p.predictedNaps) {
      const s = new Date(n.startTime).getTime();
      const e = new Date(n.endTime).getTime();
      expect(s, `${where}: predictedNap start < end`).toBeLessThan(e);
    }
  }

  // I-B8: every visible predictedNap must end well before bedtime.
  //
  // Original B8 only checked startTime, which let through naps like
  // Eli's 16:16-17:01 with bedtime 17:34 — start was 78m before bedtime
  // (passing) but end was only 33m before bedtime (the baby would wake
  // from the nap and need to immediately wind down). Check both bounds.
  if (p?.predictedNaps && p.bedtime) {
    const bedtimeMs = new Date(p.bedtime).getTime();
    for (const n of p.predictedNaps) {
      const startMs = new Date(n.startTime).getTime();
      const endMs = new Date(n.endTime).getTime();
      expect(bedtimeMs - startMs, `${where}: predictedNap start within 60m of bedtime`)
        .toBeGreaterThan(60 * 60_000);
      expect(bedtimeMs - endMs, `${where}: predictedNap END within 60m of bedtime`)
        .toBeGreaterThan(60 * 60_000);
    }
  }

  // I-bedtime-evening-hour: bedtime should land in a realistic evening
  // window — never before 17:00 local for routine/emerging babies, never
  // after 23:00. Catches the May-2026 review finding where Mina (3-nap,
  // target 19:15) returned bedtime: 16:15 after a skipped-nap day — the
  // engine collapsed too aggressively to "go to bed now" instead of
  // pushing to a sensible evening time.
  //
  // Newborn strategy is more permissive (no schedule-based bedtime), so
  // gate on strategy. Active-night also exempt (the night may have started
  // before the canonical bedtime hour).
  if (
    p?.bedtime
    && p.strategy !== "newborn_guidance"
    && data.activeSleep?.type !== "night"
  ) {
    const bedtimeHour = parseInt(osloHHMM(p.bedtime).split(":")[0]);
    expect(bedtimeHour, `${where}: bedtime hour-of-day in [17, 23] for routine/emerging`)
      .toBeGreaterThanOrEqual(17);
    expect(bedtimeHour, `${where}: bedtime hour-of-day in [17, 23] for routine/emerging`)
      .toBeLessThanOrEqual(23);
  }

  // I-stale: when the engine still considers naps unfinished, `nextNap`
  // should not be substantially in the past — whether it came from the
  // predictedNaps list or from the predictNextNap fallback. Catches both
  // (a) the emerging path's missing stale-replan, (b) the routine path's
  // 90-min-was-too-lax napSkipped threshold, and (c) the fallback case
  // where predictedNaps is null but predictNextNap returned a stale time.
  //
  // Surfaced by the 2026-05-08 review across Eli/Iben/Oskar scenarios.
  if (p?.nextNap && !p.napsAllDone && !data.activeSleep) {
    const nextNapMs = new Date(p.nextNap).getTime();
    const overdueMin = (nowMs - nextNapMs) / 60_000;
    expect(overdueMin, `${where}: nextNap not >60 min in the past`)
      .toBeLessThanOrEqual(60);
  }

  // I-confidence-aligned: napRanges length matches predictedNaps.
  if (p?.confidence && p.predictedNaps !== undefined) {
    const napCount = p.predictedNaps?.length ?? 0;
    expect(p.confidence.napRanges.length, `${where}: confidence.napRanges aligned with predictedNaps`)
      .toBe(napCount);
    if (p.predictedNaps && p.predictedNaps.length > 0) {
      for (let i = 0; i < p.predictedNaps.length; i++) {
        expect(p.confidence.napRanges[i].startTime, `${where}: napRanges[${i}] aligned`)
          .toBe(p.predictedNaps[i].startTime);
      }
    }
  }

  // I-confidence-finite: ranges are finite, ordered (lo ≤ point ≤ hi), sd ≥ 0.
  if (p?.confidence) {
    for (const r of p.confidence.napRanges) {
      assertRange(r.startRange, `${where}: napRange start`);
    }
    if (p.confidence.bedtimeRange) {
      assertRange(p.confidence.bedtimeRange, `${where}: bedtime range`);
    }
  }

  // I-cut-short floor (May-7 11:07 bug): when the engine itself opened a
  // continuationWindow it has identified a cut-short and the 165-min floor
  // is in play. Triggering on continuationWindow avoids false positives on
  // "woken" naps that are above the engine's threshold for the baby's
  // regime (e.g. Eli's 30-min naps in 4-nap regime, where 30 min is normal).
  if (
    p && p.strategy !== "newborn_guidance"
    && !data.activeSleep
    && p.nextNap && p.bedtime
    && p.continuationWindow
  ) {
    const lastCutShort = mostRecentCutShortFromData(data);
    if (lastCutShort?.end_time) {
      const nextMs = new Date(p.nextNap).getTime();
      const cutEndMs = new Date(lastCutShort.end_time).getTime();
      // Only enforce when the next nap is still the comeback (before bedtime).
      if (nextMs < new Date(p.bedtime).getTime()) {
        expect(nextMs - cutEndMs, `${where}: comeback floor (cutShort.end + 2h45m)`)
          .toBeGreaterThanOrEqual(165 * 60_000);
      }
    }
  }

  // I-active-nap-end: expectedNapEnd >= now while a nap is active.
  if (data.activeSleep?.type === "nap" && p?.expectedNapEnd) {
    const endMs = new Date(p.expectedNapEnd).getTime();
    expect(endMs, `${where}: expectedNapEnd not in the past`).toBeGreaterThanOrEqual(nowMs);
  }

  // I-continuation-shape: when open, closesAt = cutShort.end + 25 min.
  if (p?.continuationWindow) {
    expect(data.activeSleep, `${where}: continuationWindow only when idle`).toBeUndefined();
    const cs = mostRecentCutShortFromData(data);
    if (cs?.end_time) {
      const expected = new Date(cs.end_time).getTime() + 25 * 60_000;
      const actual = new Date(p.continuationWindow.closesAt).getTime();
      expect(actual, `${where}: continuation closesAt = cutShort.end + 25m`)
        .toBe(expected);
    }
    // Now must be before closesAt.
    expect(nowMs, `${where}: continuation only open until closesAt`)
      .toBeLessThanOrEqual(new Date(p.continuationWindow.closesAt).getTime());
  }

  // I-strategy-shape: each strategy populates the right fields.
  if (p) {
    if (p.strategy === "newborn_guidance") {
      expect(p.predictedNaps, `${where}: newborn predictedNaps null`).toBeNull();
      expect(p.bedtime, `${where}: newborn bedtime null`).toBeNull();
      expect(p.confidence, `${where}: newborn confidence null`).toBeNull();
      expect(p.learnedSchedule, `${where}: newborn learnedSchedule null`).toBeNull();
      expect(p.sleepWindow, `${where}: newborn sleepWindow set`).not.toBeNull();
    } else if (p.strategy === "routine_schedule") {
      expect(p.learnedSchedule, `${where}: routine learnedSchedule set`).not.toBeNull();
      expect(p.sleepWindow, `${where}: routine sleepWindow null`).toBeNull();
      expect(p.confidence, `${where}: routine confidence set`).not.toBeNull();
    } else if (p.strategy === "emerging_rhythm") {
      expect(p.learnedSchedule, `${where}: emerging learnedSchedule null`).toBeNull();
      expect(p.confidence, `${where}: emerging confidence null`).toBeNull();
      expect(p.sleepWindow, `${where}: emerging sleepWindow set`).not.toBeNull();
    }
  }
}

function checkNoNaN(p: Prediction, where: string): void {
  // Walk all string fields that look like ISO timestamps; ensure they parse.
  const isoFields: Array<string | null> = [
    p.nextNap, p.bedtime, p.expectedNapEnd, p.expectedNightEnd,
  ];
  for (const f of isoFields) {
    if (f !== null) {
      const t = new Date(f).getTime();
      expect(Number.isFinite(t), `${where}: '${f}' is a finite Date`).toBe(true);
    }
  }
  if (p.predictedNaps) {
    for (const n of p.predictedNaps) {
      expect(Number.isFinite(new Date(n.startTime).getTime()), `${where}: predictedNap.startTime finite`).toBe(true);
      expect(Number.isFinite(new Date(n.endTime).getTime()), `${where}: predictedNap.endTime finite`).toBe(true);
    }
  }
  if (p.rescueNap) {
    expect(Number.isFinite(new Date(p.rescueNap.recommendedWakeTime).getTime()), `${where}: rescueNap finite`).toBe(true);
  }
  if (p.continuationWindow) {
    expect(Number.isFinite(new Date(p.continuationWindow.closesAt).getTime()), `${where}: closesAt finite`).toBe(true);
    expect(Number.isFinite(new Date(p.continuationWindow.capLatestEnd).getTime()), `${where}: capLatestEnd finite`).toBe(true);
  }
}

interface PredictionRange { point: string; lo: string; hi: string; sdMinutes: number }

function assertRange(r: PredictionRange | undefined, label: string): void {
  if (!r) return;
  const point = new Date(r.point).getTime();
  const lo = new Date(r.lo).getTime();
  const hi = new Date(r.hi).getTime();
  expect(Number.isFinite(point), `${label}: point finite`).toBe(true);
  expect(Number.isFinite(lo), `${label}: lo finite`).toBe(true);
  expect(Number.isFinite(hi), `${label}: hi finite`).toBe(true);
  expect(lo, `${label}: lo ≤ point`).toBeLessThanOrEqual(point);
  expect(hi, `${label}: point ≤ hi`).toBeGreaterThanOrEqual(point);
  expect(r.sdMinutes, `${label}: sdMinutes ≥ 0`).toBeGreaterThanOrEqual(0);
}

function osloDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(iso));
}

function mostRecentCutShortFromData(data: DayData): SleepLogRow | null {
  // Mirror engine logic: completed naps shorter than the engine's threshold
  // for that baby. Without re-deriving the threshold we use a conservative
  // proxy: any "woken" nap counts as a cut-short candidate. This is wider
  // than the engine's actual threshold so the invariant catches more cases
  // (engine's threshold-based filter is a subset of "woken").
  let best: SleepLogRow | null = null;
  for (const s of data.todaySleeps) {
    if (s.end_time && s.woke_by === "woken") {
      if (!best || new Date(s.end_time).getTime() > new Date(best.end_time!).getTime()) {
        best = s;
      }
    }
  }
  return best;
}

// ─── Sweep runner ───────────────────────────────────────────────────────────

function runSweep(arch: Archetype, scenarios: ScenarioInput[]): string {
  // Sanity check: archetype lands in the intended strategy under a vanilla
  // "morning, just woke" probe. This lets a strategy regression fail loudly
  // rather than corrupting all scenario snapshots.
  const probe = buildScenario(arch, { label: "_probe", now: "07:00" });
  const probeResult = assembleState(probe.data);
  if (probeResult.prediction) {
    expect(probeResult.prediction.strategy, `${arch.name}: archetype must lock to ${arch.expectedStrategy}`)
      .toBe(arch.expectedStrategy);
  }

  const blocks: string[] = [];
  blocks.push(`baby: ${arch.name} (${arch.summary})`);
  for (const input of scenarios) {
    if (shouldSkip(arch, input)) {
      blocks.push(`scenario: ${input.label}\n  N/A for ${arch.name} (${arch.expectedStrategy})`);
      continue;
    }
    const scn = buildScenario(arch, input);
    const result = assembleState(scn.data);
    assertInvariants({ archetype: arch, scenario: scn, prediction: result.prediction });
    assertExpectations(arch, input, result.prediction);
    blocks.push(renderPrediction(scn, result.prediction));
  }
  return blocks.join("\n\n");
}

function shouldSkip(arch: Archetype, input: ScenarioInput): boolean {
  if (!input.skipFor) return false;
  if (input.skipFor.archetype?.includes(arch.name)) return true;
  if (input.skipFor.strategy?.includes(arch.expectedStrategy)) return true;
  return false;
}

/**
 * 2D sweep: settings × scenarios. Renders one block per setting, each
 * containing all scenarios in the list. Lets us see how a single setting
 * change (e.g. target_bedtime) shifts predictions across the day in one
 * diff-friendly snapshot.
 */
function runSettingsSweep(
  arch: Archetype,
  settings: Array<{ label: string; overrides: Partial<Baby> }>,
  scenarios: ScenarioInput[],
): string {
  const blocks: string[] = [];
  blocks.push(`baby: ${arch.name} — settings sweep (${arch.summary})`);
  for (const setting of settings) {
    const variant: Archetype = {
      ...arch,
      baby: { ...arch.baby, ...setting.overrides },
    };
    blocks.push(`══ setting: ${setting.label} ══`);
    for (const input of scenarios) {
      if (shouldSkip(variant, input)) continue;
      const scn = buildScenario(variant, input);
      const result = assembleState(scn.data);
      assertInvariants({ archetype: variant, scenario: scn, prediction: result.prediction });
      assertExpectations(variant, input, result.prediction);
      blocks.push(renderPrediction(scn, result.prediction));
    }
  }
  return blocks.join("\n\n");
}

function assertExpectations(
  arch: Archetype,
  input: ScenarioInput,
  prediction: Prediction | null,
): void {
  if (!input.expect) return;
  const exp = input.expect[arch.expectedStrategy];
  if (!exp) return;
  const where = `${arch.name} :: ${input.label} (expect)`;

  if (exp.prediction === "null") {
    expect(prediction, `${where}: prediction must be null`).toBeNull();
    return;
  }
  if (!prediction) {
    throw new Error(`${where}: prediction is null but expectation requires fields`);
  }
  if (exp.bedtime === "null") {
    expect(prediction.bedtime, `${where}: bedtime must be null`).toBeNull();
  } else if (exp.bedtime === "set") {
    expect(prediction.bedtime, `${where}: bedtime must be set`).not.toBeNull();
  }
  if (exp.nextNap === "null") {
    expect(prediction.nextNap, `${where}: nextNap must be null`).toBeNull();
  } else if (exp.nextNap === "set") {
    expect(prediction.nextNap, `${where}: nextNap must be set`).not.toBeNull();
  }
  if (exp.predictedNaps === "null") {
    expect(prediction.predictedNaps, `${where}: predictedNaps must be null`).toBeNull();
  } else if (exp.predictedNaps === "set") {
    expect(prediction.predictedNaps, `${where}: predictedNaps must be set`).not.toBeNull();
    expect(prediction.predictedNaps!.length, `${where}: predictedNaps non-empty`).toBeGreaterThan(0);
  }
  if (exp.confidence === "null") {
    expect(prediction.confidence, `${where}: confidence must be null`).toBeNull();
  } else if (exp.confidence === "set") {
    expect(prediction.confidence, `${where}: confidence must be set`).not.toBeNull();
  }
}

/** Sparse logging (~11 mo): 6 scattered days, target 20:00 → emerging_rhythm. */
function buildIben(): Archetype {
  const baby = baseBaby({
    name: "Iben Sparse",
    birthdate: addDays(TODAY, -335), // ~11 months
    target_bedtime: "20:00",
  });
  const sleeps: SleepLogRow[] = [];
  // Only 6 scattered days in the last 21, with gaps. completeDays will be < 7
  // so routine_schedule is demoted to emerging_rhythm.
  const scatteredDays = [21, 18, 14, 9, 5, 2];
  for (const d of scatteredDays) {
    if (d <= 7) {
      sleeps.push(
        buildSleep({ spec: "10:00-11:00", dayOffset: -d, type: "nap" }),
        buildSleep({ spec: "14:30-15:15", dayOffset: -d, type: "nap" }),
      );
    } else {
      // Some days have only one nap logged — partial data
      sleeps.push(buildSleep({ spec: "10:30-11:45", dayOffset: -d, type: "nap" }));
    }
    // Half the days have a logged night, half don't.
    if (d % 3 === 0) {
      sleeps.push(buildSleep({ spec: "20:00-06:30", dayOffset: -d, type: "night" }));
    }
  }
  const todayStartMs = new Date(`${TODAY}T00:00:00.000Z`).getTime();
  return {
    name: "Iben Sparse",
    baby,
    recentSleeps: sleeps.filter(
      (s) => new Date(s.start_time).getTime() >= todayStartMs - 7 * 24 * 3_600_000,
    ),
    strategySleeps: sleeps,
    expectedStrategy: "emerging_rhythm",
    summary: "11mo, sparse, 6 scattered days",
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Strategy lock-in
//
// Sanity test: every archetype lands in its intended strategy under a vanilla
// "morning, just woke up" probe. If this fails the scenario sweeps would be
// running the wrong engine path, so check it explicitly first.
// ────────────────────────────────────────────────────────────────────────────

describe("archetype strategy lock-in", () => {
  it.each([
    ["Nora", buildNora],
    ["Eli", buildEli],
    ["Mina", buildMina],
    ["Oskar", buildOskar],
    ["Ada", buildAda],
    ["Iben", buildIben],
  ] as const)("%s lands in expected strategy", (_name, build) => {
    const arch = build();
    const probe = buildScenario(arch, { label: "_probe", now: "07:00" });
    const result = assembleState(probe.data);
    if (result.prediction) {
      expect(result.prediction.strategy).toBe(arch.expectedStrategy);
    } else {
      // Routine returns null only with no wake reference — probe always sets one.
      throw new Error(`probe returned null prediction for ${arch.name}`);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Mina Learned (8mo, 3-nap, target 19:15) — the canonical routine_schedule
// surface. Covers morning → mid-day → bedtime, active naps, cut-shorts.
// ────────────────────────────────────────────────────────────────────────────

describe("Mina Learned (3-nap routine_schedule)", () => {
  it("renders consistent predictions across the day", () => {
    const arch = buildMina();
    const scenarios: ScenarioInput[] = [
      // Morning bucket
      { label: "pristine 06:30 just woke", now: "06:30" },
      { label: "07:30 pre first nap", now: "07:30" },
      { label: "08:30 right at first-nap door", now: "08:30" },
      // After 1 nap done
      { label: "10:00 after first nap", now: "10:00", done: ["08:50-09:35"] },
      { label: "12:00 mid-day, before nap 2", now: "12:00", done: ["08:50-09:35"] },
      // Active nap
      { label: "12:30 active nap 2", now: "12:30",
        done: ["08:50-09:35"], active: "12:10" },
      // After 2 naps
      { label: "14:00 between nap 2 and nap 3", now: "14:00",
        done: ["12:10-13:20", "08:50-09:35"] },
      { label: "16:00 right after nap 3", now: "16:00",
        done: ["15:55-16:35", "12:10-13:20", "08:50-09:35"] },
      // All naps done — bedtime mode
      { label: "17:30 napsAllDone wind-down", now: "17:30",
        done: ["15:55-16:35", "12:10-13:20", "08:50-09:35"] },
      { label: "19:00 just before bedtime", now: "19:00",
        done: ["15:55-16:35", "12:10-13:20", "08:50-09:35"] },
      // Active night
      { label: "19:45 active night sleep", now: "19:45",
        done: ["15:55-16:35", "12:10-13:20", "08:50-09:35"], active: "19:20 night" },
      // Cut-short third nap (small but realistic)
      { label: "16:20 cut-short nap 3 (28m)", now: "16:20",
        done: ["15:50-16:18!", "12:10-13:20", "08:50-09:35"] },
      // Skipped second nap (long overdue)
      { label: "16:30 nap 2 skipped 4h+ ago", now: "16:30",
        done: ["08:50-09:35"] },
      // No wake reference (DST / hard-reset edge case)
      { label: "10:00 no wake reference", now: "10:00", wake: "none" },
    ];

    expect(runSweep(arch, scenarios)).toMatchInlineSnapshot(`
      "baby: Mina Learned (8mo, 3-nap, target 19:15, 21d)

      scenario: pristine 06:30 just woke
        now: 06:30
        inputs: wake=06:30 target=19:15
        strategy: routine_schedule
        nextNap: 08:55 (+2h 25m)
        bedtime: 19:15 (+12h 45m)
        predictedNaps: 08:55-09:40, 12:13-13:23, 15:54-16:34
        napsAllDone: false (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (3 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: 07:30 pre first nap
        now: 07:30
        inputs: wake=06:30 target=19:15
        strategy: routine_schedule
        nextNap: 08:55 (+1h 25m)
        bedtime: 19:15 (+11h 45m)
        predictedNaps: 08:55-09:40, 12:13-13:23, 15:54-16:34
        napsAllDone: false (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (3 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: 08:30 right at first-nap door
        now: 08:30
        inputs: wake=06:30 target=19:15
        strategy: routine_schedule
        nextNap: 08:55 (+25m)
        bedtime: 19:15 (+10h 45m)
        predictedNaps: 08:55-09:40, 12:13-13:23, 15:54-16:34
        napsAllDone: false (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (3 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: 10:00 after first nap
        now: 10:00
        inputs: wake=06:30 done=[08:50-09:35] target=19:15
        strategy: routine_schedule
        nextNap: 12:13 (+2h 13m)
        bedtime: 19:15 (+9h 15m)
        predictedNaps: 12:13-13:23, 15:54-16:34
        napsAllDone: false (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (2 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: 12:00 mid-day, before nap 2
        now: 12:00
        inputs: wake=06:30 done=[08:50-09:35] target=19:15
        strategy: routine_schedule
        nextNap: 12:13 (+13m)
        bedtime: 19:15 (+7h 15m)
        predictedNaps: 12:13-13:23, 15:54-16:34
        napsAllDone: false (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (2 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: 12:30 active nap 2
        now: 12:30
        inputs: wake=06:30 done=[08:50-09:35] active=12:10(nap) target=19:15
        strategy: routine_schedule
        nextNap: 15:54 (+3h 24m)
        bedtime: 19:15 (+6h 45m)
        predictedNaps: 15:54-16:34
        napsAllDone: false (3 expected)
        expectedNapEnd: 12:58 (+28m)
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (1 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: 14:00 between nap 2 and nap 3
        now: 14:00
        inputs: wake=06:30 done=[12:10-13:20, 08:50-09:35] target=19:15
        strategy: routine_schedule
        nextNap: 15:54 (+1h 54m)
        bedtime: 19:15 (+5h 15m)
        predictedNaps: 15:54-16:34
        napsAllDone: false (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (1 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: 16:00 right after nap 3
        now: 16:00
        inputs: wake=06:30 done=[15:55-16:35, 12:10-13:20, 08:50-09:35] target=19:15
        strategy: routine_schedule
        nextNap: 19:15 (+3h 15m)
        bedtime: 19:15 (+3h 15m)
        predictedNaps: none
        napsAllDone: true (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: 17:30 napsAllDone wind-down
        now: 17:30
        inputs: wake=06:30 done=[15:55-16:35, 12:10-13:20, 08:50-09:35] target=19:15
        strategy: routine_schedule
        nextNap: 19:15 (+1h 45m)
        bedtime: 19:15 (+1h 45m)
        predictedNaps: none
        napsAllDone: true (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: 19:00 just before bedtime
        now: 19:00
        inputs: wake=06:30 done=[15:55-16:35, 12:10-13:20, 08:50-09:35] target=19:15
        strategy: routine_schedule
        nextNap: 19:15 (+15m)
        bedtime: 19:15 (+15m)
        predictedNaps: none
        napsAllDone: true (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: 19:45 active night sleep
        now: 19:45
        inputs: wake=06:30 done=[15:55-16:35, 12:10-13:20, 08:50-09:35] active=19:20(night) target=19:15
        strategy: routine_schedule
        nextNap: 19:15 (-30m)
        bedtime: 19:15 (-30m)
        predictedNaps: none
        napsAllDone: true (3 expected)
        expectedNapEnd: none
        expectedNightEnd: 06:29 (+10h 44m)
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: 16:20 cut-short nap 3 (28m)
        now: 16:20
        inputs: wake=06:30 done=[15:50-16:18!, 12:10-13:20, 08:50-09:35] target=19:15
        strategy: routine_schedule
        nextNap: 19:15 (+2h 55m)
        bedtime: 19:15 (+2h 55m)
        predictedNaps: none
        napsAllDone: true (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: 16:30 nap 2 skipped 4h+ ago
        now: 16:30
        inputs: wake=06:30 done=[08:50-09:35] target=19:15
        strategy: routine_schedule
        nextNap: 17:00 (+30m)
        bedtime: 17:00 (+30m)
        predictedNaps: none
        napsAllDone: true (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: 10:00 no wake reference
        now: 10:00
        inputs: wake=none target=19:15
        prediction: none (no wake reference)"
    `);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Oskar OneNap (12mo, 1-nap, target 19:30) — the Halldis-shape, primary
// surface for cut-short / comeback / floor regressions. The recent prod
// bugs (May-7 floor, May-7 22h-17m, May-8 19:22) all live in this archetype.
// ────────────────────────────────────────────────────────────────────────────

describe("Oskar OneNap (1-nap routine_schedule, cut-short matrix)", () => {
  it("renders consistent predictions for normal day + cut-short matrix", () => {
    const arch = buildOskar();
    const scenarios: ScenarioInput[] = [
      // ── Normal day ────────────────────────────────────────────────────────
      { label: "06:00 just woke, fresh day", now: "06:00" },
      { label: "08:00 morning ramp", now: "08:00" },
      { label: "11:00 right at nap door", now: "11:00" },
      { label: "12:00 active nap (started 11:30)", now: "12:00", active: "11:30" },
      { label: "13:30 right after full nap", now: "13:30",
        done: ["11:30-13:20"] },
      { label: "16:00 mid-afternoon, napsAllDone", now: "16:00",
        done: ["11:30-13:20"] },
      { label: "19:00 just before bedtime", now: "19:00",
        done: ["11:30-13:20"] },
      { label: "19:45 active night sleep", now: "19:45",
        done: ["11:30-13:20"], active: "19:25 night" },

      // ── 5-min micro-nap ──────────────────────────────────────────────────
      // Compression discharge tiny (5/60)^0.7 ≈ 0.18 → factor ≈ 0.67. Floor
      // 165 min governs the comeback timing.
      { label: "5m micro: 11:30-11:35 cs, now 11:40 (cont open)", now: "11:40",
        done: ["11:30-11:35!"] },
      { label: "5m micro: cont closed at 12:01", now: "12:01",
        done: ["11:30-11:35!"] },

      // ── 20-min car-nap ───────────────────────────────────────────────────
      { label: "20m car: 11:30-11:50 cs, now 11:55 (cont open)", now: "11:55",
        done: ["11:30-11:50!"] },
      { label: "20m car: cont closed at 12:16", now: "12:16",
        done: ["11:30-11:50!"] },
      { label: "20m car: comeback +2h45m floor", now: "14:35",
        done: ["11:30-11:50!"] },

      // ── 35-min cut-short ─────────────────────────────────────────────────
      { label: "35m cs: just-after at 12:05 (cont open)", now: "12:05",
        done: ["11:30-12:05!"] },
      { label: "35m cs: 1h later", now: "13:05",
        done: ["11:30-12:05!"] },
      { label: "35m cs: at expected comeback +2h45m", now: "14:50",
        done: ["11:30-12:05!"] },
      { label: "35m cs: skipped comeback +5h", now: "17:00",
        done: ["11:30-12:05!"] },

      // ── 55-min cut-short ─────────────────────────────────────────────────
      { label: "55m cs: just-after 12:30 (cont open)", now: "12:30",
        done: ["11:30-12:25!"] },
      { label: "55m cs: 4h later, would-be comeback", now: "16:25",
        done: ["11:30-12:25!"] },

      // ── Active comeback after cut-short ──────────────────────────────────
      // Verifies rescue cap math + active path doesn't render a continuation
      // window even if the cut-short was recent.
      { label: "active comeback at 14:35 after 28m cs", now: "14:40",
        done: ["11:30-11:58!"], active: "14:35" },

      // ── KEY BUGS ─────────────────────────────────────────────────────────
      // May-8 19:22 bug: 46m cut-short + skipped synthetic comeback at 16:22.
      { label: "May-8 bug: 46m cs at 09:20-10:07, now 16:22", now: "16:22",
        done: ["09:20-10:06!"] },
      // Same shape, later — should still produce sane bedtime.
      { label: "May-8 bug: same cs, now 17:30", now: "17:30",
        done: ["09:20-10:06!"] },

      // May-7 22h-17m bug: two cut-shorts + heavy deficit.
      { label: "May-7 bug: 28m + 39m double cs, now 15:43", now: "15:43",
        done: ["10:05-10:44!", "06:21-06:49!"] },

      // May-7 11:07 floor bug: 28m cut-short, target 18:00, 1-nap.
      { label: "May-7 floor: 28m cs at 06:21-06:49, now 08:12", now: "08:12",
        done: ["06:21-06:49!"], target: "18:00" },

      // ── No wake reference ────────────────────────────────────────────────
      { label: "no wake set yet (returns null)", now: "10:00", wake: "none" },
    ];

    expect(runSweep(arch, scenarios)).toMatchInlineSnapshot(`
      "baby: Oskar OneNap (12mo, 1-nap, target 19:30, 21d)

      scenario: 06:00 just woke, fresh day
        now: 06:00
        inputs: wake=06:00 target=19:30
        strategy: routine_schedule
        nextNap: 11:07 (+5h 07m)
        bedtime: 19:17 (+13h 17m)
        predictedNaps: 11:07-12:57
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: medium (1 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 08:00 morning ramp
        now: 08:00
        inputs: wake=06:00 target=19:30
        strategy: routine_schedule
        nextNap: 11:07 (+3h 07m)
        bedtime: 19:17 (+11h 17m)
        predictedNaps: 11:07-12:57
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: medium (1 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 11:00 right at nap door
        now: 11:00
        inputs: wake=06:00 target=19:30
        strategy: routine_schedule
        nextNap: 11:07 (+07m)
        bedtime: 19:17 (+8h 17m)
        predictedNaps: 11:07-12:57
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: medium (1 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 12:00 active nap (started 11:30)
        now: 12:00
        inputs: wake=06:00 active=11:30(nap) target=19:30
        strategy: routine_schedule
        nextNap: 19:32 (+7h 32m)
        bedtime: 19:32 (+7h 32m)
        predictedNaps: none
        napsAllDone: true (1 expected)
        expectedNapEnd: 13:25 (+1h 25m)
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 13:30 right after full nap
        now: 13:30
        inputs: wake=06:00 done=[11:30-13:20] target=19:30
        strategy: routine_schedule
        nextNap: 19:30 (+6h 00m)
        bedtime: 19:30 (+6h 00m)
        predictedNaps: none
        napsAllDone: true (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 16:00 mid-afternoon, napsAllDone
        now: 16:00
        inputs: wake=06:00 done=[11:30-13:20] target=19:30
        strategy: routine_schedule
        nextNap: 19:30 (+3h 30m)
        bedtime: 19:30 (+3h 30m)
        predictedNaps: none
        napsAllDone: true (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 19:00 just before bedtime
        now: 19:00
        inputs: wake=06:00 done=[11:30-13:20] target=19:30
        strategy: routine_schedule
        nextNap: 19:30 (+30m)
        bedtime: 19:30 (+30m)
        predictedNaps: none
        napsAllDone: true (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 19:45 active night sleep
        now: 19:45
        inputs: wake=06:00 done=[11:30-13:20] active=19:25(night) target=19:30
        strategy: routine_schedule
        nextNap: 19:30 (-15m)
        bedtime: 19:30 (-15m)
        predictedNaps: none
        napsAllDone: true (1 expected)
        expectedNapEnd: none
        expectedNightEnd: 05:58 (+10h 13m)
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 5m micro: 11:30-11:35 cs, now 11:40 (cont open)
        now: 11:40
        inputs: wake=06:00 done=[11:30-11:35!] target=19:30
        strategy: routine_schedule
        nextNap: 14:56 (+3h 16m)
        bedtime: 19:14 (+7h 34m)
        predictedNaps: 14:56-16:46
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: closes 12:00 cap 13:23
        confidence: medium (1 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 5m micro: cont closed at 12:01
        now: 12:01
        inputs: wake=06:00 done=[11:30-11:35!] target=19:30
        strategy: routine_schedule
        nextNap: 14:56 (+2h 55m)
        bedtime: 19:14 (+7h 13m)
        predictedNaps: 14:56-16:46
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: medium (1 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 20m car: 11:30-11:50 cs, now 11:55 (cont open)
        now: 11:55
        inputs: wake=06:00 done=[11:30-11:50!] target=19:30
        strategy: routine_schedule
        nextNap: 15:45 (+3h 50m)
        bedtime: 19:16 (+7h 21m)
        predictedNaps: 15:45-17:35
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: closes 12:15 cap 13:23
        confidence: medium (1 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 20m car: cont closed at 12:16
        now: 12:16
        inputs: wake=06:00 done=[11:30-11:50!] target=19:30
        strategy: routine_schedule
        nextNap: 15:45 (+3h 29m)
        bedtime: 19:16 (+7h 00m)
        predictedNaps: 15:45-17:35
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: medium (1 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 20m car: comeback +2h45m floor
        now: 14:35
        inputs: wake=06:00 done=[11:30-11:50!] target=19:30
        strategy: routine_schedule
        nextNap: 15:45 (+1h 10m)
        bedtime: 19:16 (+4h 41m)
        predictedNaps: 15:45-17:35
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: medium (1 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 35m cs: just-after at 12:05 (cont open)
        now: 12:05
        inputs: wake=06:00 done=[11:30-12:05!] target=19:30
        strategy: routine_schedule
        nextNap: 16:27 (+4h 22m)
        bedtime: 19:18 (+7h 13m)
        predictedNaps: 16:27-18:17
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: closes 12:30 cap 13:23
        confidence: medium (1 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 35m cs: 1h later
        now: 13:05
        inputs: wake=06:00 done=[11:30-12:05!] target=19:30
        strategy: routine_schedule
        nextNap: 16:27 (+3h 22m)
        bedtime: 19:18 (+6h 13m)
        predictedNaps: 16:27-18:17
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: medium (1 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 35m cs: at expected comeback +2h45m
        now: 14:50
        inputs: wake=06:00 done=[11:30-12:05!] target=19:30
        strategy: routine_schedule
        nextNap: 16:27 (+1h 37m)
        bedtime: 19:18 (+4h 28m)
        predictedNaps: 16:27-18:17
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: medium (1 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 35m cs: skipped comeback +5h
        now: 17:00
        inputs: wake=06:00 done=[11:30-12:05!] target=19:30
        strategy: routine_schedule
        nextNap: 16:27 (-32m)
        bedtime: 19:18 (+2h 18m)
        predictedNaps: 16:27-18:17
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: medium (1 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 55m cs: just-after 12:30 (cont open)
        now: 12:30
        inputs: wake=06:00 done=[11:30-12:25!] target=19:30
        strategy: routine_schedule
        nextNap: 17:25 (+4h 55m)
        bedtime: 19:21 (+6h 51m)
        predictedNaps: none
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: closes 12:50 cap 13:23
        confidence: high (0 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 55m cs: 4h later, would-be comeback
        now: 16:25
        inputs: wake=06:00 done=[11:30-12:25!] target=19:30
        strategy: routine_schedule
        nextNap: 17:25 (+1h 00m)
        bedtime: 19:21 (+2h 56m)
        predictedNaps: none
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: active comeback at 14:35 after 28m cs
        now: 14:40
        inputs: wake=06:00 done=[11:30-11:58!] active=14:35(nap) target=19:30
        strategy: routine_schedule
        nextNap: 19:58 (+5h 18m)
        bedtime: 19:58 (+5h 18m)
        predictedNaps: none
        napsAllDone: true (1 expected)
        expectedNapEnd: 16:30 (+1h 50m)
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: May-8 bug: 46m cs at 09:20-10:07, now 16:22
        now: 16:22
        inputs: wake=06:00 done=[09:20-10:06!] target=19:30
        strategy: routine_schedule
        nextNap: 19:00 (+2h 38m)
        bedtime: 19:00 (+2h 38m)
        predictedNaps: none
        napsAllDone: true (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: May-8 bug: same cs, now 17:30
        now: 17:30
        inputs: wake=06:00 done=[09:20-10:06!] target=19:30
        strategy: routine_schedule
        nextNap: 19:00 (+1h 30m)
        bedtime: 19:00 (+1h 30m)
        predictedNaps: none
        napsAllDone: true (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: May-7 bug: 28m + 39m double cs, now 15:43
        now: 15:43
        inputs: wake=06:00 done=[10:05-10:44!, 06:21-06:49!] target=19:30
        strategy: routine_schedule
        nextNap: 15:44 (+01m)
        bedtime: 19:06 (+3h 23m)
        predictedNaps: none
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: May-7 floor: 28m cs at 06:21-06:49, now 08:12
        now: 08:12
        inputs: wake=06:00 done=[06:21-06:49!] target=18:00
        strategy: routine_schedule
        nextNap: 10:42 (+2h 30m)
        bedtime: 19:17 (+11h 05m)
        predictedNaps: 10:42-12:32
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: medium (1 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: no wake set yet (returns null)
        now: 10:00
        inputs: wake=none target=19:30
        prediction: none (no wake reference)"
    `);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Nora Newborn (4w, fragmented) — newborn_guidance only renders sleepWindow,
// sleepPressure, rolling stats, ageNorms. Schedule fields are all null.
// ────────────────────────────────────────────────────────────────────────────

describe("Nora Newborn (newborn_guidance)", () => {
  it("renders sleep-window guidance across the day", () => {
    const arch = buildNora();
    const scenarios: ScenarioInput[] = [
      { label: "07:00 morning, no nap yet", now: "07:00" },
      { label: "09:00 fed and active", now: "09:00",
        done: ["07:30-08:00"] },
      { label: "10:30 active nap", now: "10:30", active: "10:00",
        done: ["07:30-08:00"] },
      { label: "12:30 just woke from second nap", now: "12:30",
        done: ["09:45-10:25", "07:30-08:00"] },
      { label: "16:00 mid-afternoon", now: "16:00",
        done: ["13:30-14:15", "11:30-11:55", "09:45-10:25", "07:30-08:00"] },
      { label: "20:00 evening, sleep window opens", now: "20:00",
        done: ["17:30-18:00", "15:30-15:55", "13:30-14:15", "11:30-11:55"] },
      { label: "22:00 active night sleep", now: "22:00",
        active: "21:30 night",
        done: ["17:30-18:00", "15:30-15:55", "13:30-14:15", "11:30-11:55"] },
      { label: "no wake set: still produces newborn output", now: "08:00",
        wake: "none" },
    ];

    expect(runSweep(arch, scenarios)).toMatchInlineSnapshot(`
      "baby: Nora Newborn (4w, 5–7 fragmented naps, target 20:30)

      scenario: 07:00 morning, no nap yet
        now: 07:00
        inputs: wake=06:30 target=20:30
        strategy: newborn_guidance
        nextNap: none
        bedtime: none
        predictedNaps: none
        napsAllDone: false (0 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 03:50–04:50
        sleepPressure: high

      scenario: 09:00 fed and active
        now: 09:00
        inputs: wake=06:30 done=[07:30-08:00] target=20:30
        strategy: newborn_guidance
        nextNap: none
        bedtime: none
        predictedNaps: none
        napsAllDone: false (0 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 08:50–09:50
        sleepPressure: rising

      scenario: 10:30 active nap
        now: 10:30
        inputs: wake=06:30 done=[07:30-08:00] active=10:00(nap) target=20:30
        strategy: newborn_guidance
        nextNap: none
        bedtime: none
        predictedNaps: none
        napsAllDone: false (0 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 08:50–09:50
        sleepPressure: high

      scenario: 12:30 just woke from second nap
        now: 12:30
        inputs: wake=06:30 done=[09:45-10:25, 07:30-08:00] target=20:30
        strategy: newborn_guidance
        nextNap: none
        bedtime: none
        predictedNaps: none
        napsAllDone: false (0 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 11:15–12:15
        sleepPressure: high

      scenario: 16:00 mid-afternoon
        now: 16:00
        inputs: wake=06:30 done=[13:30-14:15, 11:30-11:55, 09:45-10:25, 07:30-08:00] target=20:30
        strategy: newborn_guidance
        nextNap: none
        bedtime: none
        predictedNaps: none
        napsAllDone: false (0 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 15:05–16:05
        sleepPressure: high

      scenario: 20:00 evening, sleep window opens
        now: 20:00
        inputs: wake=06:30 done=[17:30-18:00, 15:30-15:55, 13:30-14:15, 11:30-11:55] target=20:30
        strategy: newborn_guidance
        nextNap: none
        bedtime: none
        predictedNaps: none
        napsAllDone: false (0 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 18:50–19:50
        sleepPressure: high

      scenario: 22:00 active night sleep
        now: 22:00
        inputs: wake=06:30 done=[17:30-18:00, 15:30-15:55, 13:30-14:15, 11:30-11:55] active=21:30(night) target=20:30
        strategy: newborn_guidance
        nextNap: none
        bedtime: none
        predictedNaps: none
        napsAllDone: false (0 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 18:50–19:50
        sleepPressure: high

      scenario: no wake set: still produces newborn output
        now: 08:00
        inputs: wake=none target=20:30
        strategy: newborn_guidance
        nextNap: none
        bedtime: none
        predictedNaps: none
        napsAllDone: false (0 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 03:50–04:50
        sleepPressure: high"
    `);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Eli Emerging (3.5mo, 4-nap) — emerging_rhythm: schedule-shaped predictions
// without confidence/learnedSchedule, plus newborn-style rolling stats.
// ────────────────────────────────────────────────────────────────────────────

describe("Eli Emerging (emerging_rhythm)", () => {
  it("renders adapter-shape predictions across the day", () => {
    const arch = buildEli();
    const scenarios: ScenarioInput[] = [
      { label: "06:30 just woke, fresh day", now: "06:30" },
      { label: "08:30 right at first-nap door", now: "08:30" },
      { label: "10:00 after first nap", now: "10:00",
        done: ["08:00-08:50"] },
      { label: "12:30 mid-day after 2 naps", now: "12:30",
        done: ["11:00-11:50", "08:00-08:50"] },
      { label: "14:30 active nap 3", now: "14:30",
        done: ["11:00-11:50", "08:00-08:50"], active: "14:00" },
      { label: "17:30 after 4 naps, evening", now: "17:30",
        done: ["17:00-17:45", "14:30-15:20", "11:00-11:50", "08:00-08:50"] },
      { label: "19:45 active night", now: "19:45",
        done: ["17:00-17:45", "14:30-15:20", "11:00-11:50", "08:00-08:50"],
        active: "19:30 night" },
      { label: "30m cut-short nap 2, now 12:30", now: "12:30",
        done: ["11:00-11:30!", "08:00-08:50"] },
      { label: "no wake reference", now: "10:00", wake: "none" },
    ];

    expect(runSweep(arch, scenarios)).toMatchInlineSnapshot(`
      "baby: Eli Emerging (3.5mo, 4-nap, target 19:45, 21d)

      scenario: 06:30 just woke, fresh day
        now: 06:30
        inputs: wake=06:00 target=19:45
        strategy: emerging_rhythm
        nextNap: 06:52 (+22m)
        bedtime: 17:30 (+11h 00m)
        predictedNaps: 06:52-07:42, 09:46-10:41, 12:14-13:04, 15:10-15:55
        napsAllDone: false (4 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 07:15–08:35
        sleepPressure: low

      scenario: 08:30 right at first-nap door
        now: 08:30
        inputs: wake=06:00 target=19:45
        strategy: emerging_rhythm
        nextNap: 09:46 (+1h 16m)
        bedtime: 17:30 (+9h 00m)
        predictedNaps: 09:46-10:41, 12:14-13:04, 15:10-15:55
        napsAllDone: false (4 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 07:15–08:35
        sleepPressure: high

      scenario: 10:00 after first nap
        now: 10:00
        inputs: wake=06:00 done=[08:00-08:50] target=19:45
        strategy: emerging_rhythm
        nextNap: 09:59 (-00m)
        bedtime: 17:43 (+7h 43m)
        predictedNaps: 09:59-10:54, 12:27-13:17, 15:23-16:08
        napsAllDone: false (4 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 10:05–11:25
        sleepPressure: low

      scenario: 12:30 mid-day after 2 naps
        now: 12:30
        inputs: wake=06:00 done=[11:00-11:50, 08:00-08:50] target=19:45
        strategy: emerging_rhythm
        nextNap: 12:27 (-02m)
        bedtime: 17:43 (+5h 13m)
        predictedNaps: 12:27-13:17, 15:23-16:08
        napsAllDone: false (4 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 13:05–14:25
        sleepPressure: low

      scenario: 14:30 active nap 3
        now: 14:30
        inputs: wake=06:00 done=[11:00-11:50, 08:00-08:50] active=14:00(nap) target=19:45
        strategy: emerging_rhythm
        nextNap: 15:44 (+1h 14m)
        bedtime: 18:04 (+3h 34m)
        predictedNaps: 15:44-16:29
        napsAllDone: false (4 expected)
        expectedNapEnd: 14:49 (+19m)
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 13:05–14:25
        sleepPressure: high

      scenario: 17:30 after 4 naps, evening
        now: 17:30
        inputs: wake=06:00 done=[17:00-17:45, 14:30-15:20, 11:00-11:50, 08:00-08:50] target=19:45
        strategy: emerging_rhythm
        nextNap: 19:28 (+1h 58m)
        bedtime: 19:28 (+1h 58m)
        predictedNaps: none
        napsAllDone: true (4 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 19:00–20:20
        sleepPressure: low

      scenario: 19:45 active night
        now: 19:45
        inputs: wake=06:00 done=[17:00-17:45, 14:30-15:20, 11:00-11:50, 08:00-08:50] active=19:30(night) target=19:45
        strategy: emerging_rhythm
        nextNap: 19:28 (-16m)
        bedtime: 19:28 (-16m)
        predictedNaps: none
        napsAllDone: true (4 expected)
        expectedNapEnd: none
        expectedNightEnd: 05:59 (+10h 14m)
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 19:00–20:20
        sleepPressure: rising

      scenario: 30m cut-short nap 2, now 12:30
        now: 12:30
        inputs: wake=06:00 done=[11:00-11:30!, 08:00-08:50] target=19:45
        strategy: emerging_rhythm
        nextNap: 12:27 (-02m)
        bedtime: 17:43 (+5h 13m)
        predictedNaps: 12:27-13:17, 15:23-16:08
        napsAllDone: false (4 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 12:45–14:05
        sleepPressure: low

      scenario: no wake reference
        now: 10:00
        inputs: wake=none target=19:45
        strategy: emerging_rhythm
        nextNap: none
        bedtime: none
        predictedNaps: none
        napsAllDone: false (4 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 07:15–08:35
        sleepPressure: high"
    `);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Ada NoTarget (10mo, 2-nap, target_bedtime: null) — verify follow-the-baby
// mode produces a finite bedtime and doesn't crash on missing target.
// ────────────────────────────────────────────────────────────────────────────

describe("Ada NoTarget (2-nap, no target_bedtime)", () => {
  it("produces sane predictions without target_bedtime", () => {
    const arch = buildAda();
    const scenarios: ScenarioInput[] = [
      { label: "06:00 fresh day, no target", now: "06:00" },
      { label: "09:00 right at first nap", now: "09:00" },
      { label: "11:00 after first nap", now: "11:00",
        done: ["09:30-10:50"] },
      { label: "13:30 right at second nap", now: "13:30",
        done: ["09:30-10:50"] },
      { label: "14:00 active nap 2", now: "14:00",
        done: ["09:30-10:50"], active: "13:30" },
      { label: "15:30 after 2 naps", now: "15:30",
        done: ["13:30-14:50", "09:30-10:50"] },
      { label: "18:30 evening, napsAllDone", now: "18:30",
        done: ["13:30-14:50", "09:30-10:50"] },
      { label: "20:00 just before bedtime", now: "20:00",
        done: ["13:30-14:50", "09:30-10:50"] },
      // Override: prove that adding a target would change the result
      { label: "06:00 same day with target=18:00 override", now: "06:00",
        target: "18:00" },
    ];

    expect(runSweep(arch, scenarios)).toMatchInlineSnapshot(`
      "baby: Ada NoTarget (10mo, 2-nap, no target, 21d)

      scenario: 06:00 fresh day, no target
        now: 06:00
        inputs: wake=06:00 target=none
        strategy: routine_schedule
        nextNap: 09:07 (+3h 07m)
        bedtime: 19:00 (+13h 00m)
        predictedNaps: 09:07-10:27, 13:30-14:50
        napsAllDone: false (2 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (2 napRanges)
        learned: nap=80m night=660m ww=183.1m bedww=250m

      scenario: 09:00 right at first nap
        now: 09:00
        inputs: wake=06:00 target=none
        strategy: routine_schedule
        nextNap: 09:07 (+07m)
        bedtime: 19:00 (+10h 00m)
        predictedNaps: 09:07-10:27, 13:30-14:50
        napsAllDone: false (2 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (2 napRanges)
        learned: nap=80m night=660m ww=183.1m bedww=250m

      scenario: 11:00 after first nap
        now: 11:00
        inputs: wake=06:00 done=[09:30-10:50] target=none
        strategy: routine_schedule
        nextNap: 13:30 (+2h 30m)
        bedtime: 19:00 (+8h 00m)
        predictedNaps: 13:30-14:50
        napsAllDone: false (2 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (1 napRanges)
        learned: nap=80m night=660m ww=183.1m bedww=250m

      scenario: 13:30 right at second nap
        now: 13:30
        inputs: wake=06:00 done=[09:30-10:50] target=none
        strategy: routine_schedule
        nextNap: 13:30 (+00m)
        bedtime: 19:00 (+5h 30m)
        predictedNaps: 13:30-14:50
        napsAllDone: false (2 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (1 napRanges)
        learned: nap=80m night=660m ww=183.1m bedww=250m

      scenario: 14:00 active nap 2
        now: 14:00
        inputs: wake=06:00 done=[09:30-10:50] active=13:30(nap) target=none
        strategy: routine_schedule
        nextNap: 19:00 (+5h 00m)
        bedtime: 19:00 (+5h 00m)
        predictedNaps: none
        napsAllDone: true (2 expected)
        expectedNapEnd: 14:51 (+51m)
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=80m night=660m ww=183.1m bedww=250m

      scenario: 15:30 after 2 naps
        now: 15:30
        inputs: wake=06:00 done=[13:30-14:50, 09:30-10:50] target=none
        strategy: routine_schedule
        nextNap: 19:00 (+3h 30m)
        bedtime: 19:00 (+3h 30m)
        predictedNaps: none
        napsAllDone: true (2 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=80m night=660m ww=183.1m bedww=250m

      scenario: 18:30 evening, napsAllDone
        now: 18:30
        inputs: wake=06:00 done=[13:30-14:50, 09:30-10:50] target=none
        strategy: routine_schedule
        nextNap: 19:00 (+30m)
        bedtime: 19:00 (+30m)
        predictedNaps: none
        napsAllDone: true (2 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=80m night=660m ww=183.1m bedww=250m

      scenario: 20:00 just before bedtime
        now: 20:00
        inputs: wake=06:00 done=[13:30-14:50, 09:30-10:50] target=none
        strategy: routine_schedule
        nextNap: 19:00 (-1h 00m)
        bedtime: 19:00 (-1h 00m)
        predictedNaps: none
        napsAllDone: true (2 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=80m night=660m ww=183.1m bedww=250m

      scenario: 06:00 same day with target=18:00 override
        now: 06:00
        inputs: wake=06:00 target=18:00
        strategy: routine_schedule
        nextNap: 09:07 (+3h 07m)
        bedtime: 19:00 (+13h 00m)
        predictedNaps: 09:07-10:27, 13:30-14:50
        napsAllDone: false (2 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (2 napRanges)
        learned: nap=80m night=660m ww=183.1m bedww=250m"
    `);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Iben Sparse (11mo, scattered logging) — emerging_rhythm via demotion.
// Stress-tests the engine's behavior when data is incomplete.
// ────────────────────────────────────────────────────────────────────────────

describe("Iben Sparse (emerging_rhythm via demotion)", () => {
  it("handles sparse history gracefully", () => {
    const arch = buildIben();
    const scenarios: ScenarioInput[] = [
      { label: "06:30 sparse day start", now: "06:30" },
      { label: "10:30 mid-morning, no nap yet", now: "10:30" },
      { label: "12:00 after first nap", now: "12:00",
        done: ["10:00-11:00"] },
      { label: "15:30 after second nap", now: "15:30",
        done: ["14:30-15:15", "10:00-11:00"] },
      { label: "20:00 evening", now: "20:00",
        done: ["14:30-15:15", "10:00-11:00"] },
      { label: "11:00 active mid-morning nap", now: "11:00", active: "10:30" },
      { label: "no wake reference", now: "08:00", wake: "none" },
    ];

    expect(runSweep(arch, scenarios)).toMatchInlineSnapshot(`
      "baby: Iben Sparse (11mo, sparse, 6 scattered days)

      scenario: 06:30 sparse day start
        now: 06:30
        inputs: wake=06:30 target=20:00
        strategy: emerging_rhythm
        nextNap: 10:00 (+3h 30m)
        bedtime: 20:00 (+13h 30m)
        predictedNaps: 10:00-11:04, 14:54-15:58
        napsAllDone: false (2 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 16:30–17:45
        sleepPressure: high

      scenario: 10:30 mid-morning, no nap yet
        now: 10:30
        inputs: wake=06:30 target=20:00
        strategy: emerging_rhythm
        nextNap: 10:00 (-30m)
        bedtime: 19:33 (+9h 03m)
        predictedNaps: 10:00-11:04, 15:04-16:08
        napsAllDone: false (2 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 16:30–17:45
        sleepPressure: high

      scenario: 12:00 after first nap
        now: 12:00
        inputs: wake=06:30 done=[10:00-11:00] target=20:00
        strategy: emerging_rhythm
        nextNap: 14:54 (+2h 54m)
        bedtime: 20:00 (+8h 00m)
        predictedNaps: 14:54-15:58
        napsAllDone: false (2 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 12:15–13:30
        sleepPressure: low

      scenario: 15:30 after second nap
        now: 15:30
        inputs: wake=06:30 done=[14:30-15:15, 10:00-11:00] target=20:00
        strategy: emerging_rhythm
        nextNap: 19:46 (+4h 16m)
        bedtime: 19:46 (+4h 16m)
        predictedNaps: none
        napsAllDone: true (2 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 16:30–17:45
        sleepPressure: low

      scenario: 20:00 evening
        now: 20:00
        inputs: wake=06:30 done=[14:30-15:15, 10:00-11:00] target=20:00
        strategy: emerging_rhythm
        nextNap: 19:46 (-13m)
        bedtime: 19:46 (-13m)
        predictedNaps: none
        napsAllDone: true (2 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 16:30–17:45
        sleepPressure: high

      scenario: 11:00 active mid-morning nap
        now: 11:00
        inputs: wake=06:30 active=10:30(nap) target=20:00
        strategy: emerging_rhythm
        nextNap: 14:54 (+3h 54m)
        bedtime: 20:00 (+9h 00m)
        predictedNaps: 14:54-15:58
        napsAllDone: false (2 expected)
        expectedNapEnd: 11:31 (+31m)
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 16:30–17:45
        sleepPressure: high

      scenario: no wake reference
        now: 08:00
        inputs: wake=none target=20:00
        strategy: emerging_rhythm
        nextNap: none
        bedtime: none
        predictedNaps: none
        napsAllDone: false (2 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 16:30–17:45
        sleepPressure: high"
    `);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Paired-baseline invariants
//
// These tests assert RELATIONSHIPS between scenarios that no single snapshot
// can capture — e.g. "the May-8 19:22 bug is a paired regression: bedtime
// when a synthetic comeback is in the past must equal bedtime when there's
// no comeback at all". Pinned here so a snapshot update can never reintroduce
// the bug on its own.
// ────────────────────────────────────────────────────────────────────────────

describe("paired-baseline invariants", () => {
  it("Oskar: skipped synthetic comeback does not pull bedtime later than baseline", () => {
    // The May-8 bug: a 46m cut-short at 09:20-10:07 plus 6h+ wait without a
    // comeback nap predicted bedtime 19:22 — way too late. With the fix,
    // the synthetic comeback's start time (in the past at 16:22) is dropped
    // from the pressure base and bedtime collapses toward the no-comeback
    // baseline.
    const arch = buildOskar();

    const withCs = buildScenario(arch, {
      label: "with cs", now: "16:22",
      done: ["09:20-10:06!"],
    });
    const withCsResult = assembleState(withCs.data);

    const noCs = buildScenario(arch, {
      label: "no cs", now: "16:22",
      done: [],
    });
    const noCsResult = assembleState(noCs.data);

    const withCsBedtime = new Date(withCsResult.prediction!.bedtime!).getTime();
    const noCsBedtime = new Date(noCsResult.prediction!.bedtime!).getTime();
    const diffMin = Math.abs(withCsBedtime - noCsBedtime) / 60_000;

    // With the fix the bedtimes track within ~45 min. Pre-fix the gap was
    // > 2.5 hours (19:22 vs ~16:50).
    expect(diffMin).toBeLessThanOrEqual(60);
  });

  it("Oskar: bedtime stays on TODAY across heavy-deficit cut-short days", () => {
    // The May-7 22h-17m bug. Two cut-shorts + heavy deficit + late afternoon.
    // Bedtime must land on May 15 in Oslo, in a sane evening window.
    const arch = buildOskar();
    const scn = buildScenario(arch, {
      label: "double cs", now: "15:43",
      done: ["10:05-10:44!", "06:21-06:49!"],
    });
    const result = assembleState(scn.data);
    const bedtimeIso = result.prediction!.bedtime!;
    expect(osloDate(bedtimeIso)).toBe(TODAY);
    const bedtimeHourOslo = parseInt(osloHHMM(bedtimeIso).split(":")[0]);
    expect(bedtimeHourOslo).toBeGreaterThanOrEqual(16);
    expect(bedtimeHourOslo).toBeLessThanOrEqual(22);
  });

  it("Oskar: 28m cut-short floor enforced ≥ 2h45m on comeback nextNap", () => {
    // The May-7 11:07 floor bug. 28m cut-short ending 06:49, comeback must
    // be ≥ 09:34 (cs.end + 2h45m), regardless of what the natural day plan
    // would suggest.
    const arch = buildOskar();
    const scn = buildScenario(arch, {
      label: "floor", now: "08:12",
      done: ["06:21-06:49!"], target: "18:00",
    });
    const result = assembleState(scn.data);
    const cutEndMs = new Date(osloIso(TODAY, "06:49")).getTime();
    const nextMs = new Date(result.prediction!.nextNap!).getTime();
    expect(nextMs - cutEndMs).toBeGreaterThanOrEqual(165 * 60_000);
  });

  it("Mina: target_bedtime nudges bedtime asymmetrically (≤15m earlier, ≤30m later)", () => {
    // 2026-05-08 review surfaced that target_bedtime was effectively cosmetic
    // (DAILY_SHIFT_CAP_MS was a tight 15 min in BOTH directions). Fix:
    // asymmetric daily caps reflecting how baby-bedtime adjustment works in
    // real life — keeping baby up longer is the easier direction (45 min),
    // putting baby down earlier is harder and must be gradual (15 min). The
    // multi-day convergence is tested separately in
    // "target_bedtime convergence over a week".
    const arch = buildMina();

    const naturalArch = { ...arch, baby: { ...arch.baby, target_bedtime: null } };
    const earlyArch = { ...arch, baby: { ...arch.baby, target_bedtime: "18:00" } };
    const lateArch = { ...arch, baby: { ...arch.baby, target_bedtime: "21:00" } };

    const naturalRes = assembleState(buildScenario(naturalArch, { label: "natural", now: "06:30" }).data);
    const earlyRes = assembleState(buildScenario(earlyArch, { label: "early", now: "06:30" }).data);
    const lateRes = assembleState(buildScenario(lateArch, { label: "late", now: "06:30" }).data);

    const naturalMs = new Date(naturalRes.prediction!.bedtime!).getTime();
    const earlyMs = new Date(earlyRes.prediction!.bedtime!).getTime();
    const lateMs = new Date(lateRes.prediction!.bedtime!).getTime();

    expect(earlyMs, "target=18:00 should not push bedtime later than natural")
      .toBeLessThanOrEqual(naturalMs);
    expect(lateMs, "target=21:00 should not pull bedtime earlier than natural")
      .toBeGreaterThanOrEqual(naturalMs);
    expect((naturalMs - earlyMs) / 60_000, "earlier shift capped at 15 min/day (gradual)")
      .toBeLessThanOrEqual(15);
    expect((lateMs - naturalMs) / 60_000, "later shift capped at 30 min/day")
      .toBeLessThanOrEqual(30);
  });

  it("target_bedtime convergence: 14-day simulation slides toward target", () => {
    // The app's adjustment story is multi-day, not single-day. A parent
    // who sets a new target sees today's prediction nudge toward target
    // by at most the daily cap; tomorrow's history reflects the new
    // bedtime, so the natural anchor moves a step closer to target; the
    // engine converges gradually over ~10-14 days.
    //
    // The test simulates 14 days of Mina with target=18:00, feeding
    // each day's full predicted plan (naps + bedtime) back into history
    // as the parent's actual sleep log.
    //
    // Convergence relies on the "target-nudged" plan candidate added
    // to selectBestPlan in 2026-05 (a third candidate alongside natural
    // and target-guided that shifts the LAST nap and bedtime by the
    // capped amount). Without it, the natural plan always won the score
    // and bedtime stayed anchored to history regardless of target.

    const baseArch = buildMina();
    const target = "18:00";

    let recentSleeps: SleepLogRow[] = [...baseArch.recentSleeps];
    let strategySleeps: SleepLogRow[] = [...baseArch.strategySleeps];
    const trail: string[] = [];

    for (let day = 0; day < 14; day++) {
      const today = addDays(TODAY, day);
      const wake = wakeRow(today, "06:30");
      const baby = { ...baseArch.baby, target_bedtime: target };
      const data: DayData = {
        baby,
        activeSleep: undefined,
        todaySleeps: [],
        recentSleeps,
        strategySleeps,
        todayWakeUp: wake,
        pausesBySleep: new Map(),
        diaperCount: 0,
        lastDiaperTime: null,
        now: new Date(osloIso(today, "06:30")).getTime(),
      };
      const result = assembleState(data);
      const p = result.prediction!;
      const predBedtime = p.bedtime!;
      const predHHMM = osloHHMM(predBedtime);
      trail.push(`day ${day}: bedtime=${predHHMM}`);

      // Simulate parent following the engine's whole-day suggestion:
      // append all predicted naps AND the night to history. Without the
      // naps, the 7-day learning window starves of nap data after a week
      // and natural drifts toward defaults — that's a test artifact, not
      // a real parent.
      for (const nap of p.predictedNaps ?? []) {
        const napStart = osloHHMM(nap.startTime);
        const napEnd = osloHHMM(nap.endTime);
        const napRow = buildSleep({
          spec: `${napStart}-${napEnd}`,
          dayOffset: day,
          type: "nap",
        });
        strategySleeps.push(napRow);
      }
      const nightRow = buildSleep({
        spec: `${predHHMM}-06:30`,
        dayOffset: day,
        type: "night",
      });
      nightRow.end_time = osloIso(addDays(today, 1), "06:30");
      strategySleeps.push(nightRow);

      const cutoffMs = new Date(osloIso(today, "06:30")).getTime() - 7 * 24 * 3_600_000;
      recentSleeps = strategySleeps.filter(
        (s) => new Date(s.start_time).getTime() >= cutoffMs,
      );
      // Mirror production's 21-day strategy window so old base entries
      // roll off and the test stays bounded.
      const strategyCutoffMs = new Date(osloIso(today, "06:30")).getTime() - 21 * 24 * 3_600_000;
      strategySleeps = strategySleeps.filter(
        (s) => new Date(s.start_time).getTime() >= strategyCutoffMs,
      );
    }

    expect(trail.join("\n")).toMatchInlineSnapshot(`
      "day 0: bedtime=18:59
      day 1: bedtime=18:59
      day 2: bedtime=18:58
      day 3: bedtime=18:46
      day 4: bedtime=18:45
      day 5: bedtime=18:43
      day 6: bedtime=18:34
      day 7: bedtime=18:32
      day 8: bedtime=18:30
      day 9: bedtime=18:23
      day 10: bedtime=18:20
      day 11: bedtime=18:16
      day 12: bedtime=18:11
      day 13: bedtime=18:06"
    `);

    const bedtimes = trail.map((line) => {
      const hhmm = line.match(/bedtime=(\d{2}:\d{2})/)![1];
      const [h, m] = hhmm.split(":").map(Number);
      return h * 60 + m;
    });
    const TARGET_MIN = 18 * 60;

    // Convergence pin: bedtime should slide toward target across the 14-day
    // trail. Total slide ≥ 30 min (the engine actually moves) and the final
    // day should be within 30 min of target.
    const totalShift = bedtimes[0] - bedtimes[bedtimes.length - 1];
    expect(totalShift, "should slide ≥30 min toward target across 14 days")
      .toBeGreaterThanOrEqual(30);
    expect(Math.abs(bedtimes[bedtimes.length - 1] - TARGET_MIN), "final bedtime within 30 min of target")
      .toBeLessThanOrEqual(30);

    // Monotonicity pin: bedtime shouldn't regress LATER between days
    // (allow a 5-min jitter for cycle-snap and floating-point rounding).
    for (let i = 1; i < bedtimes.length; i++) {
      expect(bedtimes[i] - bedtimes[i - 1], `day ${i}: bedtime should not regress >5min later`)
        .toBeLessThanOrEqual(5);
    }

    // Bound pin: bedtime should never overshoot target on this trail
    // (cap is gradual, so overshooting would suggest a cap bug).
    for (let i = 0; i < bedtimes.length; i++) {
      expect(bedtimes[i], `day ${i}: bedtime ≥ target (no overshoot)`)
        .toBeGreaterThanOrEqual(TARGET_MIN);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Settings dimension: target_bedtime
//
// 2D sweep — same archetype, same scenarios, but target_bedtime varied.
// Surfaces how the engine's day plan responds to setting changes. Future
// settings (timezone, custom_nap_count override, potty_mode) can plug into
// the same runSettingsSweep harness.
// ────────────────────────────────────────────────────────────────────────────

describe("settings sweep: Mina × target_bedtime (3-nap regime)", () => {
  it("renders day plan across target_bedtime variants", () => {
    const arch = buildMina();
    const settings: Array<{ label: string; overrides: Partial<Baby> }> = [
      { label: "target=null", overrides: { target_bedtime: null } },
      { label: "target=18:30 (early)", overrides: { target_bedtime: "18:30" } },
      { label: "target=19:15 (baseline)", overrides: { target_bedtime: "19:15" } },
      { label: "target=20:30 (late)", overrides: { target_bedtime: "20:30" } },
    ];
    const scenarios: ScenarioInput[] = [
      { label: "06:30 morning", now: "06:30" },
      { label: "10:00 after first nap", now: "10:00", done: ["08:50-09:35"] },
      { label: "16:30 napsAllDone", now: "16:30",
        done: ["15:55-16:35", "12:10-13:20", "08:50-09:35"] },
    ];
    expect(runSettingsSweep(arch, settings, scenarios)).toMatchInlineSnapshot(`
      "baby: Mina Learned — settings sweep (8mo, 3-nap, target 19:15, 21d)

      ══ setting: target=null ══

      scenario: 06:30 morning
        now: 06:30
        inputs: wake=06:30 target=none
        strategy: routine_schedule
        nextNap: 08:55 (+2h 25m)
        bedtime: 19:14 (+12h 44m)
        predictedNaps: 08:55-09:40, 12:13-13:23, 15:54-16:34
        napsAllDone: false (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (3 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: 10:00 after first nap
        now: 10:00
        inputs: wake=06:30 done=[08:50-09:35] target=none
        strategy: routine_schedule
        nextNap: 12:13 (+2h 13m)
        bedtime: 19:14 (+9h 14m)
        predictedNaps: 12:13-13:23, 15:54-16:34
        napsAllDone: false (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (2 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: 16:30 napsAllDone
        now: 16:30
        inputs: wake=06:30 done=[15:55-16:35, 12:10-13:20, 08:50-09:35] target=none
        strategy: routine_schedule
        nextNap: 19:15 (+2h 45m)
        bedtime: 19:15 (+2h 45m)
        predictedNaps: none
        napsAllDone: true (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      ══ setting: target=18:30 (early) ══

      scenario: 06:30 morning
        now: 06:30
        inputs: wake=06:30 target=18:30
        strategy: routine_schedule
        nextNap: 08:55 (+2h 25m)
        bedtime: 18:59 (+12h 29m)
        predictedNaps: 08:55-09:40, 12:13-13:23, 15:39-16:19
        napsAllDone: false (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (3 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: 10:00 after first nap
        now: 10:00
        inputs: wake=06:30 done=[08:50-09:35] target=18:30
        strategy: routine_schedule
        nextNap: 12:13 (+2h 13m)
        bedtime: 18:59 (+8h 59m)
        predictedNaps: 12:13-13:23, 15:39-16:19
        napsAllDone: false (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (2 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: 16:30 napsAllDone
        now: 16:30
        inputs: wake=06:30 done=[15:55-16:35, 12:10-13:20, 08:50-09:35] target=18:30
        strategy: routine_schedule
        nextNap: 19:00 (+2h 30m)
        bedtime: 19:00 (+2h 30m)
        predictedNaps: none
        napsAllDone: true (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      ══ setting: target=19:15 (baseline) ══

      scenario: 06:30 morning
        now: 06:30
        inputs: wake=06:30 target=19:15
        strategy: routine_schedule
        nextNap: 08:55 (+2h 25m)
        bedtime: 19:15 (+12h 45m)
        predictedNaps: 08:55-09:40, 12:13-13:23, 15:54-16:34
        napsAllDone: false (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (3 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: 10:00 after first nap
        now: 10:00
        inputs: wake=06:30 done=[08:50-09:35] target=19:15
        strategy: routine_schedule
        nextNap: 12:13 (+2h 13m)
        bedtime: 19:15 (+9h 15m)
        predictedNaps: 12:13-13:23, 15:54-16:34
        napsAllDone: false (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (2 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: 16:30 napsAllDone
        now: 16:30
        inputs: wake=06:30 done=[15:55-16:35, 12:10-13:20, 08:50-09:35] target=19:15
        strategy: routine_schedule
        nextNap: 19:15 (+2h 45m)
        bedtime: 19:15 (+2h 45m)
        predictedNaps: none
        napsAllDone: true (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      ══ setting: target=20:30 (late) ══

      scenario: 06:30 morning
        now: 06:30
        inputs: wake=06:30 target=20:30
        strategy: routine_schedule
        nextNap: 08:55 (+2h 25m)
        bedtime: 19:44 (+13h 14m)
        predictedNaps: 08:55-09:40, 12:13-13:23, 16:24-17:04
        napsAllDone: false (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (3 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: 10:00 after first nap
        now: 10:00
        inputs: wake=06:30 done=[08:50-09:35] target=20:30
        strategy: routine_schedule
        nextNap: 12:13 (+2h 13m)
        bedtime: 19:44 (+9h 44m)
        predictedNaps: 12:13-13:23, 16:24-17:04
        napsAllDone: false (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (2 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: 16:30 napsAllDone
        now: 16:30
        inputs: wake=06:30 done=[15:55-16:35, 12:10-13:20, 08:50-09:35] target=20:30
        strategy: routine_schedule
        nextNap: 19:45 (+3h 15m)
        bedtime: 19:45 (+3h 15m)
        predictedNaps: none
        napsAllDone: true (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m"
    `);
  });
});

describe("settings sweep: Oskar × target_bedtime", () => {
  it("renders day plan across target_bedtime variants", () => {
    const arch = buildOskar();
    const settings: Array<{ label: string; overrides: Partial<Baby> }> = [
      { label: "target=null (follow the baby)", overrides: { target_bedtime: null } },
      { label: "target=18:00 (early)",          overrides: { target_bedtime: "18:00" } },
      { label: "target=19:30 (baseline)",       overrides: { target_bedtime: "19:30" } },
      { label: "target=21:00 (late)",           overrides: { target_bedtime: "21:00" } },
    ];
    // Small focused scenario set so the matrix stays readable.
    const scenarios: ScenarioInput[] = [
      { label: "06:00 morning, fresh day", now: "06:00" },
      { label: "13:30 right after full nap", now: "13:30",
        done: ["11:30-13:20"] },
      { label: "16:00 napsAllDone", now: "16:00",
        done: ["11:30-13:20"] },
      { label: "08:12 after 28m cs (May-7 floor regime)", now: "08:12",
        done: ["06:21-06:49!"] },
    ];

    expect(runSettingsSweep(arch, settings, scenarios)).toMatchInlineSnapshot(`
      "baby: Oskar OneNap — settings sweep (12mo, 1-nap, target 19:30, 21d)

      ══ setting: target=null (follow the baby) ══

      scenario: 06:00 morning, fresh day
        now: 06:00
        inputs: wake=06:00 target=none
        strategy: routine_schedule
        nextNap: 11:07 (+5h 07m)
        bedtime: 19:17 (+13h 17m)
        predictedNaps: 11:07-12:57
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: medium (1 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 13:30 right after full nap
        now: 13:30
        inputs: wake=06:00 done=[11:30-13:20] target=none
        strategy: routine_schedule
        nextNap: 19:30 (+6h 00m)
        bedtime: 19:30 (+6h 00m)
        predictedNaps: none
        napsAllDone: true (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 16:00 napsAllDone
        now: 16:00
        inputs: wake=06:00 done=[11:30-13:20] target=none
        strategy: routine_schedule
        nextNap: 19:30 (+3h 30m)
        bedtime: 19:30 (+3h 30m)
        predictedNaps: none
        napsAllDone: true (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 08:12 after 28m cs (May-7 floor regime)
        now: 08:12
        inputs: wake=06:00 done=[06:21-06:49!] target=none
        strategy: routine_schedule
        nextNap: 10:55 (+2h 43m)
        bedtime: 19:32 (+11h 20m)
        predictedNaps: 10:55-12:45
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: medium (1 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      ══ setting: target=18:00 (early) ══

      scenario: 06:00 morning, fresh day
        now: 06:00
        inputs: wake=06:00 target=18:00
        strategy: routine_schedule
        nextNap: 10:52 (+4h 52m)
        bedtime: 19:02 (+13h 02m)
        predictedNaps: 10:52-12:42
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: medium (1 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 13:30 right after full nap
        now: 13:30
        inputs: wake=06:00 done=[11:30-13:20] target=18:00
        strategy: routine_schedule
        nextNap: 19:30 (+6h 00m)
        bedtime: 19:30 (+6h 00m)
        predictedNaps: none
        napsAllDone: true (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 16:00 napsAllDone
        now: 16:00
        inputs: wake=06:00 done=[11:30-13:20] target=18:00
        strategy: routine_schedule
        nextNap: 19:30 (+3h 30m)
        bedtime: 19:30 (+3h 30m)
        predictedNaps: none
        napsAllDone: true (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 08:12 after 28m cs (May-7 floor regime)
        now: 08:12
        inputs: wake=06:00 done=[06:21-06:49!] target=18:00
        strategy: routine_schedule
        nextNap: 10:42 (+2h 30m)
        bedtime: 19:17 (+11h 05m)
        predictedNaps: 10:42-12:32
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: medium (1 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      ══ setting: target=19:30 (baseline) ══

      scenario: 06:00 morning, fresh day
        now: 06:00
        inputs: wake=06:00 target=19:30
        strategy: routine_schedule
        nextNap: 11:07 (+5h 07m)
        bedtime: 19:17 (+13h 17m)
        predictedNaps: 11:07-12:57
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: medium (1 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 13:30 right after full nap
        now: 13:30
        inputs: wake=06:00 done=[11:30-13:20] target=19:30
        strategy: routine_schedule
        nextNap: 19:30 (+6h 00m)
        bedtime: 19:30 (+6h 00m)
        predictedNaps: none
        napsAllDone: true (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 16:00 napsAllDone
        now: 16:00
        inputs: wake=06:00 done=[11:30-13:20] target=19:30
        strategy: routine_schedule
        nextNap: 19:30 (+3h 30m)
        bedtime: 19:30 (+3h 30m)
        predictedNaps: none
        napsAllDone: true (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 08:12 after 28m cs (May-7 floor regime)
        now: 08:12
        inputs: wake=06:00 done=[06:21-06:49!] target=19:30
        strategy: routine_schedule
        nextNap: 10:53 (+2h 41m)
        bedtime: 19:30 (+11h 18m)
        predictedNaps: 10:53-12:43
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: medium (1 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      ══ setting: target=21:00 (late) ══

      scenario: 06:00 morning, fresh day
        now: 06:00
        inputs: wake=06:00 target=21:00
        strategy: routine_schedule
        nextNap: 11:07 (+5h 07m)
        bedtime: 19:17 (+13h 17m)
        predictedNaps: 11:07-12:57
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: medium (1 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 13:30 right after full nap
        now: 13:30
        inputs: wake=06:00 done=[11:30-13:20] target=21:00
        strategy: routine_schedule
        nextNap: 19:30 (+6h 00m)
        bedtime: 19:30 (+6h 00m)
        predictedNaps: none
        napsAllDone: true (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 16:00 napsAllDone
        now: 16:00
        inputs: wake=06:00 done=[11:30-13:20] target=21:00
        strategy: routine_schedule
        nextNap: 19:30 (+3h 30m)
        bedtime: 19:30 (+3h 30m)
        predictedNaps: none
        napsAllDone: true (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: 08:12 after 28m cs (May-7 floor regime)
        now: 08:12
        inputs: wake=06:00 done=[06:21-06:49!] target=21:00
        strategy: routine_schedule
        nextNap: 10:55 (+2h 43m)
        bedtime: 19:32 (+11h 20m)
        predictedNaps: 10:55-12:45
        napsAllDone: false (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: medium (1 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m"
    `);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Cross-archetype scenarios with per-archetype N/A handling
//
// A handful of scenarios that we want to run against EVERY archetype, with
// per-strategy expectations encoded inline. Demonstrates the `expect` /
// `skipFor` mechanism so future cross-cutting concerns (e.g. "what does the
// engine do at the day-boundary midnight" or "what about an active night
// sleep at 03:00") have a place to live without duplicating per archetype.
// ────────────────────────────────────────────────────────────────────────────

describe("cross-archetype shared scenarios", () => {
  const sharedScenarios: ScenarioInput[] = [
    {
      label: "no wake reference at 10:00",
      now: "10:00",
      wake: "none",
      expect: {
        // Routine returns null when there's no wake — visible as "prediction: none".
        routine_schedule: { prediction: "null" },
        // Newborn always renders sleep-window guidance regardless of wake.
        newborn_guidance: { bedtime: "null", predictedNaps: "null" },
        // Emerging falls through to its newborn-style fallback when wake is missing.
        emerging_rhythm: { bedtime: "null" },
      },
    },
    {
      label: "active night at 22:30",
      now: "22:30",
      active: "22:00 night",
      expect: {
        newborn_guidance: { bedtime: "null", predictedNaps: "null" },
        emerging_rhythm: { predictedNaps: "null" },
        routine_schedule: { predictedNaps: "null", confidence: "set" },
      },
    },
    {
      // At 13:00 with no naps logged the engine's nap-skipped logic fires
      // (planned morning nap was 4h+ overdue → napsAllDone). This scenario
      // exposes that path. We only pin the cross-strategy invariant that a
      // bedtime is produced; the snapshot captures the rest.
      label: "midday no sleeps logged at 13:00",
      now: "13:00",
      expect: {
        newborn_guidance: { bedtime: "null" },
        routine_schedule: { bedtime: "set" },
        emerging_rhythm: { bedtime: "set" },
      },
    },
  ];

  it("each archetype satisfies cross-archetype expectations", () => {
    const blocks = [buildNora, buildEli, buildMina, buildOskar, buildAda, buildIben]
      .map((b) => runSweep(b(), sharedScenarios))
      .join("\n\n──────────\n\n");
    expect(blocks).toMatchInlineSnapshot(`
      "baby: Nora Newborn (4w, 5–7 fragmented naps, target 20:30)

      scenario: no wake reference at 10:00
        now: 10:00
        inputs: wake=none target=20:30
        strategy: newborn_guidance
        nextNap: none
        bedtime: none
        predictedNaps: none
        napsAllDone: false (0 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 03:50–04:50
        sleepPressure: high

      scenario: active night at 22:30
        now: 22:30
        inputs: wake=06:30 active=22:00(night) target=20:30
        strategy: newborn_guidance
        nextNap: none
        bedtime: none
        predictedNaps: none
        napsAllDone: false (0 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 03:50–04:50
        sleepPressure: high

      scenario: midday no sleeps logged at 13:00
        now: 13:00
        inputs: wake=06:30 target=20:30
        strategy: newborn_guidance
        nextNap: none
        bedtime: none
        predictedNaps: none
        napsAllDone: false (0 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 03:50–04:50
        sleepPressure: high

      ──────────

      baby: Eli Emerging (3.5mo, 4-nap, target 19:45, 21d)

      scenario: no wake reference at 10:00
        now: 10:00
        inputs: wake=none target=19:45
        strategy: emerging_rhythm
        nextNap: none
        bedtime: none
        predictedNaps: none
        napsAllDone: false (4 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 07:15–08:35
        sleepPressure: high

      scenario: active night at 22:30
        now: 22:30
        inputs: wake=06:00 active=22:00(night) target=19:45
        strategy: emerging_rhythm
        nextNap: 19:00 (-3h 30m)
        bedtime: 19:00 (-3h 30m)
        predictedNaps: none
        napsAllDone: true (4 expected)
        expectedNapEnd: none
        expectedNightEnd: 07:05 (+8h 35m)
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 07:15–08:35
        sleepPressure: high

      scenario: midday no sleeps logged at 13:00
        now: 13:00
        inputs: wake=06:00 target=19:45
        strategy: emerging_rhythm
        nextNap: 12:14 (-45m)
        bedtime: 17:30 (+4h 30m)
        predictedNaps: 12:14-13:04, 15:10-15:55
        napsAllDone: false (4 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 07:15–08:35
        sleepPressure: high

      ──────────

      baby: Mina Learned (8mo, 3-nap, target 19:15, 21d)

      scenario: no wake reference at 10:00
        now: 10:00
        inputs: wake=none target=19:15
        prediction: none (no wake reference)

      scenario: active night at 22:30
        now: 22:30
        inputs: wake=06:30 active=22:00(night) target=19:15
        strategy: routine_schedule
        nextNap: 19:15 (-3h 15m)
        bedtime: 19:15 (-3h 15m)
        predictedNaps: none
        napsAllDone: true (3 expected)
        expectedNapEnd: none
        expectedNightEnd: 07:37 (+9h 07m)
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      scenario: midday no sleeps logged at 13:00
        now: 13:00
        inputs: wake=06:30 target=19:15
        strategy: routine_schedule
        nextNap: 12:13 (-46m)
        bedtime: 19:15 (+6h 15m)
        predictedNaps: 12:13-13:23, 16:13-16:53
        napsAllDone: false (3 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (2 napRanges)
        learned: nap=45m night=675m ww=150.5m bedww=160m

      ──────────

      baby: Oskar OneNap (12mo, 1-nap, target 19:30, 21d)

      scenario: no wake reference at 10:00
        now: 10:00
        inputs: wake=none target=19:30
        prediction: none (no wake reference)

      scenario: active night at 22:30
        now: 22:30
        inputs: wake=06:00 active=22:00(night) target=19:30
        strategy: routine_schedule
        nextNap: 19:00 (-3h 30m)
        bedtime: 19:00 (-3h 30m)
        predictedNaps: none
        napsAllDone: true (1 expected)
        expectedNapEnd: none
        expectedNightEnd: 06:59 (+8h 29m)
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      scenario: midday no sleeps logged at 13:00
        now: 13:00
        inputs: wake=06:00 target=19:30
        strategy: routine_schedule
        nextNap: 19:00 (+6h 00m)
        bedtime: 19:00 (+6h 00m)
        predictedNaps: none
        napsAllDone: true (1 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=113m night=630m ww=300m bedww=370m

      ──────────

      baby: Ada NoTarget (10mo, 2-nap, no target, 21d)

      scenario: no wake reference at 10:00
        now: 10:00
        inputs: wake=none target=none
        prediction: none (no wake reference)

      scenario: active night at 22:30
        now: 22:30
        inputs: wake=06:00 active=22:00(night) target=none
        strategy: routine_schedule
        nextNap: 19:00 (-3h 30m)
        bedtime: 19:00 (-3h 30m)
        predictedNaps: none
        napsAllDone: true (2 expected)
        expectedNapEnd: none
        expectedNightEnd: 07:12 (+8h 42m)
        rescueNap: none
        continuationWindow: none
        confidence: high (0 napRanges)
        learned: nap=80m night=660m ww=183.1m bedww=250m

      scenario: midday no sleeps logged at 13:00
        now: 13:00
        inputs: wake=06:00 target=none
        strategy: routine_schedule
        nextNap: 13:30 (+30m)
        bedtime: 18:31 (+5h 31m)
        predictedNaps: 13:30-14:50
        napsAllDone: false (2 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: high (1 napRanges)
        learned: nap=80m night=660m ww=183.1m bedww=250m

      ──────────

      baby: Iben Sparse (11mo, sparse, 6 scattered days)

      scenario: no wake reference at 10:00
        now: 10:00
        inputs: wake=none target=20:00
        strategy: emerging_rhythm
        nextNap: none
        bedtime: none
        predictedNaps: none
        napsAllDone: false (2 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 16:30–17:45
        sleepPressure: high

      scenario: active night at 22:30
        now: 22:30
        inputs: wake=06:30 active=22:00(night) target=20:00
        strategy: emerging_rhythm
        nextNap: 19:30 (-3h 00m)
        bedtime: 19:30 (-3h 00m)
        predictedNaps: none
        napsAllDone: true (2 expected)
        expectedNapEnd: none
        expectedNightEnd: 10:24 (+11h 54m)
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 16:30–17:45
        sleepPressure: high

      scenario: midday no sleeps logged at 13:00
        now: 13:00
        inputs: wake=06:30 target=20:00
        strategy: emerging_rhythm
        nextNap: 15:04 (+2h 04m)
        bedtime: 19:33 (+6h 33m)
        predictedNaps: 15:04-16:08
        napsAllDone: false (2 expected)
        expectedNapEnd: none
        expectedNightEnd: none
        rescueNap: none
        continuationWindow: none
        confidence: none
        sleepWindow: 16:30–17:45
        sleepPressure: high"
    `);
  });
});
