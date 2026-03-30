import { describe, expect, it } from "bun:test";
import { assessLatency, summarizeLatencyTrend } from "$lib/engine/latency.js";

describe("assessLatency", () => {
  const put = "2026-03-30T12:00:00Z";

  it("< 5 min → overtired", () => {
    const r = assessLatency(put, "2026-03-30T12:03:00Z");
    expect(r.category).toBe("overtired");
    expect(r.latencyMinutes).toBe(3);
  });

  it("5-20 min → good", () => {
    expect(assessLatency(put, "2026-03-30T12:10:00Z").category).toBe("good");
    expect(assessLatency(put, "2026-03-30T12:20:00Z").category).toBe("good");
  });

  it("> 20 min → undertired", () => {
    const r = assessLatency(put, "2026-03-30T12:35:00Z");
    expect(r.category).toBe("undertired");
    expect(r.latencyMinutes).toBe(35);
  });

  it("boundary: exactly 5 min → good", () => {
    expect(assessLatency(put, "2026-03-30T12:05:00Z").category).toBe("good");
  });
});

describe("summarizeLatencyTrend", () => {
  it("returns null when no sleeps have latency data", () => {
    expect(summarizeLatencyTrend([
      { start_time: "2026-03-30T12:00:00Z", fall_asleep_time: null },
    ])).toBeNull();
  });

  it("summarizes trend from multiple sleeps", () => {
    const result = summarizeLatencyTrend([
      { start_time: "2026-03-28T12:00:00Z", fall_asleep_time: "2026-03-28T12:15:00Z" },
      { start_time: "2026-03-29T12:00:00Z", fall_asleep_time: "2026-03-29T12:10:00Z" },
      { start_time: "2026-03-30T12:00:00Z", fall_asleep_time: "2026-03-30T12:12:00Z" },
    ]);

    expect(result).toEqual({ avgMinutes: 12, dominantCategory: "good", count: 3 });
  });

  it("detects overtired trend", () => {
    const result = summarizeLatencyTrend([
      { start_time: "2026-03-28T12:00:00Z", fall_asleep_time: "2026-03-28T12:02:00Z" },
      { start_time: "2026-03-29T12:00:00Z", fall_asleep_time: "2026-03-29T12:03:00Z" },
      { start_time: "2026-03-30T12:00:00Z", fall_asleep_time: "2026-03-30T12:01:00Z" },
    ]);

    expect(result!.dominantCategory).toBe("overtired");
  });
});
