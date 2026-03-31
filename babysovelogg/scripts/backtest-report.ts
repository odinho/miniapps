#!/usr/bin/env bun

import { backtest, bucketByWarmup, bucketResultsByAge, formatReport, renderSummary } from "$lib/engine/backtest.js";
import type { DayRecord } from "$lib/engine/backtest.js";

interface Options {
  fixturePath: string;
  birthdate: string;
  tz: string;
  label: string;
  customNapCount: number | null;
  full: boolean;
}

function printUsage() {
  console.log(`Usage:
  bun scripts/backtest-report.ts <fixture.json> --birthdate YYYY-MM-DD [options]

Options:
  --tz <iana-tz>           Timezone for age/date calculations (default: Europe/Oslo)
  --label <text>           Label for the main report (default: fixture filename)
  --custom-nap-count <n>   Override nap count during backtest
  --full                   Print per-day detailed report in addition to summaries

Examples:
  bun scripts/backtest-report.ts tests/fixtures/halldis-sleep.json --birthdate 2025-06-12
  bun run backtest:report -- tests/fixtures/halldis-sleep.json --birthdate 2025-06-12 --full
`);
}

function parseArgs(argv: string[]): Options | null {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return null;
  }

  const [fixturePath, ...rest] = argv;
  if (!fixturePath || fixturePath.startsWith("-")) {
    console.error("Missing fixture path.");
    printUsage();
    process.exit(1);
  }

  const options: Options = {
    fixturePath,
    birthdate: "",
    tz: "Europe/Oslo",
    label: fixturePath.split("/").pop()?.replace(/\.json$/, "") || "backtest",
    customNapCount: null,
    full: false,
  };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--birthdate") {
      options.birthdate = rest[++i] ?? "";
    } else if (arg === "--tz") {
      options.tz = rest[++i] ?? options.tz;
    } else if (arg === "--label") {
      options.label = rest[++i] ?? options.label;
    } else if (arg === "--custom-nap-count") {
      const value = Number(rest[++i]);
      if (!Number.isInteger(value) || value < 0) {
        console.error("--custom-nap-count must be a non-negative integer.");
        process.exit(1);
      }
      options.customNapCount = value;
    } else if (arg === "--full") {
      options.full = true;
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.birthdate)) {
    console.error("Missing or invalid --birthdate (expected YYYY-MM-DD).");
    printUsage();
    process.exit(1);
  }

  return options;
}

function printSection(title: string, lines: string[]) {
  if (lines.length === 0) return;
  console.log(`\n${title}`);
  for (const line of lines) console.log(line);
}

const options = parseArgs(process.argv.slice(2));
if (!options) process.exit(0);

const file = Bun.file(options.fixturePath);
if (!(await file.exists())) {
  console.error(`Fixture not found: ${options.fixturePath}`);
  process.exit(1);
}

const days = await file.json() as DayRecord[];
const result = backtest(days, options.birthdate, {
  tz: options.tz,
  customNapCount: options.customNapCount,
});

console.log(renderSummary(result, options.label));

const ageBuckets = bucketResultsByAge(result, options.birthdate)
  .map((bucket) => renderSummary(bucket.result, bucket.label));
printSection("Per age bucket", ageBuckets);

const warmupBuckets = bucketByWarmup(result)
  .map((bucket) => renderSummary(bucket.result, bucket.label));
printSection("Warm-up buckets", warmupBuckets);

if (options.full) {
  console.log(`\nDetailed report\n${formatReport(result, options.label)}`);
}
