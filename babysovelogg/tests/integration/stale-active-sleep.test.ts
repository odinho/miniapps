import { test, expect } from "bun:test";
import {
  postEvents,
  createBaby,
  makeEvent,
  generateSleepId,
  setupHarness,
} from "./harness.js";
import { getState } from "$lib/server/state.js";

setupHarness();

const START = "2026-06-01T20:52:00.000Z";
const startMs = new Date(START).getTime();

async function startOpenNight() {
  const babyId = createBaby("Test");
  const sleepId = generateSleepId();
  await postEvents([
    makeEvent("sleep.started", {
      babyId,
      startTime: START,
      type: "night",
      sleepDomainId: sleepId,
    }),
  ]);
  return sleepId;
}

test("fresh open sleep (<24h) is the active sleep, no stale flag", async () => {
  await startOpenNight();
  const state = getState(startMs + 10 * 60 * 60 * 1000); // 10h in
  expect(state.activeSleep).toBeTruthy();
  expect(state.activeSleep?.start_time).toBe(START);
  expect(state.staleActiveSleep).toBeNull();
});

test("open sleep over 24h is hidden from the engine and flagged 'stale'", async () => {
  const sleepId = await startOpenNight();
  const state = getState(startMs + 30 * 60 * 60 * 1000); // 30h in
  expect(state.activeSleep).toBeUndefined();
  expect(state.staleActiveSleep).toBeTruthy();
  expect(state.staleActiveSleep?.domain_id).toBe(sleepId);
  expect(state.staleActiveSleep?.staleStatus).toBe("stale");
  // Engine no longer treats it as an active night sleep.
  expect(state.prediction?.expectedNightEnd ?? null).toBeNull();
});

test("open sleep over 48h is flagged 'abandoned' (the 466h report)", async () => {
  await startOpenNight();
  const state = getState(startMs + 466 * 60 * 60 * 1000);
  expect(state.activeSleep).toBeUndefined();
  expect(state.staleActiveSleep?.staleStatus).toBe("abandoned");
});

test("ending the sleep clears the stale flag", async () => {
  const sleepId = await startOpenNight();
  await postEvents([
    makeEvent("sleep.updated", {
      sleepDomainId: sleepId,
      endTime: "2026-06-02T06:30:00.000Z",
    }),
  ]);
  const state = getState(startMs + 466 * 60 * 60 * 1000);
  expect(state.staleActiveSleep).toBeNull();
  expect(state.activeSleep).toBeFalsy(); // no open sleep at all
});
