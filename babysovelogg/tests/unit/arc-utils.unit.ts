import { describe, it, expect } from "bun:test";
import {
  getDayArcConfig,
  getNightArcConfig,
  timeToArcFraction,
  timeToArcFractionRaw,
  fracToPoint,
  describeArc,
  collectBubbles,
  isAtArcEndpoint,
  ARC_ENDPOINT_PROXIMITY,
  FALLBACK_GHOST_MIN,
  unionArcConfig,
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
  it("returns 18–30 by default", () => {
    const c = getNightArcConfig();
    expect(c.arcStartHour).toBe(18);
    expect(c.arcEndHour).toBe(30);
  });

  it("anchors to the actual bedtime when supplied", () => {
    // 2026-05-21 bug: bedtime 19:52, end label 06:17, but math used 18→30
    // so a fresh active sleep rendered ~15% up the arc instead of at the
    // moon endpoint. The dynamic-anchor variant fixes this.
    const bt = new Date();
    bt.setHours(19, 52, 0, 0);
    const ne = new Date();
    ne.setHours(6, 17, 0, 0);
    const c = getNightArcConfig(bt.toISOString(), ne.toISOString());
    expect(c.arcStartHour).toBeCloseTo(19 + 52 / 60, 5);
    expect(c.arcEndHour).toBeCloseTo(24 + 6 + 17 / 60, 5);
  });

  it("wraps a pre-noon bedtime (post-midnight) into the 18+ frame", () => {
    // Bedtime that landed past midnight: getHours() returns 0..6 but the
    // arc thinks of it as 24..30. Without wrap the arcEnd <= arcStart
    // guard would kick in.
    const bt = new Date();
    bt.setHours(0, 30, 0, 0); // 00:30
    const ne = new Date();
    ne.setHours(7, 0, 0, 0); // 07:00 next morning
    const c = getNightArcConfig(bt.toISOString(), ne.toISOString());
    expect(c.arcStartHour).toBeCloseTo(24 + 0.5, 5);
    expect(c.arcEndHour).toBeCloseTo(24 + 7, 5);
  });

  it("guards against degenerate windows (nightEnd ≤ bedtime)", () => {
    // Bad data: predicted wake earlier than bedtime. Fall back to a 12h window.
    const bt = new Date();
    bt.setHours(22, 0, 0, 0);
    const ne = new Date();
    ne.setHours(21, 0, 0, 0);
    const c = getNightArcConfig(bt.toISOString(), ne.toISOString());
    expect(c.arcEndHour).toBe(c.arcStartHour + 12);
  });
});

