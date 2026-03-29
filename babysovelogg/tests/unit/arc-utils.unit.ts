import { describe, it, expect } from "bun:test";
import {
  getDayArcConfig,
  getNightArcConfig,
  timeToArcFraction,
  timeToArcFractionRaw,
  fracToPoint,
  describeArc,
  collectBubbles,
} from "$lib/arc-utils.js";

describe("getDayArcConfig", () => {
  it("defaults to 6–18 without wakeUpTime", () => {
    const c = getDayArcConfig();
    expect(c.arcStartHour).toBe(6);
    expect(c.arcEndHour).toBe(18);
  });

  it("adjusts start to wake-up hour", () => {
    const c = getDayArcConfig("2026-03-27T07:30:00");
    expect(c.arcStartHour).toBe(7.5);
    expect(c.arcEndHour).toBe(19.5);
  });
});

describe("getNightArcConfig", () => {
  it("returns 18–30", () => {
    const c = getNightArcConfig();
    expect(c.arcStartHour).toBe(18);
    expect(c.arcEndHour).toBe(30);
  });
});

describe("timeToArcFraction", () => {
  it("clamps to 0–1", () => {
    const config = getDayArcConfig();
    // 3am is before the 6am start → clamped to 0
    const d = new Date("2026-03-27T03:00:00");
    expect(timeToArcFraction(d, config)).toBe(0);
  });

  it("returns 0.5 at midpoint", () => {
    const config = getDayArcConfig(); // 6–18
    const d = new Date("2026-03-27T12:00:00");
    expect(timeToArcFraction(d, config)).toBe(0.5);
  });

  it("returns 1 at end", () => {
    const config = getDayArcConfig(); // 6–18
    const d = new Date("2026-03-27T18:00:00");
    expect(timeToArcFraction(d, config)).toBe(1);
  });
});

describe("timeToArcFractionRaw", () => {
  it("can return values outside 0–1", () => {
    const config = getDayArcConfig(); // 6–18
    const d = new Date("2026-03-27T03:00:00");
    expect(timeToArcFractionRaw(d, config)).toBeLessThan(0);
  });

  it("wraps hours for night config when hour < 12", () => {
    const config = getNightArcConfig(); // 18–30
    // 2am should map to 26 → frac (26-18)/12 = 8/12 = 0.667
    const d = new Date("2026-03-27T02:00:00");
    expect(timeToArcFractionRaw(d, config)).toBeCloseTo(8 / 12, 5);
  });
});

describe("fracToPoint", () => {
  it("returns bottom-left at frac 0", () => {
    const p = fracToPoint(0, 160, 160, 130);
    // angle 225° → x = 160 + 130*cos(225°), y = 160 - 130*sin(225°)
    expect(p.x).toBeCloseTo(160 + 130 * Math.cos((225 * Math.PI) / 180), 1);
    expect(p.y).toBeCloseTo(160 - 130 * Math.sin((225 * Math.PI) / 180), 1);
  });

  it("returns top at frac 0.5", () => {
    const p = fracToPoint(0.5, 160, 160, 130);
    // angle 225 - 0.5*270 = 90° → top center
    expect(p.x).toBeCloseTo(160, 1);
    expect(p.y).toBeCloseTo(30, 1);
  });

  it("returns bottom-right at frac 1", () => {
    const p = fracToPoint(1, 160, 160, 130);
    // angle 225 - 270 = -45° → bottom-right
    expect(p.x).toBeCloseTo(160 + 130 * Math.cos((-45 * Math.PI) / 180), 1);
    expect(p.y).toBeCloseTo(160 - 130 * Math.sin((-45 * Math.PI) / 180), 1);
  });
});

