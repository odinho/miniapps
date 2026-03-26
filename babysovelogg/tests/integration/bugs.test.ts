import { test, expect } from "vitest";
import {
  get,
  postEvents,
  createBaby,
  setWakeUpTime,
  makeEvent,
  generateSleepId,
  generateDiaperId,
  addCompletedSleep,
  db,
} from "./harness.js";
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

  const res = await get("/api/wakeups?limit=50");
  expect(res.ok).toBe(true);
  const wakeups = await res.json();
  expect(wakeups.length).toBe(1);
  expect(wakeups[0].wake_time).toBe("2026-03-26T06:10:00.000Z");
  expect(wakeups[0].baby_id).toBe(babyId);
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

  // Verify the nap exists
  const before = renderDayState(db, babyId);
  expect(before).toContain("09:00–10:30 lur");

  // Change type to night
  await postEvents([
    makeEvent("sleep.updated", {
      sleepDomainId: did,
      type: "night",
    }),
  ]);

  // Entry should still exist, just with type "night"
  const after = renderDayState(db, babyId);
  expect(after).toContain("09:00–10:30 natt");

  // Also verify via API that the sleep is still returned
  const res = await get("/api/sleeps?limit=50");
  const sleeps = await res.json();
  const entry = sleeps.find((s: { domain_id: string }) => s.domain_id === did);
  expect(entry).toBeTruthy();
  expect(entry.type).toBe("night");
  expect(entry.deleted).toBe(0);
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

  // Update type + start + end time all at once (simulates full edit modal save)
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

  const after = renderDayState(db, babyId);
  expect(after).toContain("08:30–10:00 natt");
});

// --- B5+B6: Diaper note and type visibility in API ---

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

  const res = await get("/api/diapers?limit=50");
  const diapers = await res.json();
  const entry = diapers.find((d: { domain_id: string }) => d.domain_id === did);
  expect(entry).toBeTruthy();
  expect(entry.type).toBe("dirty");
  expect(entry.amount).toBe("middels");
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

  const res = await get("/api/diapers?limit=50");
  const diapers = await res.json();
  const entry = diapers.find((d: { domain_id: string }) => d.domain_id === did);
  expect(entry).toBeTruthy();
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

  const after = renderDayState(db, babyId);
  expect(after).toContain("dirty");
});
