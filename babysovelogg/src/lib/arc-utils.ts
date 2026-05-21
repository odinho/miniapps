// Pure SVG arc math — no DOM, no Svelte, fully testable.

export interface ArcConfig {
  arcStartHour: number;
  arcEndHour: number;
}

// The arc time-fraction math must agree with the labels painted on the
// endpoints — otherwise an active sleep that started at the label time
// renders far up the arc instead of at the endpoint. The 2026-05-21 bug
// report: bedtime 19:52, end label 06:17, but the hardcoded 18→30 night
// window placed the active sleep bubble at frac ≈ 0.156. Both configs
// take ISO anchors so the labels and the math share a single source of
// truth.

export function getDayArcConfig(wakeUpTime?: string | null, bedtime?: string | null): ArcConfig {
  let arcStartHour = 6;
  if (wakeUpTime) {
    const wake = new Date(wakeUpTime);
    arcStartHour = wake.getHours() + wake.getMinutes() / 60;
  }
  let arcEndHour = arcStartHour + 12;
  if (bedtime) {
    const bt = new Date(bedtime);
    const btHour = bt.getHours() + bt.getMinutes() / 60;
    if (btHour > arcStartHour) arcEndHour = btHour;
  }
  return { arcStartHour, arcEndHour };
}

export function getNightArcConfig(
  bedtime?: string | null,
  nightEnd?: string | null,
): ArcConfig {
  let arcStartHour = 18;
  if (bedtime) {
    const bt = new Date(bedtime);
    let h = bt.getHours() + bt.getMinutes() / 60;
    if (h < 12) h += 24;
    arcStartHour = h;
  }
  let arcEndHour = 30;
  if (nightEnd) {
    const ne = new Date(nightEnd);
    let h = ne.getHours() + ne.getMinutes() / 60;
    if (h < 12) h += 24;
    arcEndHour = h;
  }
  if (arcEndHour <= arcStartHour) arcEndHour = arcStartHour + 12;
  return { arcStartHour, arcEndHour };
}

function hourOfDay(d: Date): number {
  return d.getHours() + d.getMinutes() / 60;
}

// Night arcs cross midnight (arcEndHour > 24). For times after midnight,
// hourOfDay() returns 0..6 but the arc thinks of them as 24..30. Wrap when
// the arc itself crosses midnight; the < 12 cutoff distinguishes
// "post-midnight morning" from "before-bedtime evening" (bedtimes never
// happen before noon).
function applyNightWrap(h: number, config: ArcConfig): number {
  if (config.arcEndHour > 24 && h < 12) return h + 24;
  return h;
}

export function timeToArcFraction(d: Date, config: ArcConfig): number {
  const h = applyNightWrap(hourOfDay(d), config);
  const frac = (h - config.arcStartHour) / (config.arcEndHour - config.arcStartHour);
  return Math.max(0, Math.min(1, frac));
}

export function timeToArcFractionRaw(d: Date, config: ArcConfig): number {
  const h = applyNightWrap(hourOfDay(d), config);
  return (h - config.arcStartHour) / (config.arcEndHour - config.arcStartHour);
}

// 270-degree arc with gap at bottom.
// frac 0 = bottom-left (start), frac 1 = bottom-right (end).
// Sweeps clockwise: bottom-left -> left -> top -> right -> bottom-right.
const ARC_TOTAL_DEG = 270;
const ARC_START_ANGLE_DEG = 225;

/**
 * Threshold under which an arc fraction is treated as "on the endpoint".
 * On a 12 h day or 12 h night arc, 0.015 ≈ 11 min — anything within that of
 * either endpoint paints over the endpoint icon's own time label, so any
 * standalone marker label there is redundant and reads as a duplicate.
 *
 * Pinned by `isAtArcEndpoint` regression tests in arc-utils.unit.ts. Lifting
 * it requires re-checking that night-mode active sleep doesn't get a second
 * "06:00 / 06:03" wake-time label crammed against the wake-up sun endpoint.
 */
export const ARC_ENDPOINT_PROXIMITY = 0.015;

/**
 * Is the given fraction effectively on the arc's start or end endpoint?
 * Used by overlay rendering (e.g. the planned-track wake-marker for active
 * sleep) to avoid emitting a duplicate time label on top of the endpoint
 * icon's existing label.
 */
export function isAtArcEndpoint(frac: number): boolean {
  return frac <= ARC_ENDPOINT_PROXIMITY || frac >= 1 - ARC_ENDPOINT_PROXIMITY;
}

export function fracToPoint(
  frac: number,
  cx: number,
  cy: number,
  r: number,
): { x: number; y: number } {
  const angleDeg = ARC_START_ANGLE_DEG - frac * ARC_TOTAL_DEG;
  const angleRad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(angleRad), y: cy - r * Math.sin(angleRad) };
}