describe("getDayArcConfig with bedtime anchor", () => {
  it("anchors arcEnd to the predicted bedtime", () => {
    const wake = new Date();
    wake.setHours(6, 30, 0, 0);
    const bt = new Date();
    bt.setHours(19, 15, 0, 0);
    const c = getDayArcConfig(wake.toISOString(), bt.toISOString());
    expect(c.arcStartHour).toBeCloseTo(6.5, 5);
    expect(c.arcEndHour).toBeCloseTo(19.25, 5);
  });

  it("ignores a bedtime earlier than wake (bad data)", () => {
    const wake = new Date();
    wake.setHours(7, 0, 0, 0);
    const bt = new Date();
    bt.setHours(5, 0, 0, 0);
    const c = getDayArcConfig(wake.toISOString(), bt.toISOString());
    expect(c.arcEndHour).toBe(c.arcStartHour + 12);
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

  it("inverts daytime nap fractions on night arc (hour-wrap edge case)", () => {
    const config = getNightArcConfig(); // 18–30
    // 10am: h=10 < 12 → wrapped to 34 → frac (34-18)/12 = 1.33 (past arc end)
    const start = new Date("2026-03-27T10:00:00");
    // 1pm: h=13 >= 12 → stays 13 → frac (13-18)/12 = -0.42 (before arc start)
    const end = new Date("2026-03-27T13:00:00");
    const startFrac = timeToArcFractionRaw(start, config);
    const endFrac = timeToArcFractionRaw(end, config);
    // Start > end: inverted — this sleep doesn't belong on the night arc
    expect(startFrac).toBeGreaterThan(1);
    expect(endFrac).toBeLessThan(0);
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
  const NOW = new Date("2026-03-27T12:00:00");

  it("collects completed sleeps", () => {
    const bubbles = collectBubbles(
      [{ start_time: "2026-03-27T09:00:00", end_time: "2026-03-27T10:00:00", type: "nap" }],
      null,
      null,
      NOW,
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
      NOW,
    );
    // The open-ended sleep is skipped, but active is added
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].status).toBe("active");
  });

  it("active sleep has no endTime (renders to `now` in the scene layer)", () => {
    const bubbles = collectBubbles(
      [],
      { start_time: "2026-03-27T09:00:00", type: "nap" },
      null,
      NOW,
    );
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].status).toBe("active");
    expect(bubbles[0].endTime).toBeNull();
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
      NOW,
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
      NOW,
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
      NOW,
    );
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].status).toBe("active");
  });

  it("filters out predicted naps that overlap with an active sleep using the passed-in clock", () => {
    // Active sleep started at 12:00 and is ongoing. Now is 12:30. Predicted
    // naps starting before 12:30 must be dropped — and the filter must use
    // the explicit `now`, not Date.now(). This pins the purity contract.
    const bubbles = collectBubbles(
      [],
      { start_time: "2026-03-27T12:00:00", type: "nap" },
      {
        nextNap: "2026-03-27T12:15:00",
        predictedNaps: [
          { startTime: "2026-03-27T12:15:00", endTime: "2026-03-27T13:00:00" }, // before now → drop
          { startTime: "2026-03-27T15:00:00", endTime: "2026-03-27T15:45:00" }, // after now → keep
        ],
      },
      new Date("2026-03-27T12:30:00"),
    );
    expect(bubbles.filter((b) => b.status === "predicted")).toHaveLength(1);
    expect(bubbles.find((b) => b.status === "predicted")!.startTime).toEqual(
      new Date("2026-03-27T15:00:00"),
    );
  });

  it("emits bedtime ghost when nextNap points to a real future nap distinct from bedtime", () => {
    // Two situations the ghost is meant to surface bedtime in:
    //  - When there ARE predicted nap bubbles, they cover the day — no ghost.
    //  - When there are NO predicted naps and nextNap !== bedtime (e.g. a
    //    next nap was inferred but never reached predictedNaps because it was
    //    after a stale filter), the ghost gives the parent a bedtime anchor.
    const withNaps = collectBubbles([], null, {
      nextNap: "2026-03-27T13:00:00",
      bedtime: "2026-03-27T19:00:00",
      predictedNaps: [
        { startTime: "2026-03-27T13:00:00", endTime: "2026-03-27T13:45:00" },
      ],
    }, NOW);
    expect(withNaps.filter((b) => b.type === "night")).toHaveLength(0);

    const onlyBedtimeFuture = collectBubbles([], null, {
      nextNap: "2026-03-27T13:00:00",
      bedtime: "2026-03-27T19:00:00",
    }, NOW);
    const nightBubbles = onlyBedtimeFuture.filter((b) => b.type === "night");
    expect(nightBubbles).toHaveLength(1);
    expect(nightBubbles[0].status).toBe("predicted");
  });

  it("B5: no bedtime ghost when nextNap === bedtime — moon endpoint is enough", () => {
    // When napsAllDone, the engine collapses nextNap to bedtime. The right
    // moon endpoint already conveys bedtime; emitting an extra 45-min
    // lavender ghost mid-arc just confused parents in playground scenarios
    // (and on late-wake days in prod where bedtime sits inside arc bounds).
    const bubbles = collectBubbles([], null, {
      nextNap: "2026-03-27T18:30:00",
      bedtime: "2026-03-27T18:30:00",
    }, NOW);
    expect(bubbles.filter((b) => b.status === "predicted")).toHaveLength(0);
  });
});

