#!/usr/bin/env bun

/**
 * Comprehensive prediction quality report.
 *
 * Usage:
 *   bun scripts/backtest-report.ts <fixture.json> --birthdate YYYY-MM-DD [options]
 *   bun scripts/backtest-report.ts --db <path> --birthdate YYYY-MM-DD [options]
 *
 * Options:
 *   --tz <iana-tz>           Timezone (default: Europe/Oslo)
 *   --label <text>           Label (default: filename)
 *   --custom-nap-count <n>   Override nap count
 *   --full                   Per-day detailed report
 *   --ablation               Run feature ablation analysis
 *   --db <path>              Use a SQLite db directly (runs db-to-fixture internally)
 *
 * Examples:
 *   bun scripts/backtest-report.ts tests/fixtures/halldis-sleep.json --birthdate 2025-06-12
 *   bun scripts/backtest-report.ts --db db.sqlite.prod --birthdate 2025-06-12 --ablation
 */

import {
  backtest,
  bucketByWarmup,
  bucketResultsByAge,
  formatReport,
  renderSummary,
} from "$lib/engine/backtest.js";
import type { DayRecord, BacktestResult, DayResult } from "$lib/engine/backtest.js";
import type { PredictionFeatures } from "$lib/types.js";
import { isoToDateInTz } from "$lib/tz.js";
import { DEFAULT_FEATURES } from "$lib/types.js";

// ── Argument parsing ────────────────────────────────────────────────────────

interface Options {
  fixturePath: string | null;
  dbPath: string | null;
  birthdate: string;
  tz: string;
  label: string;
  customNapCount: number | null;
  full: boolean;
  ablation: boolean;
}

function printUsage() {
  console.log(`Usage:
  bun scripts/backtest-report.ts <fixture.json> --birthdate YYYY-MM-DD [options]
  bun scripts/backtest-report.ts --db <path> --birthdate YYYY-MM-DD [options]

Options:
  --tz <iana-tz>           Timezone (default: Europe/Oslo)
  --label <text>           Label (default: filename)
  --custom-nap-count <n>   Override nap count
  --full                   Per-day detailed report
  --ablation               Run feature ablation analysis
  --db <path>              Use a SQLite db directly
`);
}

function parseArgs(argv: string[]): Options | null {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return null;
  }

  const options: Options = {
    fixturePath: null,
    dbPath: null,
    birthdate: "",
    tz: "Europe/Oslo",
    label: "",
    customNapCount: null,
    full: false,
    ablation: false,
  };

  let i = 0;
  // First arg might be a fixture path (not starting with --)
  if (!argv[0].startsWith("-")) {
    options.fixturePath = argv[0];
    options.label = argv[0].split("/").pop()?.replace(/\.json$/, "") || "backtest";
    i = 1;
  }

  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--birthdate") options.birthdate = argv[++i] ?? "";
    else if (arg === "--tz") options.tz = argv[++i] ?? options.tz;
    else if (arg === "--label") options.label = argv[++i] ?? options.label;
    else if (arg === "--db") {
      options.dbPath = argv[++i] ?? "";
      if (!options.label) options.label = options.dbPath.split("/").pop()?.replace(/\.sqlite$/, "") || "db";
    }
    else if (arg === "--custom-nap-count") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) {
        console.error("--custom-nap-count must be a non-negative integer.");
        process.exit(1);
      }
      options.customNapCount = value;
    }
    else if (arg === "--full") options.full = true;
    else if (arg === "--ablation") options.ablation = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.birthdate)) {
    console.error("Missing or invalid --birthdate (expected YYYY-MM-DD).");
    process.exit(1);
  }

  if (!options.fixturePath && !options.dbPath) {
    console.error("Provide either a fixture path or --db <path>.");
    process.exit(1);
  }

  return options;
}

// ── DB → DayRecords ─────────────────────────────────────────────────────────

async function loadFromDb(dbPath: string, tz: string): Promise<DayRecord[]> {
  const Database = (await import("bun:sqlite")).default;
  const db = new Database(dbPath, { readonly: true });

  const sleeps = db.prepare(`
    SELECT start_time, end_time, type
    FROM sleep_log WHERE deleted = 0
    ORDER BY start_time
  `).all() as { start_time: string; end_time: string | null; type: string }[];

  const dayStarts = db.prepare(`
    SELECT date, wake_time FROM day_start ORDER BY date
  `).all() as { date: string; wake_time: string }[];

  db.close();

  const wakeByDate = new Map(dayStarts.map((d) => [d.date, d.wake_time]));
  const byDate = new Map<string, typeof sleeps>();
  for (const s of sleeps) {
    const date = isoToDateInTz(s.start_time, tz);
    const list = byDate.get(date) ?? [];
    list.push(s);
    byDate.set(date, list);
  }

  const days: DayRecord[] = [];
  const allDates = new Set([...wakeByDate.keys(), ...byDate.keys()]);
  for (const date of [...allDates].sort()) {
    const wakeTime = wakeByDate.get(date);
    const daySleeps = byDate.get(date) ?? [];

    let wake = wakeTime;
    if (!wake) {
      const nightEnd = daySleeps.find((s) => s.type === "night" && s.end_time);
      if (nightEnd?.end_time) wake = nightEnd.end_time;
      else continue;
    }

    days.push({
      date,
      wakeTime: wake,
      sleeps: daySleeps
        .filter((s) => s.end_time)
        .map((s) => ({
          start_time: s.start_time,
          end_time: s.end_time!,
          type: s.type as "nap" | "night",
        })),
    });
  }

  return days;
}

// ── Analysis helpers ────────────────────────────────────────────────────────

function printSection(title: string, lines: string[]) {
  if (lines.length === 0) return;
  console.log(`\n${title}`);
  console.log("─".repeat(60));
  for (const line of lines) console.log(line);
}

