#!/usr/bin/env bun
/**
 * Debug: inspect what positional wake-windows and the first predicted nap
 * look like for Halldis on a given date, using the prod db.
 *
 * Usage:
 *   bun scripts/debug-positional-ww.ts [YYYY-MM-DD]
 */

import Database from "bun:sqlite";
import { calculateAgeMonths, predictDayNaps, decomposeFirstNapPrediction } from "$lib/engine/schedule.js";
import { DEFAULT_FEATURES } from "$lib/types.js";
import type { SleepEntry, BabyContext } from "$lib/types.js";

const TODAY_ARG = process.argv[2];
const BIRTHDATE = "2025-06-12";
const TZ = "Europe/Oslo";
const DB_PATH = "db.sqlite.prod";
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS ?? "7");
const SWEEP = process.argv.includes("--sweep");

const db = new Database(DB_PATH, { readonly: true });

interface SleepRow {
  start_time: string;
  end_time: string | null;
  type: string;
  woke_by: string | null;
}

const allSleeps = db
  .prepare(
    `SELECT start_time, end_time, type, woke_by
     FROM sleep_log
     WHERE deleted = 0
     ORDER BY start_time DESC
     LIMIT 200`,
  )
  .all() as SleepRow[];

// Find today's morning wake (end_time of the most recent completed night).
const latestNight = allSleeps.find((s) => s.type === "night" && s.end_time);
const wakeUpTime = latestNight?.end_time ?? null;

if (!wakeUpTime) {
  console.error("No completed night found in prod db.");
  process.exit(1);
}

const todayDate = (TODAY_ARG ?? new Date(wakeUpTime).toISOString().slice(0, 10));
const nowMs = new Date(`${todayDate}T${new Date(wakeUpTime).toISOString().slice(11, 19)}Z`).getTime();
const ageMonths = calculateAgeMonths(BIRTHDATE, new Date(nowMs));

// Use the same window as the server. The production server passes a 7-day
// window to `ctx.recentSleeps` (the one predictDayNaps actually reads); a
// 30-day window can produce different positional samples for transitioning
// babies.
const cutoffMs = nowMs - WINDOW_DAYS * 86400_000;
const recentSleeps: SleepEntry[] = allSleeps
  .filter((s) => new Date(s.start_time).getTime() >= cutoffMs)
  .filter((s) => s.end_time != null)
  .map((s) => ({
    start_time: s.start_time,
    end_time: s.end_time!,
    type: s.type as "nap" | "night",
    woke_by: s.woke_by as "self" | "woken" | null,
  }))
  .reverse(); // engine expects chronological asc

console.log(`Debugging predictDayNaps for ${todayDate}`);
console.log(`Wake-up time: ${wakeUpTime}`);
console.log(`Age months: ${ageMonths}`);
console.log(`Sleep count (last 30d, completed): ${recentSleeps.length}`);

// Show the last 8 completed sleeps so we can sanity-check what the
// positional-WW logic is seeing.
console.log("\nLast 8 completed sleeps (oldest → newest):");
for (const s of recentSleeps.slice(-8)) {
  console.log(`  ${s.type.padEnd(5)} ${s.start_time} → ${s.end_time}`);
}

// Match the production server's morning-plan call: strategy is set by
// `determineStrategy` upstream, and `selectBestPlan` passes dayStart: true
// when called from `todayWakeUp.wake_time`. Mirror both here so the debug
// output reflects what production actually evaluates.
const ctx: BabyContext = {
  birthdate: BIRTHDATE,
  ageMonths,
  tz: TZ,
  customNapCount: null,
  recentSleeps,
  features: DEFAULT_FEATURES,
  strategy: "routine_schedule",
};

const preds = predictDayNaps(wakeUpTime, ctx, { dayStart: true });
console.log("\nPredicted naps (current code, dayStart=true):");
preds.forEach((p, i) => {
  console.log(`  nap ${i + 1}: ${p.startTime.slice(11, 16)} → ${p.endTime.slice(11, 16)}`);
});

