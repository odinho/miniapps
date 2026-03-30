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

function entriesToDays(entries: SleepEntry[]): DayRecord[] {
  // Sort chronologically
  const sorted = [...entries].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  // Group by calendar date of wake-up (end time for night sleep, start time for naps)
  const dayMap = new Map<string, SleepEntry[]>();
  for (const e of sorted) {
    const hour = e.startTime.getUTCHours();
    const type = classifySleep(e, hour);

    // For night sleep, assign to the NEXT day (when baby wakes up)
    const assignDate =
      type === "night"
        ? e.endTime.toISOString().slice(0, 10)
        : e.startTime.toISOString().slice(0, 10);

    if (!dayMap.has(assignDate)) dayMap.set(assignDate, []);
    dayMap.get(assignDate)!.push(e);
  }

  const days: DayRecord[] = [];
  for (const [date, daySleeps] of [...dayMap.entries()].sort()) {
    const chronological = daySleeps.sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );

    // Find night sleep (should end in this day = wake-up)
    const nightSleep = chronological.find(
      (e) => classifySleep(e, e.startTime.getUTCHours()) === "night",
    );

    // Wake time: end of night sleep, or earliest entry
    const wakeTime = nightSleep
      ? nightSleep.endTime.toISOString()
      : chronological[0].startTime.toISOString();

    // Build sleep entries
    const sleeps = chronological.map((e) => {
      const hour = e.startTime.getUTCHours();
      return {
        start_time: e.startTime.toISOString(),
        end_time: e.endTime.toISOString(),
        type: classifySleep(e, hour),
      };
    });

    // Skip days with no naps — they have no prediction target
    const naps = sleeps.filter((s) => s.type === "nap");
    if (naps.length === 0) continue;

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
  const days = entriesToDays(entries);
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