/** Per-nap-position breakdown of start MAE and bias. */
function napPositionBreakdown(result: BacktestResult): string[] {
  const byPos = new Map<number, { errors: number[]; durations: number[] }>();

  for (const day of result.days) {
    const matchCount = Math.min(day.predictedNaps.length, day.actualNaps.length);
    for (let k = 0; k < matchCount; k++) {
      if (!byPos.has(k)) byPos.set(k, { errors: [], durations: [] });
      const pos = byPos.get(k)!;
      pos.errors.push(day.napStartErrors[k]);
      if (day.napDurationErrors[k] !== undefined) {
        pos.durations.push(day.napDurationErrors[k]);
      }
    }
  }

  const lines: string[] = [];
  for (const [pos, data] of [...byPos.entries()].toSorted(([a], [b]) => a - b)) {
    const n = data.errors.length;
    const mae = Math.round(data.errors.reduce((s, e) => s + Math.abs(e), 0) / n * 10) / 10;
    const bias = Math.round(data.errors.reduce((s, e) => s + e, 0) / n * 10) / 10;
    const durMae = data.durations.length > 0
      ? Math.round(data.durations.reduce((s, e) => s + Math.abs(e), 0) / data.durations.length * 10) / 10
      : "–";
    lines.push(`  Nap ${pos + 1}: ${n} samples, start MAE ${mae} min, bias ${bias > 0 ? "+" : ""}${bias}, dur MAE ${durMae} min`);
  }
  return lines;
}

/** Show days with worst nap start errors. */
function worstDays(result: BacktestResult, n = 10): string[] {
  const scored = result.days.map((d) => ({
    date: d.date,
    maxErr: Math.max(...d.napStartErrors.map(Math.abs), 0),
    predictedCount: d.predictedNaps.length,
    actualCount: d.actualNaps.length,
    errors: d.napStartErrors.map((e) => Math.round(e)),
  }));

  return scored
    .toSorted((a, b) => b.maxErr - a.maxErr)
    .slice(0, n)
    .map((d) => `  ${d.date}: max err ${Math.round(d.maxErr)} min, pred ${d.predictedCount} vs actual ${d.actualCount}, errs [${d.errors.join(", ")}]`);
}

/** Feature ablation: disable each feature and show marginal impact. */
function runAblation(
  days: DayRecord[],
  birthdate: string,
  opts: { tz: string; customNapCount: number | null },
): string[] {
  const baseline = backtest(days, birthdate, { tz: opts.tz, customNapCount: opts.customNapCount });

  const features: { key: keyof PredictionFeatures; label: string }[] = [
    { key: "positionalDuration", label: "positional nap duration" },
    { key: "habitualWake", label: "habitual wake anchor" },
    { key: "habitualBedtime", label: "habitual bedtime anchor" },
    { key: "habitualNapStart", label: "habitual nap start anchor" },
    { key: "cycleBias", label: "sleep cycle bias" },
    { key: "sleepBudget", label: "sleep budget" },
    { key: "weightedRecency", label: "weighted recency" },
  ];

  const lines: string[] = [];
  lines.push(`  baseline: ${renderSummary(baseline, "all-on")}`);

  for (const { key, label } of features) {
    const without = backtest(days, birthdate, {
      tz: opts.tz,
      customNapCount: opts.customNapCount,
      features: { ...DEFAULT_FEATURES, [key]: false },
    });

    const delta = (metric: keyof BacktestResult, lower = true) => {
      const base = baseline[metric] as number;
      const off = without[metric] as number;
      const diff = Math.round((off - base) * 10) / 10;
      if (diff === 0) return "0";
      const sign = diff > 0 ? "+" : "";
      const quality = lower ? (diff > 0 ? "helps" : "hurts") : (diff < 0 ? "helps" : "hurts");
      return `${sign}${diff} (${quality})`;
    };

    lines.push(`  ${label}: nap ${delta("napStartMAE")}, dur ${delta("napDurationMAE")}, bed ${delta("bedtimeMAE")}, wake ${delta("wakeTimeMAE")}`);
  }

  return lines;
}

// ── Main ────────────────────────────────────────────────────────────────────

const options = parseArgs(process.argv.slice(2));
if (!options) process.exit(0);

let days: DayRecord[];
if (options.dbPath) {
  days = await loadFromDb(options.dbPath, options.tz);
  console.error(`Loaded ${days.length} days from ${options.dbPath}`);
} else {
  const file = Bun.file(options.fixturePath!);
  if (!(await file.exists())) {
    console.error(`Fixture not found: ${options.fixturePath}`);
    process.exit(1);
  }
  days = await file.json() as DayRecord[];
}

if (days.length < 2) {
  console.error(`Need at least 2 days for backtest, got ${days.length}`);
  process.exit(1);
}

const result = backtest(days, options.birthdate, {
  tz: options.tz,
  customNapCount: options.customNapCount,
});

console.log(`\n${options.label} — Prediction Quality Report`);
console.log("═".repeat(60));
console.log(renderSummary(result, options.label));

printSection("Per age bucket", bucketResultsByAge(result, options.birthdate)
  .map((b) => renderSummary(b.result, b.label)));

printSection("Warm-up curve", bucketByWarmup(result)
  .map((b) => renderSummary(b.result, b.label)));

printSection("Per nap position", napPositionBreakdown(result));

printSection("Worst days (by max nap start error)", worstDays(result));

if (options.ablation) {
  printSection("Feature ablation (disabling each feature)", runAblation(days, options.birthdate, {
    tz: options.tz,
    customNapCount: options.customNapCount,
  }));
}

if (options.full) {
  console.log(`\n${formatReport(result, options.label)}`);
}
