#!/usr/bin/env tsx
// baby — CLI for babysovelogg baby sleep tracker
//
// Designed for both humans and AI agents. Reads/writes go through
// the event-sourced database directly (no server required).
//
// Usage: tsx cli/baby.ts [command] [options]
//    or: pnpm baby [command] [options]

import { randomBytes } from "node:crypto";
import db, { closeDb } from "../server/db.js";
import { processBatchTx } from "../server/events.js";
import {
  calculateAgeMonths,
  predictNextNap,
  recommendBedtime,
  predictDayNaps,
} from "../src/engine/schedule.js";
import { getTodayStats, getWeekStats, getAverageWakeWindow } from "../src/engine/stats.js";
import type { Baby, SleepLogRow, SleepPauseRow, DayStartRow, SleepEntry } from "../types.js";

process.on("exit", closeDb);
db.pragma("busy_timeout = 3000");

// ── ID generation (Node.js-compatible, matches src/identity.ts format) ──

const EPOCH = new Date("2026-01-01T00:00:00Z").getTime();
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CLIENT_ID = "cli_baby";

function base36Time(): string {
  return Math.abs(Math.floor((Date.now() - EPOCH) / 1000)).toString(36);
}

function randomBase62(len: number): string {
  const bytes = randomBytes(len);
  let result = "";
  for (let i = 0; i < len; i++) result += BASE62[bytes[i] % 62];
  return result;
}

function genId(prefix: string): string {
  return `${prefix}_${base36Time()}${randomBase62(6)}`;
}

// ── Arg parsing ──

const rawArgs = process.argv.slice(2);
const flags: Record<string, string | true> = {};
const positional: string[] = [];

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === "--help" || arg === "-h") {
    flags.help = true;
  } else if (arg === "--json") {
    flags.json = true;
  } else if (arg.startsWith("--")) {
    const key = arg.slice(2);
    const next = rawArgs[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  } else {
    positional.push(arg);
  }
}

const command = positional[0] || "status";
const jsonOut = flags.json === true;

// ── Time parsing ──

function parseTime(value: string | true | undefined): string {
  if (!value || value === true) return new Date().toISOString();

  // Relative: -10m, -1h, -30s
  const rel = value.match(/^-(\d+)(s|m|h)$/);
  if (rel) {
    const n = parseInt(rel[1]);
    const ms = rel[2] === "h" ? n * 3600000 : rel[2] === "m" ? n * 60000 : n * 1000;
    return new Date(Date.now() - ms).toISOString();
  }

  // Time only: 14:30 → today at that time
  const hm = value.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date();
    d.setHours(parseInt(hm[1]), parseInt(hm[2]), 0, 0);
    return d.toISOString();
  }

  // Full date-time
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    console.error(`Invalid time format: "${value}"`);
    console.error("Accepted: 14:30, 2026-03-23T14:30, -10m, -1h");
    process.exit(1);
  }
  return d.toISOString();
}

// ── Formatting helpers ──

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

