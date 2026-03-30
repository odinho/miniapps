#!/usr/bin/env bun
/**
 * Convert a Napper CSV export to a backtest fixture JSON file.
 *
 * Usage:
 *   bun scripts/napper-to-fixture.ts <input.csv> [output.json]
 *
 * Output defaults to stdout if no output path given.
 * The fixture is a JSON array of DayRecord objects ready for backtest.ts.
 */

import { parseNapperCsv } from "$lib/server/import-napper.js";

interface DayRecord {
  date: string;
  wakeTime: string;
  sleeps: { start_time: string; end_time: string; type: "nap" | "night" }[];
}

function toUtc(ts: string): string {
  return new Date(ts).toISOString();
}

function dateOf(ts: string): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function napperToDays(csv: string): DayRecord[] {
  const rows = parseNapperCsv(csv);
  const sorted = [...rows].toSorted(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );

  const days: DayRecord[] = [];
  let current: DayRecord | null = null;
  let pendingBedtime: string | null = null;

  for (const row of sorted) {
    switch (row.category) {
      case "WOKE_UP": {
        // Close previous day's night sleep if we had a bedtime
        if (pendingBedtime && current) {
          current.sleeps.push({
            start_time: pendingBedtime,
            end_time: toUtc(row.start),
            type: "night",
          });
          pendingBedtime = null;
        }

        // Start new day
        current = {
          date: dateOf(row.start),
          wakeTime: toUtc(row.start),
          sleeps: [],
        };
        days.push(current);
        break;
      }
      case "NAP": {
        if (!current) {
          // NAP before first WOKE_UP — create a synthetic day
          current = {
            date: dateOf(row.start),
            wakeTime: toUtc(row.start), // best guess
            sleeps: [],
          };
          days.push(current);
        }
        current.sleeps.push({
          start_time: toUtc(row.start),
          end_time: toUtc(row.end),
          type: "nap",
        });
        break;
      }
      case "BED_TIME": {
        pendingBedtime = toUtc(row.start);
        if (current) {
          // Add night as a sleep entry with end_time set when next WOKE_UP arrives
          // For now just record the start
        }
        break;
      }
      // NIGHT_WAKING, SOLIDS, MEDICINE: skip (pauses tracked separately)
    }
  }

  // Close trailing night if bedtime was last event
  if (pendingBedtime && current) {
    current.sleeps.push({
      start_time: pendingBedtime,
      end_time: pendingBedtime, // no end time available
      type: "night",
    });
  }

  return days;
}

// --- main ---
const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath) {
  console.error("Usage: bun scripts/napper-to-fixture.ts <input.csv> [output.json]");
  process.exit(1);
}

const csv = await Bun.file(inputPath).text();
const days = napperToDays(csv);

const json = JSON.stringify(days, null, 2);
if (outputPath) {
  await Bun.write(outputPath, json);
  console.error(`Wrote ${days.length} days to ${outputPath}`);
} else {
  console.log(json);
}
