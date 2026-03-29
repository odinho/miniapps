import { test, expect } from "bun:test";
import {
  db,
  post,
  postEvents,
  createBaby,
  setWakeUpTimeUTC,
  makeEvent,
  generateSleepId,
  generateDiaperId,
  setupHarness,
} from "./harness.js";
setupHarness();
import { renderDayState } from "../helpers/render-state.js";

test("sleep.started with sleepDomainId creates row with domain_id set", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTimeUTC(babyId, "2026-03-26", "2026-03-26T07:00:00Z");
  const did = generateSleepId();

  const res = await postEvents([
    makeEvent("sleep.started", { babyId, startTime: "2026-03-26T09:00:00Z", sleepDomainId: did }),
  ]);
  expect(res.ok).toBe(true);

  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    vekketid: 07:00
    søvn: 09:00–pågår lur
    bleier: (ingen)"
  `);
});

test("sleep.ended with sleepDomainId updates the correct row", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTimeUTC(babyId, "2026-03-26", "2026-03-26T07:00:00Z");
  const did = generateSleepId();

  await postEvents([
    makeEvent("sleep.started", { babyId, startTime: "2026-03-26T09:00:00Z", sleepDomainId: did }),
  ]);

  const res = await postEvents([
    makeEvent("sleep.ended", { sleepDomainId: did, endTime: "2026-03-26T10:30:00Z" }),
  ]);
  expect(res.ok).toBe(true);

  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    vekketid: 07:00
    søvn: 09:00–10:30 lur
    bleier: (ingen)"
  `);
});

test("sleep.tagged with sleepDomainId updates the correct row", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTimeUTC(babyId, "2026-03-26", "2026-03-26T07:00:00Z");
  const did = generateSleepId();

  await postEvents([
    makeEvent("sleep.started", { babyId, startTime: "2026-03-26T09:00:00Z", sleepDomainId: did }),
  ]);

  const res = await postEvents([
    makeEvent("sleep.tagged", { sleepDomainId: did, mood: "normal", method: "nursing" }),
  ]);
  expect(res.ok).toBe(true);

  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    vekketid: 07:00
    søvn: 09:00–pågår lur normal nursing
    bleier: (ingen)"
  `);
});

test("sleep.paused / sleep.resumed with sleepDomainId works", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTimeUTC(babyId, "2026-03-26", "2026-03-26T07:00:00Z");
  const did = generateSleepId();

  await postEvents([
    makeEvent("sleep.started", { babyId, startTime: "2026-03-26T09:00:00Z", sleepDomainId: did }),
  ]);

  await postEvents([
    makeEvent("sleep.paused", { sleepDomainId: did, pauseTime: "2026-03-26T09:30:00Z" }),
  ]);

  const res = await postEvents([
    makeEvent("sleep.resumed", { sleepDomainId: did, resumeTime: "2026-03-26T09:35:00Z" }),
  ]);
  expect(res.ok).toBe(true);

  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    vekketid: 07:00
    søvn: 09:00–pågår lur 1 pause (5m)
    bleier: (ingen)"
  `);
});

test("diaper.logged with diaperDomainId creates row with domain_id", async () => {
  const babyId = createBaby("Testa");
  const did = generateDiaperId();

  const res = await postEvents([
    makeEvent("diaper.logged", {
      babyId,
      time: "2026-03-26T11:00:00Z",
      type: "wet",
      diaperDomainId: did,
    }),
  ]);
  expect(res.ok).toBe(true);

  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    søvn: (ingen)
    bleier: 11:00 wet"
  `);
});

test("diaper.deleted with diaperDomainId soft-deletes the correct row", async () => {
  const babyId = createBaby("Testa");
  const did = generateDiaperId();

  await postEvents([
    makeEvent("diaper.logged", {
      babyId,
      time: "2026-03-26T11:00:00Z",
      type: "wet",
      diaperDomainId: did,
    }),
  ]);
  const res = await postEvents([makeEvent("diaper.deleted", { diaperDomainId: did })]);
  expect(res.ok).toBe(true);

  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    søvn: (ingen)
    bleier: (ingen)"
  `);
});

test("Events without sleepDomainId are rejected by validation", async () => {
  const babyId = createBaby("Testa");

  const res = await postEvents([
    makeEvent("sleep.started", { babyId, startTime: new Date().toISOString() }),
  ]);
  expect(res.status).toBe(400);
});

test("rebuildAll produces correct projection state", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTimeUTC(babyId, "2026-03-26", "2026-03-26T07:00:00Z");
  const did1 = generateSleepId();
  const did2 = generateDiaperId();

  await postEvents([
    makeEvent("sleep.started", {
      babyId,
      startTime: "2026-03-26T09:00:00Z",
      sleepDomainId: did1,
    }),
  ]);
  await postEvents([
    makeEvent("sleep.ended", {
      sleepDomainId: did1,
      endTime: "2026-03-26T10:30:00Z",
    }),
  ]);
  await postEvents([
    makeEvent("diaper.logged", {
      babyId,
      time: "2026-03-26T11:00:00Z",
      type: "wet",
      diaperDomainId: did2,
    }),
  ]);

  const rebuildRes = await post("/api/admin/rebuild", {});
  expect(rebuildRes.ok).toBe(true);
  const report = await rebuildRes.json();
  expect(report.success).toBe(true);

  // day_start was inserted directly (not via events), so rebuild drops it
  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    søvn: 09:00–10:30 lur
    bleier: 11:00 wet"
  `);
});
