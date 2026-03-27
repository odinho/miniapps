import { describe, test, expect } from "vitest";
import { db, postCsv, createBaby } from "./harness.js";
import { renderDayState } from "../helpers/render-state.js";

const NAPPER_CSV = `start,end,category,overallHappiness,babyMoodOnWakeUp,diaperWeight,diaperContent,breastLeftMinutes,breastRightMinutes,amountPumpedLeft,amountPumpedRight,feedingAmount,temperature,bottleFeedingType,comment,createdAt,pauses
2026-01-06T06:00:00.000+01:00,2026-01-06T06:00:00.000+01:00,WOKE_UP,,5,,,,,,,,,,,2026-01-07T12:25:25.998Z,
2026-01-06T09:00:00.000+01:00,2026-01-06T09:45:00.000+01:00,NAP,,5,,,,,,,,,,,2026-01-07T12:27:09.454Z,
2026-01-06T13:15:00.000+01:00,2026-01-06T14:35:00.000+01:00,NAP,,3,,,,,,,,,,,2026-01-07T12:28:38.349Z,
2026-01-06T17:35:00.000+01:00,2026-01-06T17:35:00.000+01:00,SOLIDS,,,,,,,,,,,,,2026-01-07T16:47:54.336Z,
2026-01-06T18:26:00.000+01:00,2026-01-06T18:26:00.000+01:00,BED_TIME,,,,,,,,,,,,With%20Rockit,2026-01-07T12:29:20.408Z,
2026-01-06T22:34:00.000+01:00,2026-01-06T22:50:00.000+01:00,NIGHT_WAKING,,,,,,,,,,,,,2026-01-07T19:50:03.549Z,
2026-01-07T05:46:00.000+01:00,2026-01-07T05:46:00.000+01:00,WOKE_UP,,3,,,,,,,,,,,2026-01-07T12:15:15.500Z,`;

describe("POST /api/import/napper", () => {
  test("imports CSV and creates correct sleep + day_start entries", async () => {
    const babyId = createBaby("Halldis", "2025-10-21");

    const res = await postCsv("/api/import/napper", NAPPER_CSV);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.sleeps).toBeGreaterThanOrEqual(3); // 2 naps + 1 night
    expect(body.dayStarts).toBeGreaterThanOrEqual(1);
    expect(body.skipped).toBeGreaterThanOrEqual(1); // SOLIDS

    expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
      "baby: Halldis (2025-10-21)
      vekketid: 04:46
      søvn: 08:00–08:45 lur 5 | 12:15–13:35 lur 3 | 17:26–04:46 natt 1 pause (16m) 3
      bleier: (ingen)"
    `);
  });

  test("returns 404 when no baby exists", async () => {
    const res = await postCsv("/api/import/napper", NAPPER_CSV);
    expect(res.status).toBe(404);
  });
});
