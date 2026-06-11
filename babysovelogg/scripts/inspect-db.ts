#!/usr/bin/env bun
/**
 * Quick read-only summary of a prod/backup SQLite db — tables, baby row,
 * event-type counts, the walked settings timeline, and a sleep summary.
 *
 * Usage: bun scripts/inspect-db.ts <db-path>
 *
 * Exists so sessions stop hand-rolling throwaway inspection scripts. See the
 * `babysovelogg-prod-db-access` memory for how to pull the dbs.
 */

import Database from "bun:sqlite";
import { loadSettingsTimeline } from "./lib/db-to-days.js";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("Usage: bun scripts/inspect-db.ts <db-path>");
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all() as { name: string }[];
console.log(`\n== ${dbPath} ==`);
console.log("tables:", tables.map((t) => t.name).join(", "));

const baby = db.prepare("SELECT * FROM baby ORDER BY id").all() as Record<string, unknown>[];
console.log(`\nbaby (${baby.length}):`);
for (const b of baby) console.log("  ", JSON.stringify(b));

const tz =
  (baby[0]?.timezone as string) || "Europe/Oslo";
console.log("\nsettings timeline (walked from baby.updated):");
for (const c of loadSettingsTimeline(db, tz)) {
  console.log(`  ${c.fromDate}: targetBedtime=${c.settings.targetBedtime ?? "—"} customNapCount=${c.settings.customNapCount ?? "—"}`);
}

const evTypes = db
  .prepare("SELECT type, COUNT(*) n FROM events GROUP BY type ORDER BY n DESC")
  .all() as { type: string; n: number }[];
const evRange = db.prepare("SELECT MIN(timestamp) a, MAX(timestamp) b, COUNT(*) n FROM events").get() as {
  a: string;
  b: string;
  n: number;
};
console.log(`\nevents (${evRange.n}, ${evRange.a} → ${evRange.b}):`);
for (const e of evTypes) console.log(`  ${e.type}: ${e.n}`);

const sleepCount = db.prepare("SELECT COUNT(*) n FROM sleep_log WHERE deleted = 0").get() as { n: number };
const sleepRange = db
  .prepare("SELECT MIN(start_time) a, MAX(start_time) b FROM sleep_log WHERE deleted = 0")
  .get() as { a: string | null; b: string | null };
const openSleeps = db.prepare("SELECT COUNT(*) n FROM sleep_log WHERE deleted = 0 AND end_time IS NULL").get() as { n: number };
const wakings = db.prepare("SELECT COUNT(*) n FROM night_waking WHERE deleted = 0").get() as { n: number };
console.log(
  `\nsleep_log: ${sleepCount.n} (${sleepRange.a} → ${sleepRange.b}), open=${openSleeps.n}; night_waking rows=${wakings.n}`,
);

db.close();
