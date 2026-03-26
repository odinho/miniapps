import { describe, test, expect, beforeEach } from "vitest";
import { get, postCsv, resetDb, createBaby } from "./harness.js";

const NAPPER_CSV = `start,end,category,overallHappiness,babyMoodOnWakeUp,diaperWeight,diaperContent,breastLeftMinutes,breastRightMinutes,amountPumpedLeft,amountPumpedRight,feedingAmount,temperature,bottleFeedingType,comment,createdAt,pauses
2026-01-06T06:00:00.000+01:00,2026-01-06T06:00:00.000+01:00,WOKE_UP,,5,,,,,,,,,,,2026-01-07T12:25:25.998Z,
2026-01-06T09:00:00.000+01:00,2026-01-06T09:45:00.000+01:00,NAP,,5,,,,,,,,,,,2026-01-07T12:27:09.454Z,
2026-01-06T13:15:00.000+01:00,2026-01-06T14:35:00.000+01:00,NAP,,3,,,,,,,,,,,2026-01-07T12:28:38.349Z,
2026-01-06T17:35:00.000+01:00,2026-01-06T17:35:00.000+01:00,SOLIDS,,,,,,,,,,,,,2026-01-07T16:47:54.336Z,
2026-01-06T18:26:00.000+01:00,2026-01-06T18:26:00.000+01:00,BED_TIME,,,,,,,,,,,,With%20Rockit,2026-01-07T12:29:20.408Z,
2026-01-06T22:34:00.000+01:00,2026-01-06T22:50:00.000+01:00,NIGHT_WAKING,,,,,,,,,,,,,2026-01-07T19:50:03.549Z,
2026-01-07T05:46:00.000+01:00,2026-01-07T05:46:00.000+01:00,WOKE_UP,,3,,,,,,,,,,,2026-01-07T12:15:15.500Z,`;

beforeEach(() => resetDb());

describe("POST /api/import/napper", () => {
  test("imports CSV and creates correct sleep + day_start entries", async () => {
    createBaby("Halldis", "2025-10-21");

    const res = await postCsv("/api/import/napper", NAPPER_CSV);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.sleeps).toBeGreaterThanOrEqual(3); // 2 naps + 1 night
    expect(body.dayStarts).toBeGreaterThanOrEqual(1);
    expect(body.skipped).toBeGreaterThanOrEqual(1); // SOLIDS

    // Verify sleeps were created in DB
    const sleepsRes = await get("/api/sleeps?limit=100");
    const sleeps = await sleepsRes.json();
    const naps = sleeps.filter((s: { type: string }) => s.type === "nap");
    const nights = sleeps.filter((s: { type: string }) => s.type === "night");
    expect(naps.length).toBe(2);
    expect(nights.length).toBe(1);

    // Night sleep should span BED_TIME -> WOKE_UP
    const night = nights[0];
    expect(night.start_time).toContain("2026-01-06T17:26"); // 18:26+01:00 -> UTC
    expect(night.end_time).toContain("2026-01-07T04:46"); // 05:46+01:00 -> UTC

    // Night should have a pause from the NIGHT_WAKING
    expect(night.pauses).toHaveLength(1);
  });

  test("returns 404 when no baby exists", async () => {
    const res = await postCsv("/api/import/napper", NAPPER_CSV);
    expect(res.status).toBe(404);
  });
});
