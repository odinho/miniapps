import { describe, it, expect } from "bun:test";
import { composeArc, type ComposeArcInput } from "$lib/arc-scene.js";
import { formatTime } from "$lib/utils.js";

// Build "today" timestamps for a fixed local date. The Arc derives its hour
// of day from getHours(), so all fixtures live in local time on a single day
// (server TZ == baby TZ, per feedback_server_tz).
const TODAY = new Date();
TODAY.setHours(0, 0, 0, 0);
const baseMs = TODAY.getTime();
const at = (h: number, m = 0) =>
  new Date(baseMs + h * 3600_000 + m * 60_000).toISOString();
const atDate = (h: number, m = 0) => new Date(at(h, m));

// Convenience: default input the scenario tests override.
function makeInput(overrides: Partial<ComposeArcInput>): ComposeArcInput {
  return {
    todaySleeps: [],
    activeSleep: null,
    prediction: null,
    isNightMode: false,
    now: atDate(12, 0),
    wakeUpTime: at(7, 0),
    startTimeLabel: "07:00",
    endTimeLabel: "19:00",
    ...overrides,
  };
}

describe("composeArc — active night sleep at +13 min (2026-05-17 regression)", () => {
  // Active night sleep that started 13 min ago. The 13 min is 0.018 of the
  // night arc — too short to render as a path. It also starts right next to
  // the bedtime (start) endpoint icon, where a separate bubble dot used to
  // visually fuse with the endpoint's glow circle. The new "halo" rule:
  //   1. The start endpoint gets a moon-coloured pulsing halo instead of
  //      a near-endpoint dot bubble (no rounded-cap collision).
  //   2. No active bubble appears in the bubbles array — the endpoint is
  //      the indicator.
  //   3. The wake-band uses moon (night) colour, not peach.
  //   4. The plannedTrack marker/dot are suppressed because their label
  //      equals the right-endpoint label — duplicate-label dedup still
  //      holds.
  const wakeIso = at(29, 49); // 05:49 next morning (29 = 18 + 11h49m)
  const startIso = at(18, 30); // bedtime 18:30
  const nowDate = atDate(18, 43); // 13 min into night

  const scene = composeArc({
    todaySleeps: [],
    activeSleep: { start_time: startIso, type: "night" },
    prediction: null,
    isNightMode: true,
    now: nowDate,
    startTimeLabel: "18:30",
    endTimeLabel: "05:49",
    activeWakeAt: wakeIso,
    activeWakeBand: { lo: at(29, 30), hi: at(30, 10) },
  });

  it("anchors the active sleep as a halo on the start endpoint, not a separate bubble", () => {
    expect(scene.bubbles.find((b) => b.status === "active")).toBeUndefined();
    expect(scene.start.activeHalo).not.toBeNull();
    expect(scene.start.activeHalo!.color).toBe("moon");
  });

  it("leaves the end endpoint without a halo (the active sleep is at the start side)", () => {
    expect(scene.end.activeHalo).toBeNull();
  });

  it("paints the wake-band in moon (night) colour, not peach", () => {
    expect(scene.activeWakeBand.visible).toBe(true);
    expect(scene.activeWakeBand.color).toBe("moon");
  });

  it("suppresses the plannedTrack wake-marker + dot when label matches the endpoint label", () => {
    expect(scene.plannedTrack.visible).toBe(true);
    expect(scene.plannedTrack.wakeMarker).toBeNull();
    expect(scene.plannedTrack.wakeDot).toBeNull();
  });
});

describe("composeArc — active nap near the end-endpoint (end-halo)", () => {
  // A short active nap that started right before the end of the day arc.
  // The bubble would otherwise paint a tiny cap fused against the moon
  // endpoint at 19:00 — same visual class of bug as the start-endpoint
  // case, but on the right side. The end endpoint should pulse instead.
  const startIso = at(18, 35);
  const nowDate = atDate(18, 50);

  const scene = composeArc({
    todaySleeps: [],
    activeSleep: { start_time: startIso, type: "nap" },
    prediction: null,
    isNightMode: false,
    now: nowDate,
    wakeUpTime: at(7, 0),
    startTimeLabel: "07:00",
    endTimeLabel: "19:00",
  });

  it("attaches the halo to the end endpoint, not a bubble", () => {
    expect(scene.bubbles.find((b) => b.status === "active")).toBeUndefined();
    expect(scene.end.activeHalo).not.toBeNull();
    expect(scene.end.activeHalo!.color).toBe("peach");
  });

  it("leaves the start endpoint without a halo", () => {
    expect(scene.start.activeHalo).toBeNull();
  });
});

describe("composeArc — active nap mid-cycle", () => {
  // 60 min into a 90-min nap on the day arc. The bubble is long enough to
  // render as a path. The wake-band sits well away from either arc endpoint,
  // so its perpendicular tick + label must be present.
  const startIso = at(12, 30);
  const wakeIso = at(14, 0); // predicted wake mid-day
  const nowDate = atDate(13, 30);

  const scene = composeArc({
    todaySleeps: [],
    activeSleep: { start_time: startIso, type: "nap" },
    prediction: null,
    isNightMode: false,
    now: nowDate,
    wakeUpTime: at(7, 0),
    startTimeLabel: "07:00",
    endTimeLabel: "19:00",
    activeWakeAt: wakeIso,
    activeWakeBand: { lo: at(13, 45), hi: at(14, 15) },
  });

  it("renders the active bubble as a path (not a dot)", () => {
    const active = scene.bubbles.find((b) => b.status === "active");
    expect(active).toBeDefined();
    expect(active!.dot).toBeNull();
    expect(active!.d.startsWith("M ")).toBe(true);
    expect(active!.color).toBe("peach");
  });

  it("paints the wake-band in peach (day) colour", () => {
    expect(scene.activeWakeBand.visible).toBe(true);
    expect(scene.activeWakeBand.color).toBe("peach");
  });

  it("shows the plannedTrack wake-marker + dot (label differs from both endpoints)", () => {
    expect(scene.plannedTrack.visible).toBe(true);
    expect(scene.plannedTrack.wakeMarker).not.toBeNull();
    expect(scene.plannedTrack.wakeDot).not.toBeNull();
    expect(scene.plannedTrack.wakeMarker!.label).toBe(formatTime(new Date(wakeIso)));
  });

  it("leaves both endpoint halos null (active sleep is mid-arc)", () => {
    expect(scene.start.activeHalo).toBeNull();
    expect(scene.end.activeHalo).toBeNull();
  });
});

