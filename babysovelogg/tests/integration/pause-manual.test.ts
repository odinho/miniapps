import { test, expect } from "bun:test";
import {
  postEvents,
  createBaby,
  makeEvent,
  generateSleepId,
  db,
  setupHarness,
} from "./harness.js";
setupHarness();
import { renderDayState, renderCounts } from "../helpers/render-state.js";

test("sleep.pause_deleted removes a pause by index", async () => {
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

  // Add two pauses
  await postEvents([
    makeEvent("sleep.paused", { sleepDomainId: did, pauseTime: "2026-03-26T09:15:00.000Z" }),
  ]);
  await postEvents([
    makeEvent("sleep.resumed", { sleepDomainId: did, resumeTime: "2026-03-26T09:20:00.000Z" }),
  ]);
  await postEvents([
    makeEvent("sleep.paused", { sleepDomainId: did, pauseTime: "2026-03-26T09:30:00.000Z" }),
  ]);
  await postEvents([
    makeEvent("sleep.resumed", { sleepDomainId: did, resumeTime: "2026-03-26T09:35:00.000Z" }),
  ]);

  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    søvn: 09:00–pågår lur 2 pause (10m)
    bleier: (ingen)"
  `);

  // Delete the first pause (index 0)
  await postEvents([
    makeEvent("sleep.pause_deleted", { sleepDomainId: did, pauseIndex: 0 }),
  ]);

  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    søvn: 09:00–pågår lur 1 pause (5m)
    bleier: (ingen)"
  `);
});

test("sleep.manual creates a complete sleep entry in one event", async () => {
  const babyId = createBaby("Testa");
  const did = generateSleepId();

  await postEvents([
    makeEvent("sleep.manual", {
      babyId,
      startTime: "2026-03-26T09:00:00.000Z",
      endTime: "2026-03-26T10:30:00.000Z",
      type: "nap",
      sleepDomainId: did,
    }),
  ]);

  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    søvn: 09:00–10:30 lur
    bleier: (ingen)"
  `);
  expect(renderCounts(db)).toMatchInlineSnapshot(
    `"events: 2, sleeps: 1, diapers: 0, pauses: 0, dayStarts: 0"`,
  );
});

test("sleep.manual with night type", async () => {
  const babyId = createBaby("Testa");

  await postEvents([
    makeEvent("sleep.manual", {
      babyId,
      startTime: "2026-03-25T19:30:00.000Z",
      endTime: "2026-03-26T06:15:00.000Z",
      type: "night",
      sleepDomainId: generateSleepId(),
    }),
  ]);

  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    søvn: 19:30–06:15 natt
    bleier: (ingen)"
  `);
});
