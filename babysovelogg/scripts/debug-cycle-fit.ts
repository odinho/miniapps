#!/usr/bin/env bun
/**
 * Score every candidate sleep-cycle length (35-60 min) against Halldis's
 * actual recent nap durations and show:
 *   - what survives censoring
 *   - the score for each candidate
 *   - which candidates fit each individual nap
 *   - how sensitive the winner is to outliers / sample size
 *
 * The point is to answer "is 37 min a real signal or a math degeneracy?"
 * without taking my own initial dismissal at face value.
 */

import Database from "bun:sqlite";
import { calculateAgeMonths, estimateSleepCycleFromData } from "$lib/engine/schedule.js";
import { DEFAULT_FEATURES } from "$lib/types.js";
import type { SleepEntry, BabyContext } from "$lib/types.js";

const BIRTHDATE = "2025-06-12";
const TZ = "Europe/Oslo";
const DB_PATH = "db.sqlite.prod";
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS ?? "7");

const db = new Database(DB_PATH, { readonly: true });

interface SleepRow {
  start_time: string;
  end_time: string | null;
  type: string;
  woke_by: string | null;
}

const all = db
  .prepare(
    `SELECT start_time, end_time, type, woke_by FROM sleep_log
     WHERE deleted = 0 ORDER BY start_time DESC LIMIT 200`,
  )
  .all() as SleepRow[];

// Use the most recent night.end as 'now' so the window mirrors prod
const latestNight = all.find((s) => s.type === "night" && s.end_time);
const nowMs = new Date(latestNight!.end_time!).getTime();
const cutoff = nowMs - WINDOW_DAYS * 86400_000;
const recent: SleepEntry[] = all
  .filter((s) => new Date(s.start_time).getTime() >= cutoff && s.end_time)
  .map((s) => ({
    start_time: s.start_time,
    end_time: s.end_time!,
    type: s.type as "nap" | "night",
    woke_by: s.woke_by as "self" | "woken" | null,
  }))
  .reverse();

const ageMonths = calculateAgeMonths(BIRTHDATE, new Date(nowMs));

const ctx: BabyContext = {
  birthdate: BIRTHDATE,
  ageMonths,
  tz: TZ,
  customNapCount: null,
  recentSleeps: recent,
  features: DEFAULT_FEATURES,
  strategy: "routine_schedule",
};

// Extract naps the same way the production function does, then show their
// durations + woke_by labels so we can see what censorCutShortNaps would
// drop. We don't have a public re-export of the helper, so just print the
// raw durations and woke_by — the user can reason about the censoring set.
const naps = recent.filter((s) => s.type === "nap");
console.log(`Window: last ${WINDOW_DAYS} days. Naps: ${naps.length}.`);
console.log("Nap durations (min) and woke_by:");
const durations: number[] = [];
for (const n of naps) {
  const startMs = new Date(n.start_time).getTime();
  const endMs = new Date(n.end_time).getTime();
  const dur = Math.round((endMs - startMs) / 60_000);
  durations.push(dur);
  console.log(`  ${n.start_time.slice(5, 10)}  ${String(dur).padStart(3)}min   woke_by=${n.woke_by ?? "—"}`);
}

console.log("\nProduction estimateSleepCycleFromData() does:");
console.log("  - censor cut-shorts (woke_by=woken AND dur < self_median - 0.5*cycle)");
console.log("  - filter to dur in [20, 180]");
console.log("  - score each c in [35,60]: sum_d exp(-(dist(d,c)/8)^2)");
console.log("  - pick best score (smallest c wins ties)\n");

function score(c: number, ds: number[]): { total: number; perDur: number[] } {
  const perDur = ds.map((d) => {
    const rem = d % c;
    const dist = Math.min(rem, c - rem);
    return Math.exp(-(dist * dist) / 64);
  });
  return { total: perDur.reduce((a, b) => a + b, 0), perDur };
}

// Score across all candidates
const results: Array<{ c: number; total: number }> = [];
for (let c = 35; c <= 60; c++) {
  results.push({ c, total: score(c, durations).total });
}
results.sort((a, b) => b.total - a.total);

console.log(`Top 8 candidate cycles (full window, ${durations.length} naps unfiltered):`);
for (const r of results.slice(0, 8)) {
  console.log(`  c=${String(r.c).padStart(2)}  score=${r.total.toFixed(3)}`);
}

console.log("\nPer-nap fit at the top two candidates:");
const top1 = score(results[0].c, durations);
const top2 = score(results[1].c, durations);
console.log(`  duration  c=${results[0].c}     c=${results[1].c}     c=55 (age default)`);
const ad = score(55, durations);
for (let i = 0; i < durations.length; i++) {
  console.log(`  ${String(durations[i]).padStart(7)}  ${top1.perDur[i].toFixed(3)}   ${top2.perDur[i].toFixed(3)}   ${ad.perDur[i].toFixed(3)}`);
}

console.log("\nLeave-one-out stability — best cycle when dropping each nap:");
for (let i = 0; i < durations.length; i++) {
  const reduced = durations.filter((_, j) => j !== i);
  const sub = [];
  for (let c = 35; c <= 60; c++) sub.push({ c, t: score(c, reduced).total });
  sub.sort((a, b) => b.t - a.t);
  console.log(`  drop d=${String(durations[i]).padStart(3)}: winner=${sub[0].c}, runner-up=${sub[1].c} (Δscore=${(sub[0].t - sub[1].t).toFixed(3)})`);
}

console.log("\nDegeneracy check — multiples of candidate cycles:");
for (const c of [37, 50, 55]) {
  const multiples = [1, 2, 3, 4].map((k) => k * c).filter((m) => m >= 20 && m <= 180);
  console.log(`  c=${c} → multiples ${multiples.join(", ")} min`);
}

console.log(`\nProduction function output (estimateSleepCycleFromData): ${estimateSleepCycleFromData(ctx)} min`);

// Score WITHOUT the 67-min cut-short, since production censoring should
// be dropping that nap (woke_by=woken, ~50% under the single self-wake of 111 min).
console.log("\nWith 67-min cut-short removed (proper censoring would drop it):");
const censored = durations.filter((d) => d !== 67);
const censoredResults: Array<{ c: number; total: number }> = [];
for (let c = 35; c <= 60; c++) {
  censoredResults.push({ c, total: score(c, censored).total });
}
censoredResults.sort((a, b) => b.total - a.total);
for (const r of censoredResults.slice(0, 6)) {
  console.log(`  c=${String(r.c).padStart(2)}  score=${r.total.toFixed(3)}`);
}
