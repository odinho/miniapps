import { test, expect } from "bun:test";
import {
  get,
  postEvents,
  createBaby,
  makeEvent,
  generateSleepId,
  generateDiaperId,
  db,
  setupHarness,
} from "./harness.js";
setupHarness();
import { renderDayState } from "../helpers/render-state.js";

// --- B12: Wakeup time visible in API (derived from night sleep end) ---

test("B12: GET /api/wakeups returns wakeups derived from night sleeps", async () => {
  const babyId = createBaby("Testa");
  const did = generateSleepId();

  await postEvents([
    makeEvent("sleep.started", {
      babyId,
      startTime: "2026-03-25T19:00:00.000Z",
      type: "night",
      sleepDomainId: did,
    }),
  ]);
  await postEvents([
    makeEvent("sleep.ended", {
      sleepDomainId: did,
      endTime: "2026-03-26T06:10:00.000Z",
    }),
  ]);

  const wakeups = await (await get("/api/wakeups?limit=50")).json();
  expect(wakeups).toMatchObject([
    { wake_time: "2026-03-26T06:10:00.000Z", baby_id: babyId },
  ]);
});

// --- B15: Editing a nap to become a night sleep should NOT delete the entry ---

test("B15: sleep.updated changing type from nap to night preserves the entry", async () => {
  const babyId = createBaby("Testa");
  const did = generateSleepId();

  await postEvents([
    makeEvent("sleep.started", {
      babyId,
      startTime: "2026-03-26T09:00:00.000Z",
      type: "nap",
      sleepDomainId: did,
    }),
  ]);
  await postEvents([
    makeEvent("sleep.ended", {
      sleepDomainId: did,
      endTime: "2026-03-26T10:30:00.000Z",
    }),
  ]);

  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    søvn: 09:00–10:30 lur
    bleier: (ingen)"
  `);

  // Change type to night
  await postEvents([
    makeEvent("sleep.updated", {
      sleepDomainId: did,
      type: "night",
    }),
  ]);

  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    vekketid: 10:30
    søvn: 09:00–10:30 natt
    bleier: (ingen)"
  `);
});

test("B15: sleep.updated with type + times preserves the entry", async () => {
  const babyId = createBaby("Testa");
  const did = generateSleepId();

  await postEvents([
    makeEvent("sleep.started", {
      babyId,
      startTime: "2026-03-26T09:00:00.000Z",
      type: "nap",
      sleepDomainId: did,
    }),
  ]);
  await postEvents([
    makeEvent("sleep.ended", {
      sleepDomainId: did,
      endTime: "2026-03-26T10:30:00.000Z",
    }),
  ]);

  await postEvents([
    makeEvent("sleep.updated", {
      sleepDomainId: did,
      startTime: "2026-03-26T08:30:00.000Z",
      endTime: "2026-03-26T10:00:00.000Z",
      type: "night",
      mood: null,
      method: null,
      fallAsleepTime: null,
      notes: null,
    }),
  ]);

  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    vekketid: 10:00
    søvn: 08:30–10:00 natt
    bleier: (ingen)"
  `);
});

// --- Wakeup derivation: night sleep end_time IS the morning ---

test("Wakeup derived from overnight night sleep — no day.started needed", async () => {
  const babyId = createBaby("Testa");
  const did = generateSleepId();
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const nightStart = `${yesterday}T18:30:00.000Z`;
  const nightEnd = `${today}T06:00:00.000Z`;

  await postEvents([
    makeEvent("sleep.started", { babyId, startTime: nightStart, type: "night", sleepDomainId: did }),
  ]);
  await postEvents([
    makeEvent("sleep.ended", { sleepDomainId: did, endTime: nightEnd }),
  ]);

  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    vekketid: 06:00
    søvn: 18:30–06:00 natt
    bleier: (ingen)"
  `);

  // API should derive todayWakeUp from the night sleep end
  const state = await (await get("/api/state")).json();
  expect(state.todayWakeUp.wake_time).toBe(nightEnd);
});

