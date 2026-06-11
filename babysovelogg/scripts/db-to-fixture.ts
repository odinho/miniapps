#!/usr/bin/env bun
/**
 * Convert sleep data from our SQLite DB to a backtest fixture JSON file.
 *
 * Usage:
 *   bun scripts/db-to-fixture.ts [db-path] [output.json]
 *
 * Defaults: db-path = db.sqlite, output = stdout.
 *
 * The actual DB → DayRecord logic lives in `scripts/lib/db-to-days.ts` (shared
 * with `merge-fixtures.ts` and `backtest-report.ts --db`). It reads night
 * wakings from `night_waking` and walks `baby.updated` events so each day
 * carries the `target_bedtime` that was actually in effect then.
 */

import { dbToDays } from "./lib/db-to-days.js";

const [dbPath = "db.sqlite", outputPath] = process.argv.slice(2);

const { days } = dbToDays(dbPath);

const json = JSON.stringify(days, null, 2);
if (outputPath) {
  await Bun.write(outputPath, json);
  console.error(`Wrote ${days.length} days to ${outputPath}`);
} else {
  console.log(json);
}
