import { describe, expect, it } from "bun:test";
import { formatTimeWindow } from "$lib/utils.js";

// Local-clock Date constructor — independent of host TZ. The helper itself
// formats via `nb-NO` toLocaleTimeString, which reads the date's local
// hours/minutes, so building dates from local components keeps the
// assertions stable across machines.
function localAt(h: number, m: number): Date {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

describe("formatTimeWindow", () => {
  it("rounds a 10:53 cap to '10:50–11:00'", () => {
    expect(formatTimeWindow(localAt(10, 53))).toBe("10:50–11:00");
  });

  it("rounds 10:59 up across the hour boundary", () => {
    expect(formatTimeWindow(localAt(10, 59))).toBe("10:55–11:05");
  });

  it("keeps an already-on-5-min center", () => {
    expect(formatTimeWindow(localAt(10, 50))).toBe("10:45–10:55");
  });

  it("handles top of the hour", () => {
    expect(formatTimeWindow(localAt(10, 0))).toBe("09:55–10:05");
  });

  it("accepts a custom padding", () => {
    expect(formatTimeWindow(localAt(10, 53), 10)).toBe("10:45–11:05");
  });
});
