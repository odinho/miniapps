import { test, expect } from "bun:test";
import Database from "bun:sqlite";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSettingsTimeline,
  effectiveSettings,
  dbToDays,
} from "../../scripts/lib/db-to-days.js";

/** Minimal subset of the prod schema the loader reads. */
function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE baby (id INTEGER PRIMARY KEY, timezone TEXT, birthdate TEXT);
    CREATE TABLE events (
      id INTEGER PRIMARY KEY, type TEXT, payload TEXT, timestamp TEXT
    );
    CREATE TABLE sleep_log (
      id INTEGER PRIMARY KEY, start_time TEXT, end_time TEXT, type TEXT,
      woke_by TEXT, deleted INTEGER DEFAULT 0
    );
    CREATE TABLE night_waking (
      id INTEGER PRIMARY KEY, baby_id INTEGER, domain_id TEXT, start_time TEXT,
      end_time TEXT, notes TEXT, mood TEXT, deleted INTEGER DEFAULT 0,
      created_by_event_id INTEGER, updated_by_event_id INTEGER
    );
    CREATE TABLE day_start (
      date TEXT, wake_time TEXT, off_day INTEGER, off_day_reason TEXT
    );
  `);
  db.run("INSERT INTO baby (id, timezone, birthdate) VALUES (1, 'Europe/Oslo', '2025-06-12')");
  return db;
}

function addEvent(db: Database, type: string, payload: object, timestamp: string) {
  db.run("INSERT INTO events (type, payload, timestamp) VALUES (?, ?, ?)", [
    type,
    JSON.stringify(payload),
    timestamp,
  ]);
}

test("settings timeline: walks baby.updated, same-day last-wins, UTC-normalized", () => {
  const db = makeDb();
  addEvent(db, "baby.created", { name: "B", birthdate: "2025-06-12" }, "2026-03-01 10:00:00");
  // Two changes on the same local day — the last one must win.
  addEvent(db, "baby.updated", { targetBedtime: null }, "2026-05-03 04:22:24");
  addEvent(db, "baby.updated", { targetBedtime: "18:00" }, "2026-05-03 04:22:43");
  // A bedtime set earlier in the window.
  addEvent(db, "baby.updated", { targetBedtime: "18:00", customNapCount: 1 }, "2026-04-05 18:34:35");
  // Cleared later.
  addEvent(db, "baby.updated", { targetBedtime: null }, "2026-05-04 09:31:49");

  const tl = loadSettingsTimeline(db, "Europe/Oslo");
  db.close();

  expect(tl).toEqual([
    { fromDate: "2026-03-01", settings: { targetBedtime: null, customNapCount: null } },
    { fromDate: "2026-04-05", settings: { targetBedtime: "18:00", customNapCount: 1 } },
    { fromDate: "2026-05-03", settings: { targetBedtime: "18:00", customNapCount: null } },
    { fromDate: "2026-05-04", settings: { targetBedtime: null, customNapCount: null } },
  ]);

  // Boundary checks: inclusive on the change date, carried forward until the next.
  expect(effectiveSettings(tl, "2026-04-04").targetBedtime).toBeNull();
  expect(effectiveSettings(tl, "2026-04-05").targetBedtime).toBe("18:00");
  expect(effectiveSettings(tl, "2026-04-20").targetBedtime).toBe("18:00");
  expect(effectiveSettings(tl, "2026-05-03").targetBedtime).toBe("18:00");
  expect(effectiveSettings(tl, "2026-05-04").targetBedtime).toBeNull();
  expect(effectiveSettings(tl, "2026-06-01").targetBedtime).toBeNull();
});

test("dbToDays: stamps per-day target_bedtime, off_day, and night_waking pauses", () => {
  const db = makeDb();
  addEvent(db, "baby.created", { name: "B", birthdate: "2025-06-12" }, "2026-04-01 10:00:00");
  addEvent(db, "baby.updated", { targetBedtime: "18:00" }, "2026-04-05 18:34:35");
  addEvent(db, "baby.updated", { targetBedtime: null }, "2026-04-07 09:00:00");

  // Apr 5: a nap + a night with a waking inside it.
  db.run(`INSERT INTO sleep_log (id, start_time, end_time, type, woke_by) VALUES
    (1, '2026-04-05T11:00:00.000Z', '2026-04-05T12:30:00.000Z', 'nap', 'self'),
    (2, '2026-04-05T19:00:00.000Z', '2026-04-06T05:00:00.000Z', 'night', 'self')`);
  // Waking inside the night (00:00–00:20). A nap-overlapping waking must be ignored.
  db.run(`INSERT INTO night_waking (id, baby_id, domain_id, start_time, end_time) VALUES
    (1, 1, 'nwk_a', '2026-04-06T00:00:00.000Z', '2026-04-06T00:20:00.000Z')`);
  // Apr 6: a nap, day flagged off.
  db.run(`INSERT INTO sleep_log (id, start_time, end_time, type, woke_by) VALUES
    (3, '2026-04-06T11:00:00.000Z', '2026-04-06T12:00:00.000Z', 'nap', 'self')`);
  db.run(`INSERT INTO day_start (date, wake_time, off_day, off_day_reason) VALUES
    ('2026-04-05', '2026-04-05T05:00:00.000Z', 0, NULL),
    ('2026-04-06', '2026-04-06T05:00:00.000Z', 1, 'sick')`);

  const tmp = join(mkdtempSync(join(tmpdir(), "dbdays-")), "test.db");
  // dbToDays opens its own connection by path, so serialize this in-memory db.
  writeFileSync(tmp, db.serialize());
  db.close();

  const { days, tz, birthdate } = dbToDays(tmp);
  expect(tz).toBe("Europe/Oslo");
  expect(birthdate).toBe("2025-06-12");

  const apr5 = days.find((d) => d.date === "2026-04-05")!;
  expect(apr5.target_bedtime).toBe("18:00");
  expect(apr5.off_day).toBeUndefined();
  const night = apr5.sleeps.find((s) => s.type === "night")!;
  expect(night.pauses).toEqual([
    { pause_time: "2026-04-06T00:00:00.000Z", resume_time: "2026-04-06T00:20:00.000Z" },
  ]);
  const nap5 = apr5.sleeps.find((s) => s.type === "nap")!;
  expect(nap5.pauses).toBeUndefined(); // wakings never attach to naps

  const apr6 = days.find((d) => d.date === "2026-04-06")!;
  expect(apr6.target_bedtime).toBe("18:00"); // set Apr 5, cleared Apr 7 → Apr 6 still carries it
  expect(apr6.off_day).toBe(1);
  expect(apr6.off_day_reason).toBe("sick");
});
