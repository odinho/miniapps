// Pure SVG arc math — no DOM, no Svelte, fully testable.

export interface ArcConfig {
  arcStartHour: number;
  arcEndHour: number;
}

export function getDayArcConfig(wakeUpTime?: string | null): ArcConfig {
  let arcStartHour = 6;
  if (wakeUpTime) {
    const wake = new Date(wakeUpTime);
    arcStartHour = wake.getHours() + wake.getMinutes() / 60;
  }
  return { arcStartHour, arcEndHour: arcStartHour + 12 };
}

export function getNightArcConfig(): ArcConfig {
  return { arcStartHour: 18, arcEndHour: 30 };
}

function hourOfDay(d: Date): number {
  return d.getHours() + d.getMinutes() / 60;
}

export function timeToArcFraction(d: Date, config: ArcConfig): number {
  let h = hourOfDay(d);
  if (config.arcStartHour >= 18 && h < 12) h += 24;
  const frac = (h - config.arcStartHour) / (config.arcEndHour - config.arcStartHour);
  return Math.max(0, Math.min(1, frac));
}

export function timeToArcFractionRaw(d: Date, config: ArcConfig): number {
  let h = hourOfDay(d);
  if (config.arcStartHour >= 18 && h < 12) h += 24;
  return (h - config.arcStartHour) / (config.arcEndHour - config.arcStartHour);
}

// 270-degree arc with gap at bottom.
// frac 0 = bottom-left (start), frac 1 = bottom-right (end).
// Sweeps clockwise: bottom-left -> left -> top -> right -> bottom-right.
const ARC_TOTAL_DEG = 270;
const ARC_START_ANGLE_DEG = 225;

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

/** Build bubble list from app state inputs. */
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
          : Date.now())
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
    const predTime = new Date(prediction.nextNap);
    bubbles.push({
      startTime: predTime,
      endTime: new Date(predTime.getTime() + 45 * 60000),
      type: "nap",
      status: "predicted",
    });
  }

  // Show bedtime ghost when no predicted nap bubbles remain
  if (prediction?.bedtime && !hasPredictedNaps) {
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
