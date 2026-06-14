// Shared chart geometry primitives. Pure, framework-free — the home for the
// scales/axes math that the stats charts share, so multi-series (twin overlay)
// can compute ONE x/y domain across children instead of per-builder scales.

/** Time-series chart frame (total-sleep, norms, night-stretch, bedtime, nap-count, wake-scatter). */
export const TS_CHART = {
  W: 360,
  H: 200,
  PAD_L: 40,
  PAD_R: 12,
  PAD_T: 16,
  PAD_B: 32,
} as const;

export function tsPlotW(): number {
  return TS_CHART.W - TS_CHART.PAD_L - TS_CHART.PAD_R;
}
export function tsPlotH(): number {
  return TS_CHART.H - TS_CHART.PAD_T - TS_CHART.PAD_B;
}

/** Map a day index to X within the time-series plot area. */
export function tsX(index: number, total: number): number {
  if (total <= 1) return TS_CHART.PAD_L + tsPlotW() / 2;
  return TS_CHART.PAD_L + (index / (total - 1)) * tsPlotW();
}

/** Rolling average over values; nulls where the window is incomplete. */
export function rollingAvg(values: number[], window: number): (number | null)[] {
  return values.map((_, i) => {
    if (i < window - 1) return null;
    let sum = 0;
    for (let j = i - window + 1; j <= i; j++) sum += values[j];
    return sum / window;
  });
}

/** SVG path from (x, y) points, breaking the line across null y's. */
export function rollingAvgPath(xs: number[], ys: (number | null)[]): string {
  const segments: string[] = [];
  let inSegment = false;
  for (let i = 0; i < xs.length; i++) {
    if (ys[i] == null) {
      inSegment = false;
      continue;
    }
    segments.push(`${inSegment ? "L" : "M"}${xs[i]},${ys[i]}`);
    inSegment = true;
  }
  return segments.join(" ");
}

/** Gantt (24h sleep-timeline) frame. */
export const GANTT = {
  W: 360,
  ROW_H: 20,
  PAD_L: 56,
  PAD_R: 8,
  PAD_T: 24,
  HOUR_START: 0, // 00:00 left edge — night sleep in the middle
} as const;

/** Fractional local hour-of-day (0–24) for an instant in a timezone. */
export function getLocalHourFrac(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return (h % 24) + m / 60;
}