function fmtDuration(minutes: number): string {
  const m = Math.round(Math.max(0, minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r > 0 ? `${h}h ${r}m` : `${h}h`;
}

function fmtAgo(iso: string): string {
  const min = (Date.now() - new Date(iso).getTime()) / 60000;
  if (min < 1) return "just now";
  if (min < 60) return `${Math.round(min)}m ago`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
}

function sleepDuration(s: SleepLogRow): number {
  const endMs = s.end_time ? new Date(s.end_time).getTime() : Date.now();
  const total = (endMs - new Date(s.start_time).getTime()) / 60000;
  if (!s.pauses) return total;
  let pauseMs = 0;
  for (const p of s.pauses) {
    const ps = new Date(p.pause_time).getTime();
    const pe = p.resume_time ? new Date(p.resume_time).getTime() : endMs;
    pauseMs += pe - ps;
  }
  return total - pauseMs / 60000;
}

function toSleepEntry(s: SleepLogRow): SleepEntry {
  return {
    start_time: s.start_time,
    end_time: s.end_time,
    type: s.type as "nap" | "night",
    pauses: s.pauses?.map((p) => ({ pause_time: p.pause_time, resume_time: p.resume_time })),
  };
}

function formatTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(no results)";
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const header = cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const body = rows
    .map((r) => cols.map((c, i) => String(r[c] ?? "").padEnd(widths[i])).join("  "))
    .join("\n");
  return `${header}\n${sep}\n${body}`;
}

// ── Data access ──

function getBaby(): Baby {
  const baby = db.prepare("SELECT * FROM baby ORDER BY id DESC LIMIT 1").get() as Baby | undefined;
  if (!baby) {
    console.error("No baby configured. Use the web app to set up first.");
    process.exit(1);
  }
  return baby;
}

function getActiveSleep(babyId: number): (SleepLogRow & { pauses: SleepPauseRow[] }) | null {
  const sleep = db
    .prepare(
      "SELECT * FROM sleep_log WHERE baby_id = ? AND end_time IS NULL AND deleted = 0 ORDER BY id DESC LIMIT 1",
    )
    .get(babyId) as SleepLogRow | undefined;
  if (!sleep) return null;
  const pauses = db
    .prepare("SELECT * FROM sleep_pauses WHERE sleep_id = ? ORDER BY pause_time ASC")
    .all(sleep.id) as SleepPauseRow[];
  return { ...sleep, pauses };
}

function getSleeps(babyId: number, days: number, limit: number): SleepLogRow[] {
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const sleeps = db
    .prepare(
      "SELECT * FROM sleep_log WHERE baby_id = ? AND start_time >= ? AND deleted = 0 ORDER BY start_time DESC LIMIT ?",
    )
    .all(babyId, from, limit) as SleepLogRow[];
  attachPauses(sleeps);
  return sleeps;
}

function attachPauses(sleeps: SleepLogRow[]) {
  const ids = sleeps.map((s) => s.id);
  if (ids.length === 0) return;
  const allPauses = db
    .prepare(
      `SELECT * FROM sleep_pauses WHERE sleep_id IN (${ids.map(() => "?").join(",")}) ORDER BY pause_time ASC`,
    )
    .all(...ids) as SleepPauseRow[];
  const grouped = new Map<number, SleepPauseRow[]>();
  for (const p of allPauses) {
    if (!grouped.has(p.sleep_id)) grouped.set(p.sleep_id, []);
    grouped.get(p.sleep_id)!.push(p);
  }
  for (const s of sleeps) s.pauses = grouped.get(s.id) || [];
}

function getTodayWakeUp(babyId: number): DayStartRow | undefined {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return db
    .prepare("SELECT * FROM day_start WHERE baby_id = ? AND date = ?")
    .get(babyId, dateStr) as DayStartRow | undefined;
}

// ── Event helpers ──

function postEvent(type: string, payload: Record<string, unknown>) {
  return processBatchTx([{ type, payload, clientId: CLIENT_ID, clientEventId: genId("evt") }]);
}

// ── Commands ──

function cmdStatus() {
  const baby = getBaby();
  const ageMonths = calculateAgeMonths(baby.birthdate);
  const active = getActiveSleep(baby.id);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todaySleeps = db
    .prepare(
      "SELECT * FROM sleep_log WHERE baby_id = ? AND start_time >= ? AND deleted = 0 ORDER BY start_time ASC",
    )
    .all(baby.id, todayStart.toISOString()) as SleepLogRow[];
  attachPauses(todaySleeps);

  const wakeUp = getTodayWakeUp(baby.id);
  const stats = getTodayStats(todaySleeps.map(toSleepEntry));

  // Predictions
  let prediction: { nextNap?: string; bedtime?: string; predictedNaps?: unknown[] | null } | null =
    null;
  if (!active) {
    const lastCompleted = todaySleeps.toReversed().find((s) => s.end_time);
    const wakeTime = lastCompleted?.end_time || wakeUp?.wake_time;
    if (wakeTime) {
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const recentSleeps = db
        .prepare(
          "SELECT * FROM sleep_log WHERE baby_id = ? AND start_time >= ? AND deleted = 0 ORDER BY start_time DESC",
        )
        .all(baby.id, weekAgo) as SleepLogRow[];
      attachPauses(recentSleeps);
      const entries = recentSleeps.map(toSleepEntry);
      const customNaps = baby.custom_nap_count ?? null;
      prediction = {
        nextNap: predictNextNap(wakeTime, ageMonths, entries),
        bedtime: recommendBedtime(todaySleeps.map(toSleepEntry), ageMonths, customNaps),
      };
      if (wakeUp) {
        const allPredicted = predictDayNaps(wakeUp.wake_time, ageMonths, entries, customNaps);
        const completedNaps = todaySleeps.filter((s) => s.type === "nap" && s.end_time);
        prediction.predictedNaps = allPredicted.slice(completedNaps.length);
      }
    }
  }

  // Diapers
  const diaperCount = (
    db
      .prepare(
        "SELECT COUNT(*) as count FROM diaper_log WHERE baby_id = ? AND time >= ? AND deleted = 0",
      )
      .get(baby.id, todayStart.toISOString()) as { count: number }
  ).count;
  const lastDiaper = db
    .prepare(
      "SELECT time FROM diaper_log WHERE baby_id = ? AND deleted = 0 ORDER BY time DESC LIMIT 1",
    )
    .get(baby.id) as { time: string } | undefined;

  if (jsonOut) {
    console.log(
      JSON.stringify(
        {
          baby,
          ageMonths,
          activeSleep: active,
          todaySleeps,
          stats,
          prediction,
          diaperCount,
          lastDiaperTime: lastDiaper?.time ?? null,
          wakeUp,
        },
        null,
        2,
      ),
    );
    return;
  }

  // Text output
  const ageStr =
    ageMonths < 1 ? "newborn" : ageMonths === 1 ? "1 month old" : `${ageMonths} months old`;
  console.log(`${baby.name} (${ageStr})\n`);

  if (active) {
    const typeLabel = active.type === "night" ? "Night sleep" : "Napping";
    const dur = fmtDuration(sleepDuration(active));
    const isPaused =
      active.pauses.length > 0 && !active.pauses[active.pauses.length - 1].resume_time;
    const pauseNote = isPaused ? " [PAUSED]" : "";
    console.log(`Status:  ${typeLabel} since ${fmtTime(active.start_time)} (${dur})${pauseNote}`);
  } else {
    const lastSleep = todaySleeps.toReversed().find((s) => s.end_time);
    if (lastSleep) {
      console.log(
        `Status:  Awake since ${fmtTime(lastSleep.end_time!)} (${fmtAgo(lastSleep.end_time!)})`,
      );
    } else if (wakeUp) {
      console.log(
        `Status:  Awake since ${fmtTime(wakeUp.wake_time)} (${fmtAgo(wakeUp.wake_time)})`,
      );
    } else {
      console.log("Status:  Awake");
    }
  }

  // Today's sleeps
  if (todaySleeps.length > 0) {
    console.log("\nToday:");
    let napIdx = 0;
    for (const s of todaySleeps) {
      const label = s.type === "night" ? "Night" : `Nap ${++napIdx}`;
      const end = s.end_time ? fmtTime(s.end_time) : "...";
      const dur = fmtDuration(sleepDuration(s));
      const meta = [s.mood, s.method].filter(Boolean).join(", ");
      console.log(`  ${label.padEnd(8)} ${fmtTime(s.start_time)}-${end}  ${dur.padEnd(8)}${meta}`);
    }
    console.log(
      `  Total: ${fmtDuration(stats.totalNapMinutes)} nap time, ${stats.napCount} nap${stats.napCount !== 1 ? "s" : ""}`,
    );
  } else {
    console.log("\nNo sleeps today.");
  }

  // Predictions
  if (prediction) {
    console.log();
    if (prediction.nextNap) {
      const napTime = new Date(prediction.nextNap);
      const inMin = (napTime.getTime() - Date.now()) / 60000;
      const when = inMin > 0 ? `in ${fmtDuration(inMin)}` : `${fmtDuration(-inMin)} overdue`;
      console.log(`Next nap:  ~${fmtTime(prediction.nextNap)} (${when})`);
    }
    if (prediction.bedtime) {
      console.log(`Bedtime:   ~${fmtTime(prediction.bedtime)}`);
    }
  }

  // Diapers
  if (diaperCount > 0 || lastDiaper) {
    const lastStr = lastDiaper ? ` (last at ${fmtTime(lastDiaper.time)})` : "";
    console.log(`\nDiapers: ${diaperCount} today${lastStr}`);
  }

  if (wakeUp) {
    console.log(`Wake-up: ${fmtTime(wakeUp.wake_time)}`);
  }
}

function cmdSleeps() {
  const baby = getBaby();
  const days = typeof flags.days === "string" ? parseInt(flags.days) : 7;
  const limit = typeof flags.limit === "string" ? parseInt(flags.limit) : 50;
  const sleeps = getSleeps(baby.id, days, limit);

  if (jsonOut) {
    console.log(JSON.stringify(sleeps, null, 2));
    return;
  }

  if (sleeps.length === 0) {
    console.log("No sleeps found.");
    return;
  }

  console.log("Date        Type   Start  End    Duration  Mood/Method");
  console.log("----------  -----  -----  -----  --------  -----------");
  for (const s of sleeps) {
    const end = s.end_time ? fmtTime(s.end_time) : "...  ";
    const dur = fmtDuration(sleepDuration(s));
    const meta = [s.mood, s.method].filter(Boolean).join(", ");
    console.log(
      `${fmtDate(s.start_time)}  ${s.type.padEnd(5)}  ${fmtTime(s.start_time)}  ${end}  ${dur.padEnd(8)}  ${meta}`,
    );
  }
  console.log(
    `\n${sleeps.length} sleep${sleeps.length !== 1 ? "s" : ""} shown (last ${days} days)`,
  );
}

function cmdStats() {
  const baby = getBaby();
  const days = typeof flags.days === "string" ? parseInt(flags.days) : 7;
  const sleeps = getSleeps(baby.id, days, 500);
  const entries = sleeps.map(toSleepEntry);
  const weekStats = getWeekStats(entries);
  const avgWW = getAverageWakeWindow(entries);

  if (jsonOut) {
    console.log(JSON.stringify({ ...weekStats, avgWakeWindowMinutes: avgWW }, null, 2));
    return;
  }

  console.log(`Statistics (last ${days} days):\n`);
  console.log(`  Avg nap time:     ${fmtDuration(weekStats.avgNapMinutesPerDay)}/day`);
  console.log(`  Avg night time:   ${fmtDuration(weekStats.avgNightMinutesPerDay)}/day`);
  console.log(`  Avg naps/day:     ${weekStats.avgNapsPerDay}`);
  if (avgWW) console.log(`  Avg wake window:  ${fmtDuration(avgWW)}`);

  if (weekStats.days.length > 0) {
    console.log("\n  Day-by-day:");
    console.log("  Date        Naps  Nap time  Night time");
    console.log("  ----------  ----  --------  ----------");
    for (const d of weekStats.days) {
      console.log(
        `  ${d.date}  ${String(d.stats.napCount).padEnd(4)}  ${fmtDuration(d.stats.totalNapMinutes).padEnd(8)}  ${fmtDuration(d.stats.totalNightMinutes)}`,
      );
    }
  }
}

function cmdStartNap() {
  const baby = getBaby();
  const active = getActiveSleep(baby.id);
  if (active) {
    console.error(
      `Already sleeping (${active.type} started at ${fmtTime(active.start_time)}). End the current sleep first.`,
    );
    process.exit(1);
  }
  const startTime = parseTime(flags.at);
  const sleepDomainId = genId("slp");
  postEvent("sleep.started", { babyId: baby.id, startTime, type: "nap", sleepDomainId });

  if (jsonOut) {
    console.log(JSON.stringify({ ok: true, type: "nap", startTime, sleepDomainId }));
  } else {
    console.log(`Started nap at ${fmtTime(startTime)}.`);
  }
}

function cmdStartNight() {
  const baby = getBaby();
  const active = getActiveSleep(baby.id);
  if (active) {
    console.error(
      `Already sleeping (${active.type} started at ${fmtTime(active.start_time)}). End the current sleep first.`,
    );
    process.exit(1);
  }
  const startTime = parseTime(flags.at);
  const sleepDomainId = genId("slp");
  postEvent("sleep.started", { babyId: baby.id, startTime, type: "night", sleepDomainId });

  if (jsonOut) {
    console.log(JSON.stringify({ ok: true, type: "night", startTime, sleepDomainId }));
  } else {
    console.log(`Started night sleep at ${fmtTime(startTime)}.`);
  }
}

function cmdEnd() {
  const baby = getBaby();
  const active = getActiveSleep(baby.id);
  if (!active) {
    console.error("No active sleep to end.");
    process.exit(1);
  }
  const endTime = parseTime(flags.at);

  // End the sleep
  postEvent("sleep.ended", { sleepDomainId: active.domain_id, endTime });

  // Tag with metadata if provided
  const mood = typeof flags.mood === "string" ? flags.mood : undefined;
  const method = typeof flags.method === "string" ? flags.method : undefined;
  const notes = typeof flags.notes === "string" ? flags.notes : undefined;
  const wokeBy = typeof flags["woke-by"] === "string" ? flags["woke-by"] : undefined;
  const wakeNotes = typeof flags["wake-notes"] === "string" ? flags["wake-notes"] : undefined;

  if (mood || method || notes) {
    postEvent("sleep.tagged", {
      sleepDomainId: active.domain_id,
      mood: mood ?? null,
      method: method ?? null,
      notes: notes ?? null,
      fallAsleepTime: null,
    });
  }
  if (wokeBy || wakeNotes) {
    postEvent("sleep.updated", {
      sleepDomainId: active.domain_id,
      wokeBy: wokeBy ?? null,
      wakeNotes: wakeNotes ?? null,
    });
  }

  const dur = (new Date(endTime).getTime() - new Date(active.start_time).getTime()) / 60000;

  if (jsonOut) {
    console.log(
      JSON.stringify({
        ok: true,
        type: active.type,
        startTime: active.start_time,
        endTime,
        durationMinutes: Math.round(dur),
      }),
    );
  } else {
    console.log(
      `Ended ${active.type}. Duration: ${fmtDuration(dur)} (${fmtTime(active.start_time)}-${fmtTime(endTime)}).`,
    );
  }
}

function cmdPause() {
  const baby = getBaby();
  const active = getActiveSleep(baby.id);
  if (!active) {
    console.error("No active sleep to pause.");
    process.exit(1);
  }
  const isPaused = active.pauses.length > 0 && !active.pauses[active.pauses.length - 1].resume_time;
  if (isPaused) {
    console.error("Sleep is already paused.");
    process.exit(1);
  }
  const pauseTime = parseTime(flags.at);
  postEvent("sleep.paused", { sleepDomainId: active.domain_id, pauseTime });

  if (jsonOut) {
    console.log(JSON.stringify({ ok: true, pauseTime }));
  } else {
    console.log(`Paused at ${fmtTime(pauseTime)}.`);
  }
}

function cmdResume() {
  const baby = getBaby();
  const active = getActiveSleep(baby.id);
  if (!active) {
    console.error("No active sleep to resume.");
    process.exit(1);
  }
  const isPaused = active.pauses.length > 0 && !active.pauses[active.pauses.length - 1].resume_time;
  if (!isPaused) {
    console.error("Sleep is not paused.");
    process.exit(1);
  }
  const resumeTime = parseTime(flags.at);
  postEvent("sleep.resumed", { sleepDomainId: active.domain_id, resumeTime });

  if (jsonOut) {
    console.log(JSON.stringify({ ok: true, resumeTime }));
  } else {
    console.log(`Resumed at ${fmtTime(resumeTime)}.`);
  }
}

function cmdWake() {
  const baby = getBaby();
  const wakeTime = parseTime(flags.at);
  postEvent("day.started", { babyId: baby.id, wakeTime });

  if (jsonOut) {
    console.log(JSON.stringify({ ok: true, wakeTime }));
  } else {
    console.log(`Logged wake-up at ${fmtTime(wakeTime)}.`);
  }
}

function cmdDiaper() {
  const baby = getBaby();
  const type = typeof flags.type === "string" ? flags.type : undefined;
  if (!type) {
    console.error("--type is required. Values: wet, dirty, both, dry");
    process.exit(1);
  }
  const time = parseTime(flags.at);
  const diaperDomainId = genId("dip");
  const amount = typeof flags.amount === "string" ? flags.amount : null;
  const note = typeof flags.note === "string" ? flags.note : null;

  postEvent("diaper.logged", { babyId: baby.id, time, type, diaperDomainId, amount, note });

  if (jsonOut) {
    console.log(JSON.stringify({ ok: true, type, time, diaperDomainId }));
  } else {
    console.log(`Logged ${type} diaper at ${fmtTime(time)}.`);
  }
}

function cmdQuery() {
  const sql = positional.slice(1).join(" ");
  if (!sql) {
    console.error('Usage: baby query "SELECT ..."');
    process.exit(1);
  }

  const normalized = sql.trim().toUpperCase();
  if (
    !normalized.startsWith("SELECT") &&
    !normalized.startsWith("EXPLAIN") &&
    !normalized.startsWith("PRAGMA") &&
    !normalized.startsWith("WITH")
  ) {
    console.error("Only SELECT, EXPLAIN, PRAGMA, and WITH (CTE) queries are allowed.");
    process.exit(1);
  }

  try {
    const rows = db.prepare(sql).all() as Record<string, unknown>[];

    if (jsonOut) {
      console.log(JSON.stringify(rows, null, 2));
    } else if (rows.length === 0) {
      console.log("(no results)");
    } else {
      console.log(formatTable(rows));
    }
  } catch (err) {
    console.error(`SQL error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

// ── Help text ──

const MAIN_HELP = `babysovelogg CLI — Baby sleep tracker

USAGE
  baby [command] [options]

COMMANDS
  status          Current state, today's sleeps, predictions (default)
  sleeps          Recent sleep history
  stats           Sleep statistics
  start-nap       Start a nap
  start-night     Start night sleep
  end             End the current sleep
  pause           Pause current sleep
  resume          Resume paused sleep
  wake            Log morning wake-up (day start)
  diaper          Log a diaper change
  query <sql>     Run a read-only SQL query

FLAGS
  --json          Output as JSON (for programmatic use)
  --help, -h      Show help (use with a command for full options)

EXAMPLES
  baby                                  Current status
  baby --json                           Status as JSON
  baby start-nap                        Start nap now
  baby start-nap --at 14:30             Start nap at 14:30 today
  baby start-nap --at -10m              Started napping 10 minutes ago
  baby end                              End current sleep now
  baby end --at 15:00 --mood happy      End at 15:00 with mood
  baby sleeps --days 3                  Last 3 days of sleeps
  baby stats                            7-day statistics
  baby diaper --type wet                Log wet diaper now
  baby wake --at 07:30                  Baby woke up at 07:30
  baby query "SELECT * FROM sleep_log WHERE deleted=0 ORDER BY id DESC LIMIT 5"

TABLES (for query command)
  baby          Baby profile (name, birthdate)
  sleep_log     Sleep sessions (start_time, end_time, type, mood, method, notes, ...)
  sleep_pauses  Pause/resume records within a sleep
  diaper_log    Diaper changes (time, type, amount, note)
  day_start     Daily wake-up times (date, wake_time)
  events        Raw event log (type, payload JSON, timestamp)

  All tables use soft deletes (deleted=0 for active rows).
  Times are ISO 8601 strings. Types: "nap" or "night".`;

const CMD_HELP: Record<string, string> = {
  status: `baby status — Show current state, today's sleeps, and predictions

USAGE
  baby [status] [--json]

Shows baby's name and age, whether sleeping or awake, today's sleep log
with durations, predicted next nap and bedtime, and diaper count.

This is the default command when no subcommand is given.`,

  sleeps: `baby sleeps — Show recent sleep history

USAGE
  baby sleeps [options]

OPTIONS
  --days <n>      Number of days to look back (default: 7)
  --limit <n>     Maximum rows to return (default: 50)
  --json          Output as JSON

EXAMPLES
  baby sleeps                   Last 7 days
  baby sleeps --days 30         Last month
  baby sleeps --json            JSON for further processing`,

  stats: `baby stats — Show sleep statistics

USAGE
  baby stats [options]

OPTIONS
  --days <n>      Number of days to analyze (default: 7)
  --json          Output as JSON

Shows average nap time, night time, naps per day, wake window,
and a day-by-day breakdown.

EXAMPLES
  baby stats                    7-day overview
  baby stats --days 14          2-week overview`,

  "start-nap": `baby start-nap — Start a nap

USAGE
  baby start-nap [options]

OPTIONS
  --at <time>     When the nap started (default: now)
                  Formats: 14:30, 2026-03-23T14:30, -10m, -1h
  --json          Output as JSON

Fails if there's already an active sleep.

EXAMPLES
  baby start-nap                Start now
  baby start-nap --at 14:30     Started at 14:30
  baby start-nap --at -5m       Started 5 minutes ago`,

  "start-night": `baby start-night — Start night sleep

USAGE
  baby start-night [options]

OPTIONS
  --at <time>     When night sleep started (default: now)
                  Formats: 14:30, 2026-03-23T14:30, -10m, -1h
  --json          Output as JSON

Fails if there's already an active sleep.

EXAMPLES
  baby start-night              Start now
  baby start-night --at 19:30   Started at 19:30`,

  end: `baby end — End the current active sleep

USAGE
  baby end [options]

OPTIONS
  --at <time>         When the sleep ended (default: now)
                      Formats: 14:30, 2026-03-23T14:30, -10m, -1h
  --mood <mood>       Baby's mood on waking
                      Examples: happy, crying, calm, fussy, content
  --method <method>   How baby fell asleep
                      Examples: nursing, rocking, stroller, car, self, carrier
  --notes <text>      Notes about the sleep
  --woke-by <cause>   What woke the baby
                      Examples: self, noise, sibling, parent, hunger
  --wake-notes <text> Notes about the waking
  --json              Output as JSON

Fails if there's no active sleep.

EXAMPLES
  baby end                              End now
  baby end --at 15:00                   Ended at 15:00
  baby end --mood happy --method self   Woke up happy, fell asleep by self
  baby end --at -5m --notes "Short nap, seemed tired still"`,

  pause: `baby pause — Pause the current sleep

USAGE
  baby pause [options]

OPTIONS
  --at <time>     When the pause started (default: now)
                  Formats: 14:30, 2026-03-23T14:30, -10m, -1h
  --json          Output as JSON

Use when baby wakes briefly mid-nap. Resume with "baby resume".
Paused time is subtracted from total sleep duration.

EXAMPLES
  baby pause                Pause now
  baby pause --at 14:45     Paused at 14:45`,

  resume: `baby resume — Resume a paused sleep

USAGE
  baby resume [options]

OPTIONS
  --at <time>     When sleep resumed (default: now)
                  Formats: 14:30, 2026-03-23T14:30, -10m, -1h
  --json          Output as JSON

EXAMPLES
  baby resume               Resume now
  baby resume --at 14:55    Resumed at 14:55`,

  wake: `baby wake — Log the morning wake-up time

USAGE
  baby wake [options]

OPTIONS
  --at <time>     When baby woke up (default: now)
                  Formats: 07:30, 2026-03-23T07:30, -30m
  --json          Output as JSON

Sets the day's anchor time used for nap predictions. One per day
(overwrites if called again for the same date).

EXAMPLES
  baby wake                 Woke up now
  baby wake --at 07:30      Woke up at 07:30`,

  diaper: `baby diaper — Log a diaper change

USAGE
  baby diaper --type <type> [options]

OPTIONS
  --type <type>   Diaper type (required)
                  Values: wet, dirty, both, dry
  --at <time>     When the change happened (default: now)
                  Formats: 14:30, 2026-03-23T14:30, -10m, -1h
  --amount <amt>  Amount description (e.g. small, medium, large)
  --note <text>   Notes
  --json          Output as JSON

EXAMPLES
  baby diaper --type wet                Wet diaper now
  baby diaper --type dirty --at 14:30   Dirty diaper at 14:30
  baby diaper --type both --note "Big one" --amount large`,

  query: `baby query — Run a read-only SQL query

USAGE
  baby query "<sql>"
  baby query "<sql>" --json

Only SELECT, EXPLAIN, PRAGMA, and WITH (CTE) queries are allowed.
Results display as an aligned table (text) or array (JSON).

TABLES
  baby          id, name, birthdate, created_at, custom_nap_count, potty_mode
  sleep_log     id, baby_id, start_time, end_time, type, notes, mood, method,
                fall_asleep_time, woke_by, wake_notes, deleted, domain_id
  sleep_pauses  id, sleep_id, pause_time, resume_time
  diaper_log    id, baby_id, time, type, amount, note, deleted, domain_id
  day_start     id, baby_id, date, wake_time, created_at
  events        id, type, payload, client_id, client_event_id, timestamp,
                domain_id

EXAMPLES
  baby query "SELECT count(*) as total FROM sleep_log WHERE deleted=0"
  baby query "SELECT start_time, end_time, type FROM sleep_log WHERE deleted=0 ORDER BY id DESC LIMIT 10"
  baby query "SELECT date, wake_time FROM day_start ORDER BY date DESC LIMIT 7"
  baby query "SELECT type, count(*) as n FROM diaper_log WHERE deleted=0 GROUP BY type"
  baby query "PRAGMA table_info(sleep_log)"`,
};

// ── Dispatch ──

if (flags.help) {
  if (command !== "status" || positional.length > 0) {
    console.log(CMD_HELP[command] || `Unknown command: ${command}\n\n${MAIN_HELP}`);
  } else {
    console.log(MAIN_HELP);
  }
  process.exit(0);
}

const commands: Record<string, () => void> = {
  status: cmdStatus,
  sleeps: cmdSleeps,
  stats: cmdStats,
  "start-nap": cmdStartNap,
  "start-night": cmdStartNight,
  end: cmdEnd,
  pause: cmdPause,
  resume: cmdResume,
  wake: cmdWake,
  diaper: cmdDiaper,
  query: cmdQuery,
};

const handler = commands[command];
if (!handler) {
  console.error(`Unknown command: ${command}\n`);
  console.log(MAIN_HELP);
  process.exit(1);
}

handler();
