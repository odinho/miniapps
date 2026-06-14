import { test, expect } from "bun:test";
import {
  get,
  postEvents,
  createBaby,
  makeEvent,
  generateSleepId,
  generateDiaperId,
  setupHarness,
} from "./harness.js";
setupHarness();

test("GET /api/events with type filter narrows results", async () => {
  const babyId = createBaby("Testa");

  await postEvents([
    makeEvent("sleep.started", {
      babyId,
      startTime: new Date().toISOString(),
      sleepDomainId: generateSleepId(),
    }),
  ]);
  await postEvents([
    makeEvent("diaper.logged", {
      babyId,
      time: new Date().toISOString(),
      type: "wet",
      diaperDomainId: generateDiaperId(),
    }),
  ]);

  const res = await get("/api/events?type=diaper.logged&limit=50");
  const data = await res.json();
  expect(data.events.length).toBeGreaterThanOrEqual(1);
  for (const evt of data.events) {
    expect(evt.type).toBe("diaper.logged");
  }
});

test("GET /api/events with domainId filter returns entity events", async () => {
  const babyId = createBaby("Testa");
  const did = generateSleepId();

  await postEvents([
    makeEvent("sleep.started", { babyId, startTime: new Date().toISOString(), sleepDomainId: did }),
  ]);
  await postEvents([makeEvent("sleep.tagged", { sleepDomainId: did, mood: "calm" })]);
  await postEvents([
    makeEvent("diaper.logged", {
      babyId,
      time: new Date().toISOString(),
      type: "wet",
      diaperDomainId: generateDiaperId(),
    }),
  ]);

  const res = await get(`/api/events?domainId=${did}&limit=50`);
  const data = await res.json();
  expect(data.events.length).toBe(2);
  expect(data.events.every((e: Record<string, unknown>) => e.domain_id === did)).toBe(true);
});

test("GET /api/events with pagination returns correct total", async () => {
  const babyId = createBaby("Testa");

  // Create a few events
  await Promise.all(
    Array.from({ length: 5 }, () =>
      postEvents([
        makeEvent("diaper.logged", {
          babyId,
          time: new Date().toISOString(),
          type: "wet",
          diaperDomainId: generateDiaperId(),
        }),
      ]),
    ),
  );

  const res = await get("/api/events?limit=2&offset=0");
  const data = await res.json();
  expect(data.events.length).toBe(2);
  // Total includes baby.created from fixture + 5 diapers
  expect(data.total).toBeGreaterThanOrEqual(6);
});

test("sleep.started persists the synced (overlap-nudge) flag; defaults to 0", async () => {
  const { db } = await import("$lib/server/db.js");
  const babyId = createBaby("Testa");
  const syncedId = generateSleepId();
  const plainId = generateSleepId();

  await postEvents([
    makeEvent("sleep.started", {
      babyId,
      startTime: new Date().toISOString(),
      sleepDomainId: syncedId,
      synced: true,
    }),
    makeEvent("sleep.started", {
      babyId,
      startTime: new Date().toISOString(),
      sleepDomainId: plainId,
    }),
  ]);

  const rows = Object.fromEntries(
    (db.prepare("SELECT domain_id, synced FROM sleep_log").all() as { domain_id: string; synced: number }[]).map(
      (r) => [r.domain_id, r.synced],
    ),
  );
  expect(rows[syncedId]).toBe(1);
  expect(rows[plainId]).toBe(0);
});