test("Wakeup is the last night fragment when the night is logged in pieces", async () => {
  // Umi 2026-06-12: the night was logged as three separate `night` sleeps
  // split by wake-ups (not one sleep + night_wakings). Only the first
  // fragment straddles midnight, so the old midnight-straddle selector
  // reported its end (00:25) as the morning wake — the day arc anchored to
  // the middle of the night instead of the real ~07:29 wake.
  const babyId = createBaby("Umi");
  db.prepare("UPDATE baby SET timezone = ? WHERE id = ?").run("UTC", babyId);

  const night = (start: string, end: string) => {
    const id = generateSleepId();
    return [
      makeEvent("sleep.started", { babyId, startTime: start, type: "night", sleepDomainId: id }),
      makeEvent("sleep.ended", { sleepDomainId: id, endTime: end }),
    ];
  };
  const nap = (start: string, end: string) => {
    const id = generateSleepId();
    return [
      makeEvent("sleep.started", { babyId, startTime: start, type: "nap", sleepDomainId: id }),
      makeEvent("sleep.ended", { sleepDomainId: id, endTime: end }),
    ];
  };

  await postEvents([
    ...night("2026-05-19T23:00:00.000Z", "2026-05-20T00:25:00.000Z"), // straddles midnight
    ...night("2026-05-20T00:56:00.000Z", "2026-05-20T04:29:00.000Z"),
    ...night("2026-05-20T05:05:00.000Z", "2026-05-20T07:29:00.000Z"), // real morning wake
    ...nap("2026-05-20T07:41:00.000Z", "2026-05-20T09:25:00.000Z"),
  ]);

  const nowMs = new Date("2026-05-20T10:00:00.000Z").getTime();
  const state = await (await get(`/api/state?now=${nowMs}`)).json();

  // The morning wake is the END of the LAST night fragment, not the first.
  expect(state.todayWakeUp.wake_time).toBe("2026-05-20T07:29:00.000Z");

  // The straddler still drives the pre-midnight duration recovery, so the
  // "Søvn i dag" total stays whole (85 min pre-midnight + the post-midnight
  // fragments counted in todaySleeps).
  expect(state.priorOvernightSleep).toMatchObject({
    start_time: "2026-05-19T23:00:00.000Z",
    end_time: "2026-05-20T00:25:00.000Z",
  });
  expect(state.dayTotals).toMatchObject({
    priorNightMinutes: 85, // 23:00 → 00:25
    todayNightMinutes: 357, // 213 (00:56→04:29) + 144 (05:05→07:29)
    napMinutes: 104, // 07:41 → 09:25
    includesPriorNight: true,
  });
});

test("Evening night-typed sleep on a no-nap day does NOT become the morning wake", async () => {
  // A baby who no longer naps has the morning overnight + an evening bedtime
  // and nothing between. The evening sleep is classified `night` and starts
  // before any nap that day, so a naive leading-`night` scan would walk it
  // into the overnight and report 19:30 as the morning wake. The same-night
  // gap guard breaks on the 12h awake stretch.
  const babyId = createBaby("Testa");
  db.prepare("UPDATE baby SET timezone = ? WHERE id = ?").run("UTC", babyId);

  const sleep = (type: string, start: string, end: string) => {
    const id = generateSleepId();
    return [
      makeEvent("sleep.started", { babyId, startTime: start, type, sleepDomainId: id }),
      makeEvent("sleep.ended", { sleepDomainId: id, endTime: end }),
    ];
  };

  await postEvents([
    ...sleep("night", "2026-05-19T23:00:00.000Z", "2026-05-20T07:00:00.000Z"), // overnight
    ...sleep("night", "2026-05-20T19:00:00.000Z", "2026-05-20T19:30:00.000Z"), // evening false start
  ]);

  const nowMs = new Date("2026-05-20T20:00:00.000Z").getTime();
  const state = await (await get(`/api/state?now=${nowMs}`)).json();

  expect(state.todayWakeUp.wake_time).toBe("2026-05-20T07:00:00.000Z");
});

test("Active overnight continuation reports the last completed wake, not an earlier fragment", async () => {
  // Fragmented night where the last piece is still open (baby asleep). The
  // morning wake hasn't happened yet; todayWakeUp reflects the last completed
  // fragment end (04:29), not the midnight-straddle fragment (00:25). The
  // dashboard masks this behind the active-sleep view, but the engine/API
  // should still get the most recent completed wake.
  const babyId = createBaby("Testa");
  db.prepare("UPDATE baby SET timezone = ? WHERE id = ?").run("UTC", babyId);

  const did1 = generateSleepId();
  const did2 = generateSleepId();
  const openId = generateSleepId();
  await postEvents([
    makeEvent("sleep.started", { babyId, startTime: "2026-05-19T23:00:00.000Z", type: "night", sleepDomainId: did1 }),
    makeEvent("sleep.ended", { sleepDomainId: did1, endTime: "2026-05-20T00:25:00.000Z" }),
    makeEvent("sleep.started", { babyId, startTime: "2026-05-20T00:56:00.000Z", type: "night", sleepDomainId: did2 }),
    makeEvent("sleep.ended", { sleepDomainId: did2, endTime: "2026-05-20T04:29:00.000Z" }),
    makeEvent("sleep.started", { babyId, startTime: "2026-05-20T05:05:00.000Z", type: "night", sleepDomainId: openId }),
  ]);

  const nowMs = new Date("2026-05-20T06:00:00.000Z").getTime();
  const state = await (await get(`/api/state?now=${nowMs}`)).json();

  expect(state.todayWakeUp.wake_time).toBe("2026-05-20T04:29:00.000Z");
});

// --- Sleep-day totals: prior overnight contributes to today's daily total ---