describe("composeArc — skipped nap independent of rescue window", () => {
  // The two visualisations carry distinct meaning: skippedBlob = a nap that
  // didn't happen; rescueBlob = engine suggestion for a power-nap window.
  // They must compose orthogonally — neither implies the other.

  it("rescue without skip: rescueBlob present, skippedBlob null", () => {
    const scene = composeArc(
      makeInput({
        now: atDate(11, 0),
        rescueWindow: { earliest: at(11, 30), latest: at(12, 30) },
      }),
    );
    expect(scene.rescueBlob?.visible).toBe(true);
    expect(scene.skippedBlob).toBeNull();
  });

  it("skip without rescue: skippedBlob present, rescueBlob null", () => {
    const scene = composeArc(
      makeInput({
        now: atDate(11, 0),
        skippedNap: { plannedAt: at(9, 30) },
      }),
    );
    expect(scene.skippedBlob?.visible).toBe(true);
    expect(scene.rescueBlob).toBeNull();
  });

  it("both present: both bubbles visible at distinct positions on the arc", () => {
    const scene = composeArc(
      makeInput({
        now: atDate(11, 0),
        skippedNap: { plannedAt: at(9, 30) },
        rescueWindow: { earliest: at(11, 30), latest: at(12, 30) },
      }),
    );
    expect(scene.skippedBlob?.visible).toBe(true);
    expect(scene.rescueBlob?.visible).toBe(true);
    expect(scene.skippedBlob!.d).not.toBe(scene.rescueBlob!.d);
  });
});

describe("composeArc — active sleep overruns its predicted wake", () => {
  // Active nap that has run past the predicted wake. The bubble extends to
  // "now" (past wakeFrac). The planned-track wake-tick must still be visible
  // so the parent sees the target they're overrunning. The active wake-band
  // is hidden once now > band.hi (overtime).
  const startIso = at(12, 0);
  const wakeIso = at(13, 0); // predicted wake at 13:00
  const nowDate = atDate(13, 30); // 30 min past predicted wake

  const scene = composeArc({
    todaySleeps: [],
    activeSleep: { start_time: startIso, type: "nap" },
    prediction: null,
    isNightMode: false,
    now: nowDate,
    wakeUpTime: at(7, 0),
    startTimeLabel: "07:00",
    endTimeLabel: "19:00",
    activeWakeAt: wakeIso,
    activeWakeBand: { lo: at(12, 45), hi: at(13, 15) }, // hi is in the past now
  });

  it("planned-track wake-dot is still visible past the predicted wake", () => {
    expect(scene.plannedTrack.visible).toBe(true);
    expect(scene.plannedTrack.wakeDot).not.toBeNull();
    expect(scene.plannedTrack.wakeMarker).not.toBeNull();
  });

  it("active wake-band is hidden (overtime — band.hi is in the past)", () => {
    expect(scene.activeWakeBand.visible).toBe(false);
  });

  it("now-marker is still on the arc (well within day-arc range)", () => {
    expect(scene.nowMarker.visible).toBe(true);
  });
});

describe("composeArc — confidence-band hygiene", () => {
  // Confidence bands for predicted naps are dropped once their `hi` is in
  // the past (the window has closed).
  it("drops bands whose hi is before now", () => {
    const scene = composeArc(
      makeInput({
        now: atDate(13, 0),
        napConfidenceBands: [
          { lo: at(11, 30), hi: at(12, 15) }, // hi is past — should hide
          { lo: at(14, 30), hi: at(15, 15) }, // future — should render
        ],
      }),
    );
    expect(scene.confidenceBands).toHaveLength(2);
    expect(scene.confidenceBands[0].visible).toBe(false);
    expect(scene.confidenceBands[1].visible).toBe(true);
  });
});

describe("composeArc — endpoint label propagation", () => {
  it("propagates start/end labels to the scene endpoints", () => {
    const scene = composeArc(
      makeInput({ startTimeLabel: "06:30", endTimeLabel: "18:30" }),
    );
    expect(scene.start.label).toBe("06:30");
    expect(scene.end.label).toBe("18:30");
  });
});

describe("composeArc — completed sleep label", () => {
  it("labels completed naps over 10 min with their duration", () => {
    const scene = composeArc(
      makeInput({
        now: atDate(13, 0),
        todaySleeps: [
          { start_time: at(9, 0), end_time: at(10, 30), type: "nap" }, // 90m
        ],
      }),
    );
    const done = scene.bubbles.find((b) => b.status === "completed");
    expect(done).toBeDefined();
    expect(done!.label?.text).toBe("1t 30m");
  });

  it("omits the duration label for naps under 10 min", () => {
    const scene = composeArc(
      makeInput({
        now: atDate(13, 0),
        todaySleeps: [
          { start_time: at(9, 0), end_time: at(9, 8), type: "nap" }, // 8m
        ],
      }),
    );
    const done = scene.bubbles.find((b) => b.status === "completed");
    expect(done?.label).toBeNull();
  });
});
