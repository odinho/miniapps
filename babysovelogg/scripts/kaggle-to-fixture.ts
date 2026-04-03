#!/usr/bin/env bun
/**
 * Convert Kaggle "Tracking Babies Daily" sleep CSV to backtest fixtures.
 *
 * Usage:
 *   bun scripts/kaggle-to-fixture.ts <input.csv> <output-dir> [timezone]
 *
 * Timezone defaults to America/New_York. The CSV times are local to the family.
 *
 * Outputs one JSON file per baby in the output directory.
 * Each file is a { birthdate, days: DayRecord[] } object.
 *
 * Since the Kaggle data has no birthdates, we estimate: first data point ≈ birth.
 */

import { isoToDateInTz, getHourInTz } from "$lib/tz.js";

interface DayRecord {
  date: string;
  wakeTime: string;
  sleeps: { start_time: string; end_time: string; type: "nap" | "night" }[];
}

interface SleepEntry {
  baby: string;
  startTime: Date;
  durationMin: number;
  endTime: Date;
}

function parseKaggleCsv(csv: string, sourceTz: string): SleepEntry[] {
  // Remove BOM and normalize unicode narrow no-break spaces
  const clean = csv.replace(/^\uFEFF/, "").replace(/\u202F/g, " ");
  const lines = clean.trim().split(/\r?\n/).slice(1);

  const entries: SleepEntry[] = [];
  for (const line of lines) {
    const m = line.match(/^(baby_\d+),"([^"]+)",([^,]+),\s*([^,]+),\s*(\d+)/);
    if (!m) continue;

    const baby = m[1];
    const combinedTime = m[2]; // "8/5/20, 6:10 PM" — always has correct date
    const dateStr = m[3].trim();
    const timeStr = m[4].trim();
    const totalMin = parseInt(m[5]);
    if (totalMin <= 0 || totalMin > 1440) continue; // skip unreasonable values
    if (totalMin < 15) continue; // skip micro-sleeps (< 15 min) — not parent-loggable

    // Parse date: try M/D/YY from date column, fall back to combined_time
    let dateMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!dateMatch) {
      // Fall back to combined_time for Excel serial date columns
      const ctMatch = combinedTime.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      if (!ctMatch) continue;
      dateMatch = ctMatch;
    }

    const month = parseInt(dateMatch[1]) - 1;
    const day = parseInt(dateMatch[2]);
    let year = parseInt(dateMatch[3]);
    if (year < 100) year += 2000;

    // Parse time: "10:25 AM" or "8:44 PM"
    const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!timeMatch) continue;

    let hour = parseInt(timeMatch[1]);
    const min = parseInt(timeMatch[2]);
    const ampm = timeMatch[3].toUpperCase();
    if (ampm === "PM" && hour !== 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;

    // Parse as local time in the baby's timezone, then convert to UTC.
    // Construct an ISO string as if UTC, then subtract the TZ offset.
    const asUtc = new Date(Date.UTC(year, month, day, hour, min));
    const utcRef = asUtc.toLocaleString("en-US", { timeZone: "UTC" });
    const localRef = asUtc.toLocaleString("en-US", { timeZone: sourceTz });
    const offsetMs = new Date(localRef).getTime() - new Date(utcRef).getTime();
    const startTime = new Date(asUtc.getTime() - offsetMs);
    const endTime = new Date(startTime.getTime() + totalMin * 60000);

    entries.push({ baby, startTime, durationMin: totalMin, endTime });
  }

  return entries;
}

function classifySleep(entry: SleepEntry, hour: number): "nap" | "night" {
  // Night: starts 18:00-05:59 AND duration > 3h, OR duration > 6h regardless
  if (entry.durationMin > 360) return "night";
  if ((hour >= 18 || hour < 6) && entry.durationMin > 180) return "night";
  return "nap";
}

function entriesToDays(entries: SleepEntry[], tz: string): DayRecord[] {
  const sorted = [...entries].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  // Classify all entries using local-timezone hours
  const classified = sorted.map((e) => ({
    ...e,
    type: classifySleep(e, Math.floor(getHourInTz(e.startTime, tz))),
  }));

  // Group naps by local date
  const napsByDate = new Map<string, typeof classified>();
  for (const e of classified) {
    if (e.type !== "nap") continue;
    const date = isoToDateInTz(e.startTime.toISOString(), tz);
    if (!napsByDate.has(date)) napsByDate.set(date, []);
    napsByDate.get(date)!.push(e);
  }

  // Index night sleeps by local start date (= bedtime day) and local end date (= wake-up day)
  const nightByStartDate = new Map<string, typeof classified[0]>();
  const nightByEndDate = new Map<string, typeof classified[0]>();
  for (const e of classified) {
    if (e.type !== "night") continue;
    nightByStartDate.set(isoToDateInTz(e.startTime.toISOString(), tz), e);
    nightByEndDate.set(isoToDateInTz(e.endTime.toISOString(), tz), e);
  }

  // Build day records: wake-up from last night ending today,
  // naps from today, bedtime from tonight starting today.
  const days: DayRecord[] = [];
  for (const [date, naps] of [...napsByDate.entries()].sort()) {
    if (naps.length === 0) continue;

    // Wake-up: end of the night that ended today.
    // Skip days without a real wake time — fabricating from the first nap
    // produces semantically wrong data that poisons the backtest.
    const morningNight = nightByEndDate.get(date);
    if (!morningNight) continue;
    const wakeTime = morningNight.endTime.toISOString();

    // Tonight's bedtime: night sleep starting today
    const tonightNight = nightByStartDate.get(date);

    const sleeps = [
      ...naps.map((e) => ({
        start_time: e.startTime.toISOString(),
        end_time: e.endTime.toISOString(),
        type: "nap" as const,
      })),
      ...(tonightNight
        ? [{
            start_time: tonightNight.startTime.toISOString(),
            end_time: tonightNight.endTime.toISOString(),
            type: "night" as const,
          }]
        : []),
    ];

    days.push({ date, wakeTime, sleeps });
  }

  return days;
}

// --- main ---
const [inputPath, outputDir, tzArg] = process.argv.slice(2);
if (!inputPath || !outputDir) {
  console.error("Usage: bun scripts/kaggle-to-fixture.ts <input.csv> <output-dir> [timezone]");
  process.exit(1);
}
const sourceTz = tzArg ?? "America/New_York";

const csv = await Bun.file(inputPath).text();
const allEntries = parseKaggleCsv(csv, sourceTz);

// Group by baby
const byBaby = new Map<string, SleepEntry[]>();
for (const e of allEntries) {
  if (!byBaby.has(e.baby)) byBaby.set(e.baby, []);
  byBaby.get(e.baby)!.push(e);
}

await Bun.write(`${outputDir}/.gitkeep`, "");

for (const [babyId, entries] of byBaby) {
  const days = entriesToDays(entries, sourceTz);
  if (days.length < 7) {
    console.error(`${babyId}: only ${days.length} days, skipping`);
    continue;
  }

  // Estimate birthdate: assume tracking started near birth
  // Use first entry date minus 2 weeks as rough estimate
  const firstDate = new Date(days[0].date + "T00:00:00Z");
  const estimatedBirth = new Date(firstDate.getTime() - 14 * 86400000);
  const birthdate = estimatedBirth.toISOString().slice(0, 10);

  const fixture = { birthdate, days };
  const outPath = `${outputDir}/${babyId}-sleep.json`;
  await Bun.write(outPath, JSON.stringify(fixture, null, 2));
  console.error(`${babyId}: ${days.length} days → ${outPath}`);
}
