import { describe, expect, it } from "bun:test";
import {
  classifyActiveSleep,
  STALE_ACTIVE_SLEEP_MS,
  ABANDONED_ACTIVE_SLEEP_MS,
} from "$lib/stale-sleep.js";

const START = "2026-06-01T20:52:00.000Z";
const startMs = new Date(START).getTime();

function openSleep(start = START) {
  return { start_time: start, end_time: null };
}

describe("classifyActiveSleep", () => {
  it("returns null for a fresh open sleep (just started)", () => {
    expect(classifyActiveSleep(openSleep(), startMs + 60_000)).toBeNull();
  });

  it("returns null just under the 24h stale threshold", () => {
    expect(
      classifyActiveSleep(openSleep(), startMs + STALE_ACTIVE_SLEEP_MS - 1),
    ).toBeNull();
  });

  it("returns 'stale' exactly at 24h", () => {
    expect(
      classifyActiveSleep(openSleep(), startMs + STALE_ACTIVE_SLEEP_MS),
    ).toBe("stale");
  });

  it("stays 'stale' between 24h and 48h", () => {
    expect(
      classifyActiveSleep(openSleep(), startMs + 36 * 60 * 60 * 1000),
    ).toBe("stale");
    expect(
      classifyActiveSleep(openSleep(), startMs + ABANDONED_ACTIVE_SLEEP_MS - 1),
    ).toBe("stale");
  });

  it("returns 'abandoned' at 48h and beyond (the 466h report)", () => {
    expect(
      classifyActiveSleep(openSleep(), startMs + ABANDONED_ACTIVE_SLEEP_MS),
    ).toBe("abandoned");
    expect(
      classifyActiveSleep(openSleep(), startMs + 466 * 60 * 60 * 1000),
    ).toBe("abandoned");
  });

  it("returns null for a closed sleep regardless of span", () => {
    const closed = { start_time: START, end_time: "2026-06-21T20:52:00.000Z" };
    expect(classifyActiveSleep(closed, startMs + 466 * 60 * 60 * 1000)).toBeNull();
  });

  it("returns null for null/undefined input", () => {
    expect(classifyActiveSleep(null, startMs)).toBeNull();
    expect(classifyActiveSleep(undefined, startMs)).toBeNull();
  });

  it("returns null for a future-dated start (clock skew)", () => {
    expect(classifyActiveSleep(openSleep(), startMs - 60_000)).toBeNull();
  });
});
