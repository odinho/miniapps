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

// --- B12: Wakeup time visible in API ---

test("B12: GET /api/wakeups returns day_start entries", async () => {
  const babyId = createBaby("Testa");

  await postEvents([
    makeEvent("day.started", {
      babyId,
      wakeTime: "2026-03-26T06:10:00.000Z",
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
    søvn: 18:30–06:00 natt
    bleier: (ingen)"
  `);

  // API should derive todayWakeUp from the night sleep end
  const state = await (await get("/api/state")).json();
  expect(state.todayWakeUp.wake_time).toBe(nightEnd);
});

test("Explicit day.started takes precedence over derived wakeup", async () => {
  const babyId = createBaby("Testa");
  const did = generateSleepId();
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  await postEvents([
    makeEvent("sleep.started", { babyId, startTime: `${yesterday}T18:30:00.000Z`, type: "night", sleepDomainId: did }),
  ]);
  await postEvents([
    makeEvent("sleep.ended", { sleepDomainId: did, endTime: `${today}T05:50:00.000Z` }),
  ]);
  await postEvents([
    makeEvent("day.started", { babyId, wakeTime: `${today}T06:10:00.000Z` }),
  ]);

  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    vekketid: 06:10
    søvn: 18:30–05:50 natt
    bleier: (ingen)"
  `);

  const state = await (await get("/api/state")).json();
  expect(state.todayWakeUp.wake_time).toBe(`${today}T06:10:00.000Z`);
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
