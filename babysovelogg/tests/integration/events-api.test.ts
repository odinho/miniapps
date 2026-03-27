import { test, expect } from "vitest";
import {
  get,
  postEvents,
  createBaby,
  setWakeUpTime,
  makeEvent,
  generateSleepId,
  generateDiaperId,
} from "./harness.js";

test("GET /api/events with type filter narrows results", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

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
  setWakeUpTime(babyId);
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
