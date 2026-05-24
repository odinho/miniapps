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

// Legacy pause projection tests have been removed — the sleep_pauses
// table is gone (docs/pause-redesign-2026-05-22.md). Coverage for the
// no-op projections lives in tests/integration/domain-ids.test.ts.
// sleep.manual is exercised here because it still uses the same
// surface area.

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
    `"events: 2, sleeps: 1, diapers: 0, nightWakings: 0"`,
  );
});

test("sleep.manual with night type", async () => {
  const babyId = createBaby("Testa");
  const did = generateSleepId();

  await postEvents([
    makeEvent("sleep.manual", {
      babyId,
      startTime: "2026-03-25T20:00:00.000Z",
      endTime: "2026-03-26T06:30:00.000Z",
      type: "night",
      sleepDomainId: did,
    }),
  ]);

  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    vekketid: 06:30
    søvn: 20:00–06:30 natt
    bleier: (ingen)"
  `);
});