const decomposition = decomposeFirstNapPrediction(wakeUpTime, ctx);
if (decomposition) {
  console.log("\nFirst-nap decomposition (UTC clock):");
  const fmt = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  const mn = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  console.log(`  pressure        ${fmt(decomposition.pressureMs)}`);
  console.log(`  habit           ${decomposition.habitualMs ? fmt(decomposition.habitualMs) : "—"}  (weight ${decomposition.habitWeight.toFixed(2)})`);
  console.log(`  blend           ${fmt(decomposition.blendMs)}`);
  console.log(`  recent wake     ${decomposition.recentWakeAnchorMin !== null ? mn(decomposition.recentWakeAnchorMin) : "—"}`);
  console.log(`  today wake      ${mn(decomposition.todayWakeMin)}`);
  console.log(`  wake offset     ${decomposition.wakeOffsetMin !== null ? decomposition.wakeOffsetMin + "m" : "—"}`);
  console.log(`  cycle           ${decomposition.cycleMin}m`);
  console.log(`  re-anchored     ${decomposition.reAnchored} (cycles snapped: ${decomposition.cyclesSnapped})`);
  console.log(`  final           ${fmt(decomposition.finalMs)}`);
}

// Optional: replay each of the last 7 wake-mornings against the prior-7
// window so we can see predicted-vs-actual for each day. Helps catch
// regressions when changing the engine: a fix that lands today's
// prediction closer to reality should NOT push stable days' predictions
// further away from theirs.
if (SWEEP) {
  console.log("\n── Sweep: predicted vs actual nap-1 start, day by day ──");
  // Collect (wake, nap1.start) pairs ordered chronologically.
  const ordered = allSleeps.slice().reverse();
  const wakeNapPairs: Array<{ wake: string; actualNap1: string | null }> = [];
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i];
    if (s.type !== "night" || !s.end_time) continue;
    // Next nap chronologically after this wake (must be type=nap).
    let actualNap1: string | null = null;
    for (let j = i + 1; j < ordered.length; j++) {
      if (ordered[j].type === "nap") {
        actualNap1 = ordered[j].start_time;
        break;
      }
      if (ordered[j].type === "night") break; // no nap this day
    }
    wakeNapPairs.push({ wake: s.end_time, actualNap1 });
  }
  for (const { wake, actualNap1 } of wakeNapPairs.slice(-8)) {
    const wakeMs = new Date(wake).getTime();
    const cutoff = wakeMs - WINDOW_DAYS * 86400_000;
    const sweepRecent: SleepEntry[] = allSleeps
      .filter((s) => new Date(s.start_time).getTime() >= cutoff)
      .filter((s) => new Date(s.start_time).getTime() < wakeMs)
      .filter((s) => s.end_time != null)
      .map((s) => ({
        start_time: s.start_time,
        end_time: s.end_time!,
        type: s.type as "nap" | "night",
        woke_by: s.woke_by as "self" | "woken" | null,
      }))
      .reverse();
    const sweepCtx: BabyContext = { ...ctx, recentSleeps: sweepRecent, ageMonths: calculateAgeMonths(BIRTHDATE, new Date(wakeMs)) };
    const sp = predictDayNaps(wake, sweepCtx, { dayStart: true });
    const predHHMM = sp[0]?.startTime.slice(11, 16) ?? "—";
    const actHHMM = actualNap1?.slice(11, 16) ?? "—";
    const wakeHHMM = wake.slice(11, 16);
    let delta = "—";
    if (sp[0] && actualNap1) {
      const d = (new Date(sp[0].startTime).getTime() - new Date(actualNap1).getTime()) / 60000;
      const sign = d >= 0 ? "+" : "";
      delta = `${sign}${Math.round(d)}m`;
    }
    console.log(`  wake ${wakeHHMM}Z → predicted ${predHHMM}Z, actual ${actHHMM}Z (${delta})`);
  }
}