test("dayTotals includes the overnight that ended this morning", async () => {
  // Reproduces the 2026-05-20 Halldis report: parent saw a daytime UI where
  // "today" omitted the morning's overnight. `todaySleeps` filters
  // start_time >= midnight; the new dayTotals + priorOvernightSleep fields
  // expose the prior night so UI surfaces can use the parent's natural
  // "wake-to-wake" framing.
  const babyId = createBaby("Halldis");
  // Force baby tz to UTC so today-boundary math is deterministic.
  db.prepare("UPDATE baby SET timezone = ? WHERE id = ?").run("UTC", babyId);

  // Overnight 19:00 yesterday → 07:00 today (12h, in UTC)
  const overnightId = generateSleepId();
  await postEvents([
    makeEvent("sleep.started", {
      babyId,
      startTime: "2026-05-19T19:00:00.000Z",
      type: "night",
      sleepDomainId: overnightId,
    }),
  ]);
  await postEvents([
    makeEvent("sleep.ended", {
      sleepDomainId: overnightId,
      endTime: "2026-05-20T07:00:00.000Z",
    }),
  ]);

  // Today's nap 11:00 → 12:30 (90 min)
  const napId = generateSleepId();
  await postEvents([
    makeEvent("sleep.started", {
      babyId,
      startTime: "2026-05-20T11:00:00.000Z",
      type: "nap",
      sleepDomainId: napId,
    }),
  ]);
  await postEvents([
    makeEvent("sleep.ended", {
      sleepDomainId: napId,
      endTime: "2026-05-20T12:30:00.000Z",
    }),
  ]);

  const nowMs = new Date("2026-05-20T13:30:00.000Z").getTime();
  const state = await (await get(`/api/state?now=${nowMs}`)).json();

  // `stats` (calendar-day) does NOT include the morning overnight.
  expect(state.stats.totalNightMinutes).toBe(0);
  expect(state.stats.totalNapMinutes).toBe(90);

  // `dayTotals` (sleep-day) DOES include it.
  expect(state.dayTotals).toMatchObject({
    napMinutes: 90,
    todayNightMinutes: 0,
    priorNightMinutes: 720, // 12h
    totalMinutes: 810,
    includesPriorNight: true,
  });

  // The full prior-overnight row is exposed so UI can render its time range.
  expect(state.priorOvernightSleep).toMatchObject({
    start_time: "2026-05-19T19:00:00.000Z",
    end_time: "2026-05-20T07:00:00.000Z",
    type: "night",
  });
});

test("dayTotals returns priorNightMinutes=0 when no overnight ended today", async () => {
  const babyId = createBaby("Testa");
  db.prepare("UPDATE baby SET timezone = ? WHERE id = ?").run("UTC", babyId);

  const napId = generateSleepId();
  await postEvents([
    makeEvent("sleep.started", {
      babyId,
      startTime: "2026-05-20T11:00:00.000Z",
      type: "nap",
      sleepDomainId: napId,
    }),
  ]);
  await postEvents([
    makeEvent("sleep.ended", {
      sleepDomainId: napId,
      endTime: "2026-05-20T12:30:00.000Z",
    }),
  ]);

  const nowMs = new Date("2026-05-20T13:30:00.000Z").getTime();
  const state = await (await get(`/api/state?now=${nowMs}`)).json();

  expect(state.dayTotals).toMatchObject({
    napMinutes: 90,
    priorNightMinutes: 0,
    totalMinutes: 90,
    includesPriorNight: false,
  });
  expect(state.priorOvernightSleep).toBeNull();
});

// --- B5+B6: Diaper note and type visibility ---

test("B5: diaper with dirty type preserves type in response", async () => {
  const babyId = createBaby("Testa");
  const did = generateDiaperId();

  await postEvents([
    makeEvent("diaper.logged", {
      babyId,
      time: "2026-03-26T10:00:00.000Z",
      type: "dirty",
      amount: "middels",
      diaperDomainId: did,
    }),
  ]);

  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    søvn: (ingen)
    bleier: 10:00 dirty middels"
  `);
});

test("B6: diaper note is stored and returned", async () => {
  const babyId = createBaby("Testa");
  const did = generateDiaperId();

  await postEvents([
    makeEvent("diaper.logged", {
      babyId,
      time: "2026-03-26T10:00:00.000Z",
      type: "wet",
      amount: "middels",
      note: "Litt raudt utslett",
      diaperDomainId: did,
    }),
  ]);

  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    søvn: (ingen)
    bleier: 10:00 wet middels "Litt raudt utslett""
  `);

  // Pin: note is queryable from API
  const diapers = await (await get("/api/diapers?limit=50")).json();
  const entry = diapers.find((d: { domain_id: string }) => d.domain_id === did);
  expect(entry.note).toBe("Litt raudt utslett");
});

test("B6: diaper note survives update", async () => {
  const babyId = createBaby("Testa");
  const did = generateDiaperId();

  await postEvents([
    makeEvent("diaper.logged", {
      babyId,
      time: "2026-03-26T10:00:00.000Z",
      type: "wet",
      note: "Første notat",
      diaperDomainId: did,
    }),
  ]);

  await postEvents([
    makeEvent("diaper.updated", {
      diaperDomainId: did,
      type: "dirty",
      note: "Oppdatert notat",
    }),
  ]);

  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    søvn: (ingen)
    bleier: 10:00 dirty "Oppdatert notat""
  `);

  // Pin: note was updated
  const diapers = await (await get("/api/diapers?limit=50")).json();
  const entry = diapers.find((d: { domain_id: string }) => d.domain_id === did);
  expect(entry.note).toBe("Oppdatert notat");
});