describe("describeArc", () => {
  it("returns a valid SVG path string", () => {
    const d = describeArc(160, 160, 130, 0, 0.5);
    expect(d).toMatch(/^M [\d.]+ [\d.]+ A 130 130 0 \d 1 [\d.]+ [\d.]+$/);
  });

  it("uses largeArc=1 for arcs > 180°", () => {
    // 0 to 0.8 → 0.8 * 270 = 216° > 180
    const d = describeArc(160, 160, 130, 0, 0.8);
    expect(d).toContain(" 1 1 ");
  });

  it("uses largeArc=0 for arcs <= 180°", () => {
    // 0 to 0.3 → 0.3 * 270 = 81° < 180
    const d = describeArc(160, 160, 130, 0, 0.3);
    expect(d).toContain(" 0 1 ");
  });
});

describe("collectBubbles", () => {
  it("collects completed sleeps", () => {
    const bubbles = collectBubbles(
      [{ start_time: "2026-03-27T09:00:00", end_time: "2026-03-27T10:00:00", type: "nap" }],
      null,
      null,
    );
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].status).toBe("completed");
    expect(bubbles[0].sleepIndex).toBe(0);
  });

  it("skips open-ended sleeps when activeSleep present", () => {
    const bubbles = collectBubbles(
      [{ start_time: "2026-03-27T09:00:00", end_time: null, type: "nap" }],
      { start_time: "2026-03-27T09:00:00", type: "nap" },
      null,
    );
    // The open-ended sleep is skipped, but active is added
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].status).toBe("active");
  });

  it("collects active sleep with paused time", () => {
    const bubbles = collectBubbles(
      [],
      { start_time: "2026-03-27T09:00:00", type: "nap", isPaused: true, pauseTime: "2026-03-27T09:30:00" },
      null,
    );
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].status).toBe("active");
    expect(bubbles[0].endTime).toEqual(new Date("2026-03-27T09:30:00"));
  });

  it("collects predicted naps when no active sleep", () => {
    const bubbles = collectBubbles(
      [],
      null,
      {
        nextNap: "2026-03-27T13:00:00",
        predictedNaps: [
          { startTime: "2026-03-27T13:00:00", endTime: "2026-03-27T13:45:00" },
          { startTime: "2026-03-27T15:30:00", endTime: "2026-03-27T16:15:00" },
        ],
      },
    );
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0].status).toBe("predicted");
    expect(bubbles[0].predictionIndex).toBe(0);
    expect(bubbles[1].predictionIndex).toBe(1);
  });

  it("falls back to single nextNap when no predictedNaps array", () => {
    const bubbles = collectBubbles(
      [],
      null,
      { nextNap: "2026-03-27T13:00:00" },
    );
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].status).toBe("predicted");
    // Default duration: 45 min
    expect(bubbles[0].endTime!.getTime() - bubbles[0].startTime.getTime()).toBe(45 * 60000);
  });

  it("does not add predictions when active sleep exists", () => {
    const bubbles = collectBubbles(
      [],
      { start_time: "2026-03-27T09:00:00", type: "nap" },
      { nextNap: "2026-03-27T13:00:00" },
    );
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].status).toBe("active");
  });

  it("shows bedtime ghost only when no predicted nap bubbles", () => {
    // With predicted naps: bedtime ghost should NOT appear (avoids double dashed arcs)
    const withNaps = collectBubbles([], null, {
      nextNap: "2026-03-27T13:00:00",
      bedtime: "2026-03-27T19:00:00",
      predictedNaps: [
        { startTime: "2026-03-27T13:00:00", endTime: "2026-03-27T13:45:00" },
      ],
    });
    const nightBubbles = withNaps.filter((b) => b.type === "night");
    expect(nightBubbles).toHaveLength(0);

    // Without predicted naps: bedtime ghost SHOULD appear
    const withoutNaps = collectBubbles([], null, {
      nextNap: "2026-03-27T19:00:00",
      bedtime: "2026-03-27T19:00:00",
    });
    const nightBubbles2 = withoutNaps.filter((b) => b.type === "night");
    expect(nightBubbles2).toHaveLength(1);
    expect(nightBubbles2[0].status).toBe("predicted");
  });
});