export function describeArc(
  cx: number,
  cy: number,
  r: number,
  startFrac: number,
  endFrac: number,
): string {
  const p1 = fracToPoint(startFrac, cx, cy, r);
  const p2 = fracToPoint(endFrac, cx, cy, r);
  const sweepDeg = (endFrac - startFrac) * ARC_TOTAL_DEG;
  const largeArc = sweepDeg > 180 ? 1 : 0;
  return `M ${p1.x} ${p1.y} A ${r} ${r} 0 ${largeArc} 1 ${p2.x} ${p2.y}`;
}

export interface SleepBubble {
  startTime: Date;
  endTime: Date | null;
  type: "nap" | "night";
  status: "completed" | "active" | "predicted";
  sleepIndex?: number;
  predictionIndex?: number;
}

/** Build bubble list from app state inputs.
 *
 * `now` is required to filter predicted naps that overlap with the active
 * sleep — it has to be plumbed in so `composeArc()` stays pure (same inputs
 * → same outputs). Callers that have no clock context can pass `new Date()`.
 */
export function collectBubbles(
  todaySleeps: Array<{ start_time: string; end_time: string | null; type: "nap" | "night" }>,
  activeSleep: {
    start_time: string;
    type: "nap" | "night";
    isPaused?: boolean;
    pauseTime?: string;
  } | null,
  prediction: {
    nextNap: string;
    bedtime?: string;
    predictedNaps?: Array<{ startTime: string; endTime: string }>;
  } | null,
  now: Date,
): SleepBubble[] {
  const bubbles: SleepBubble[] = [];

  for (let si = 0; si < todaySleeps.length; si++) {
    const s = todaySleeps[si];
    if (activeSleep && !s.end_time) continue;
    if (!s.end_time) continue;
    bubbles.push({
      startTime: new Date(s.start_time),
      endTime: new Date(s.end_time),
      type: s.type,
      status: "completed",
      sleepIndex: si,
    });
  }

  if (activeSleep) {
    const activeEndTime =
      activeSleep.isPaused && activeSleep.pauseTime
        ? new Date(activeSleep.pauseTime)
        : null;
    bubbles.push({
      startTime: new Date(activeSleep.start_time),
      endTime: activeEndTime,
      type: activeSleep.type,
      status: "active",
    });
  }

  // Show predicted nap ghosts (skip any that overlap with the active sleep)
  const hasPredictedNaps = prediction?.predictedNaps && prediction.predictedNaps.length > 0;
  if (hasPredictedNaps) {
    const activeEndMs = activeSleep
      ? (activeSleep.isPaused && activeSleep.pauseTime
          ? new Date(activeSleep.pauseTime).getTime()
          : now.getTime())
      : 0;
    prediction!.predictedNaps!.forEach((pred, idx) => {
      // Skip predictions that overlap with the active sleep
      if (activeSleep && new Date(pred.startTime).getTime() < activeEndMs) return;
      bubbles.push({
        startTime: new Date(pred.startTime),
        endTime: new Date(pred.endTime),
        type: "nap",
        status: "predicted",
        predictionIndex: idx,
      });
    });
  } else if (prediction?.nextNap && !activeSleep) {
    // Don't show a nap ghost when nextNap === bedtime (naps all done);
    // the bedtime ghost below handles that case.
    const isBedtime = prediction.bedtime && prediction.nextNap === prediction.bedtime;
    if (!isBedtime) {
      const predTime = new Date(prediction.nextNap);
      bubbles.push({
        startTime: predTime,
        endTime: new Date(predTime.getTime() + 45 * 60000),
        type: "nap",
        status: "predicted",
      });
    }
  }

  // Show bedtime ghost only when the prediction is still pointing at *future*
  // naps but a bedtime is set. When nextNap===bedtime (napsAllDone state) or
  // there's no nextNap at all, the right-side moon endpoint already conveys
  // bedtime; emitting a 45-min lavender ghost mid-arc just adds a mysterious
  // "tiny purple nap" that doesn't represent any real event.
  const bedtimeRedundantWithEndpoint =
    !prediction?.nextNap || prediction.nextNap === prediction.bedtime;
  if (prediction?.bedtime && !hasPredictedNaps && !bedtimeRedundantWithEndpoint) {
    const bedtime = new Date(prediction.bedtime);
    // Don't show bedtime ghost during active night sleep
    if (!(activeSleep && activeSleep.type === "night")) {
      bubbles.push({
        startTime: bedtime,
        endTime: new Date(bedtime.getTime() + 45 * 60000),
        type: "night",
        status: "predicted",
        predictionIndex: 0,
      });
    }
  }

  return bubbles;
}