describe("baby-timezone arc math", () => {
  // 05:30 UTC. On 2026-03-27 Oslo is still CET (+1; DST starts 2026-03-29),
  // so this instant is 06:30 in Oslo, 14:30 in Tokyo, 05:30 in UTC. The arc
  // must read the baby's tz, not the browser's. Pre-fix this used
  // Date.getHours() (browser tz) and a travelling family saw a skewed arc.
  const ISO = "2026-03-27T05:30:00Z";

  it("getDayArcConfig derives arcStartHour in the supplied tz", () => {
    expect(getDayArcConfig(ISO, null, undefined, "UTC").arcStartHour).toBeCloseTo(5.5, 5);
    expect(getDayArcConfig(ISO, null, undefined, "Europe/Oslo").arcStartHour).toBeCloseTo(6.5, 5);
    expect(getDayArcConfig(ISO, null, undefined, "Asia/Tokyo").arcStartHour).toBeCloseTo(14.5, 5);
  });

  it("getNightArcConfig derives anchors in the supplied tz (with night-wrap)", () => {
    // Bedtime 19:00 UTC = 20:00 Oslo; nightEnd 05:00 UTC = 06:00 Oslo → 30.
    const c = getNightArcConfig("2026-03-27T19:00:00Z", "2026-03-28T05:00:00Z", undefined, "Europe/Oslo");
    expect(c.arcStartHour).toBeCloseTo(20, 5);
    expect(c.arcEndHour).toBeCloseTo(30, 5);
  });

  it("timeToArcFraction reads tz off the config", () => {
    const c = getDayArcConfig(ISO, null, undefined, "Europe/Oslo"); // start 6.5, end 18.5
    // 12:30 UTC = 13:30 Oslo → (13.5 - 6.5) / 12 = 0.5833…
    const frac = timeToArcFraction(new Date("2026-03-27T12:30:00Z"), c);
    expect(frac).toBeCloseTo((13.5 - 6.5) / 12, 5);
  });

  it("config carries its tz for downstream fraction math", () => {
    expect(getDayArcConfig(ISO, null, undefined, "Europe/Oslo").tz).toBe("Europe/Oslo");
    expect(getNightArcConfig(null, null, undefined, "Asia/Tokyo").tz).toBe("Asia/Tokyo");
  });
});

describe("unionArcConfig — shared twin domain", () => {
  it("spans the widest start→end of both babies", () => {
    // Baby A wakes 06:30 → bed 19:00; Baby B wakes 07:15 → bed 19:45.
    const a = getDayArcConfig("2026-03-27T06:30:00", "2026-03-27T19:00:00");
    const b = getDayArcConfig("2026-03-27T07:15:00", "2026-03-27T19:45:00");
    const u = unionArcConfig(a, b);
    expect(u.arcStartHour).toBe(Math.min(a.arcStartHour, b.arcStartHour));
    expect(u.arcEndHour).toBe(Math.max(a.arcEndHour, b.arcEndHour));
    expect(u.arcStartHour).toBeLessThanOrEqual(a.arcStartHour);
    expect(u.arcStartHour).toBeLessThanOrEqual(b.arcStartHour);
    expect(u.arcEndHour).toBeGreaterThanOrEqual(a.arcEndHour);
    expect(u.arcEndHour).toBeGreaterThanOrEqual(b.arcEndHour);
  });

  it("keeps the shared tz and unions night (wrapped) frames too", () => {
    const a = getNightArcConfig("2026-03-27T19:30:00Z", "2026-03-28T06:00:00Z", undefined, "Europe/Oslo");
    const b = getNightArcConfig("2026-03-27T20:15:00Z", "2026-03-28T05:30:00Z", undefined, "Europe/Oslo");
    const u = unionArcConfig(a, b);
    expect(u.tz).toBe("Europe/Oslo");
    // Earliest bedtime anchors the start, latest wake anchors the end.
    expect(u.arcStartHour).toBe(Math.min(a.arcStartHour, b.arcStartHour));
    expect(u.arcEndHour).toBe(Math.max(a.arcEndHour, b.arcEndHour));
    expect(u.arcEndHour).toBeGreaterThan(24); // still wrapped past midnight
  });
});

