import { describe, it, expect } from "bun:test";
import { todayInTz } from "$lib/tz.js";

describe("todayInTz", () => {
  it("computes midnight in Europe/Oslo for a normal winter day (CET = UTC+1)", () => {
    // 2026-01-15 10:00 UTC = 11:00 Oslo
    const nowMs = new Date("2026-01-15T10:00:00Z").getTime();
    const r = todayInTz("Europe/Oslo", nowMs);
    expect(r.dateStr).toBe("2026-01-15");
    expect(r.midnightIso).toBe("2026-01-14T23:00:00.000Z");
  });

  it("computes midnight in Europe/Oslo for a summer day (CEST = UTC+2)", () => {
    // 2026-07-15 10:00 UTC = 12:00 Oslo
    const nowMs = new Date("2026-07-15T10:00:00Z").getTime();
    const r = todayInTz("Europe/Oslo", nowMs);
    expect(r.dateStr).toBe("2026-07-15");
    expect(r.midnightIso).toBe("2026-07-14T22:00:00.000Z");
  });

  it("DST spring-forward: midnight on transition day stays in pre-DST offset (Codex 2026-05-20)", () => {
    // Europe/Oslo spring-forward 2026: DST starts 2026-03-29 02:00 local
    // (jumps to 03:00). Midnight 2026-03-29 in Oslo is still CET (+1h).
    // So midnightIso must be 2026-03-28T23:00:00Z, NOT 22:00:00Z.
    //
    // Sample "now" at 10:00 UTC = 12:00 Oslo (CEST, +2h is now active).
    // The buggy code computed offset at "now" (+2h) and produced 22:00:00Z.
    const nowMs = new Date("2026-03-29T10:00:00Z").getTime();
    const r = todayInTz("Europe/Oslo", nowMs);
    expect(r.dateStr).toBe("2026-03-29");
    expect(r.midnightIso).toBe("2026-03-28T23:00:00.000Z");
  });

  it("DST fall-back: midnight on transition day stays in pre-fallback offset", () => {
    // Europe/Oslo fall-back 2026: DST ends 2026-10-25 03:00 local
    // (drops back to 02:00). Midnight 2026-10-25 is still CEST (+2h).
    const nowMs = new Date("2026-10-25T10:00:00Z").getTime();
    const r = todayInTz("Europe/Oslo", nowMs);
    expect(r.dateStr).toBe("2026-10-25");
    expect(r.midnightIso).toBe("2026-10-24T22:00:00.000Z");
  });

  it("UTC tz returns same date as ISO date prefix", () => {
    const nowMs = new Date("2026-05-20T13:45:00Z").getTime();
    const r = todayInTz("UTC", nowMs);
    expect(r.dateStr).toBe("2026-05-20");
    expect(r.midnightIso).toBe("2026-05-20T00:00:00.000Z");
  });
});