describe("collectBubbles — learned-duration ghosts (no invented 45-min blobs)", () => {
  const NOW = new Date("2026-03-27T12:00:00");

  it("sizes the fallback nextNap ghost from learned napDurationMin", () => {
    const bubbles = collectBubbles([], null, { nextNap: "2026-03-27T13:00:00", napDurationMin: 70 }, NOW);
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].endTime!.getTime() - bubbles[0].startTime.getTime()).toBe(70 * 60000);
  });

  it("sizes the bedtime ghost from learned napDurationMin", () => {
    const bubbles = collectBubbles(
      [],
      null,
      { nextNap: "2026-03-27T13:00:00", bedtime: "2026-03-27T19:00:00", napDurationMin: 80 },
      NOW,
    );
    const night = bubbles.filter((b) => b.type === "night");
    expect(night).toHaveLength(1);
    expect(night[0].endTime!.getTime() - night[0].startTime.getTime()).toBe(80 * 60000);
  });

  it("falls back to FALLBACK_GHOST_MIN when napDurationMin is null (cold start)", () => {
    const bubbles = collectBubbles([], null, { nextNap: "2026-03-27T13:00:00", napDurationMin: null }, NOW);
    expect(bubbles[0].endTime!.getTime() - bubbles[0].startTime.getTime()).toBe(FALLBACK_GHOST_MIN * 60000);
  });
});

describe("isAtArcEndpoint — double-label regression guard", () => {
  // This rule has regressed several times: when the planned-track wake time
  // for an active sleep matches the arc end time (night mode: both derive
  // from expectedNightEnd), the standalone wake-marker label paints over
  // the endpoint icon's own label, producing a "06:00 / 06:03" double.
  // The Arc component uses isAtArcEndpoint(wakeFrac) to suppress the marker
  // — these tests pin both the threshold and the boolean.

  it("true at the exact arc endpoints", () => {
    expect(isAtArcEndpoint(0)).toBe(true);
    expect(isAtArcEndpoint(1)).toBe(true);
  });

  it("true within ARC_ENDPOINT_PROXIMITY of either endpoint", () => {
    expect(isAtArcEndpoint(ARC_ENDPOINT_PROXIMITY)).toBe(true);
    expect(isAtArcEndpoint(1 - ARC_ENDPOINT_PROXIMITY)).toBe(true);
    expect(isAtArcEndpoint(ARC_ENDPOINT_PROXIMITY - 0.001)).toBe(true);
    expect(isAtArcEndpoint(1 - ARC_ENDPOINT_PROXIMITY + 0.001)).toBe(true);
  });

  it("false in the middle of the arc", () => {
    expect(isAtArcEndpoint(0.5)).toBe(false);
    expect(isAtArcEndpoint(0.3)).toBe(false);
    expect(isAtArcEndpoint(0.7)).toBe(false);
  });

  it("false just past the proximity threshold", () => {
    expect(isAtArcEndpoint(ARC_ENDPOINT_PROXIMITY + 0.001)).toBe(false);
    expect(isAtArcEndpoint(1 - ARC_ENDPOINT_PROXIMITY - 0.001)).toBe(false);
  });

  it("night-mode wake time at the arc end maps to endpoint (the actual bug)", () => {
    // Active night sleep with expectedNightEnd at 06:00. Night arc spans
    // 18:00 → 06:00 (next day). The wake fraction lands at 1.0 → endpoint.
    const cfg = getNightArcConfig();
    // 06:00 next morning. Use a Date built locally so the fixture is tz-aware.
    const wake = new Date();
    wake.setHours(6, 0, 0, 0);
    const frac = timeToArcFraction(wake, cfg);
    expect(isAtArcEndpoint(frac)).toBe(true);
  });

  it("a nap wake mid-day does NOT collide with arc endpoint", () => {
    // Active nap with expectedNapEnd at 11:00. Day arc spans 06:00 → 18:00.
    // The wake fraction is ~0.42 — well clear of either endpoint.
    const cfg = getDayArcConfig(); // 6 → 18
    const wake = new Date();
    wake.setHours(11, 0, 0, 0);
    const frac = timeToArcFraction(wake, cfg);
    expect(isAtArcEndpoint(frac)).toBe(false);
  });
});
