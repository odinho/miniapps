import { formatTime, formatDuration } from "./components.js";

interface SleepBubble {
  startTime: Date;
  endTime: Date | null;
  type: "nap" | "night";
  status: "completed" | "active" | "predicted";
  predictionIndex?: number;
}

interface ArcConfig {
  arcStartHour: number;
  arcEndHour: number;
}

function getDayArcConfig(wakeUpTime?: string | null): ArcConfig {
  let arcStartHour = 6;
  if (wakeUpTime) {
    const wake = new Date(wakeUpTime);
    arcStartHour = wake.getHours() + wake.getMinutes() / 60;
  }
  return { arcStartHour, arcEndHour: arcStartHour + 12 };
}

function getNightArcConfig(): ArcConfig {
  return { arcStartHour: 18, arcEndHour: 30 };
}

function hourOfDay(d: Date): number {
  return d.getHours() + d.getMinutes() / 60;
}

function timeToArcFraction(d: Date, config: ArcConfig): number {
  let h = hourOfDay(d);
  if (config.arcStartHour >= 18 && h < 12) h += 24;
  const frac = (h - config.arcStartHour) / (config.arcEndHour - config.arcStartHour);
  return Math.max(0, Math.min(1, frac));
}

function timeToArcFractionRaw(d: Date, config: ArcConfig): number {
  let h = hourOfDay(d);
  if (config.arcStartHour >= 18 && h < 12) h += 24;
  return (h - config.arcStartHour) / (config.arcEndHour - config.arcStartHour);
}

// 270-degree arc with gap at bottom
// frac 0 = bottom-left (start of period), frac 1 = bottom-right (end of period)
// Arc sweeps clockwise from bottom-left, through left, top, right, to bottom-right
const ARC_TOTAL_DEG = 270;
const _ARC_TOTAL_RAD = (ARC_TOTAL_DEG * Math.PI) / 180;
// Start angle in standard math: 225° (bottom-left)
const ARC_START_ANGLE_DEG = 225;

function fracToPoint(frac: number, cx: number, cy: number, r: number): { x: number; y: number } {
  // Go clockwise from 225° by frac * 270°
  // In standard math coords, clockwise = decreasing angle
  const angleDeg = ARC_START_ANGLE_DEG - frac * ARC_TOTAL_DEG;
  const angleRad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(angleRad), y: cy - r * Math.sin(angleRad) };
}

function describeArc(
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
  // sweep-flag=1 for clockwise in SVG (y-down) coordinates
  return `M ${p1.x} ${p1.y} A ${r} ${r} 0 ${largeArc} 1 ${p2.x} ${p2.y}`;
}

export interface ArcInput {
  todaySleeps: Array<{ start_time: string; end_time: string | null; type: "nap" | "night" }>;
  activeSleep: { start_time: string; type: "nap" | "night" } | null;
  prediction: {
    nextNap: string;
    bedtime?: string;
    predictedNaps?: Array<{ startTime: string; endTime: string }>;
  } | null;
  isNightMode: boolean;
  wakeUpTime?: string | null;
  startTimeLabel?: string | null;
  endTimeLabel?: string | null;
  onStartClick?: () => void;
  onEndClick?: () => void;
  onSleepClick?: (index: number) => void;
  onPredictedNapClick?: (index: number) => void;
}

export function renderArc(input: ArcInput): SVGElement {
  const config = input.isNightMode ? getNightArcConfig() : getDayArcConfig(input.wakeUpTime);
  const S = 320;
  const cx = S / 2,
    cy = S / 2,
    r = 130;
  const trackWidth = 14;

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${S} ${S}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("class", "sleep-arc");

  // Defs - glow filter
  const defs = document.createElementNS(ns, "defs");
  const filter = document.createElementNS(ns, "filter");
  filter.setAttribute("id", "arc-glow");
  filter.setAttribute("x", "-50%");
  filter.setAttribute("y", "-50%");
  filter.setAttribute("width", "200%");
  filter.setAttribute("height", "200%");
  const blur = document.createElementNS(ns, "feGaussianBlur");
  blur.setAttribute("stdDeviation", "4");
  blur.setAttribute("result", "glow");
  filter.appendChild(blur);
  const merge = document.createElementNS(ns, "feMerge");
  const mn1 = document.createElementNS(ns, "feMergeNode");
  mn1.setAttribute("in", "glow");
  const mn2 = document.createElementNS(ns, "feMergeNode");
  mn2.setAttribute("in", "SourceGraphic");
  merge.appendChild(mn1);
  merge.appendChild(mn2);
  filter.appendChild(merge);
  defs.appendChild(filter);
  svg.appendChild(defs);

  // Background track
  const trackPath = document.createElementNS(ns, "path");
  trackPath.setAttribute("d", describeArc(cx, cy, r, 0, 1));
  trackPath.setAttribute("fill", "none");
  const isNight = document.documentElement.getAttribute("data-theme") === "night";
  trackPath.setAttribute("stroke", isNight ? "rgba(120, 110, 170, 0.3)" : "var(--lavender-dark)");
  trackPath.setAttribute("stroke-width", String(trackWidth));
  trackPath.setAttribute("stroke-linecap", "round");
  svg.appendChild(trackPath);

  // Clickable endpoint icons at the arc gap
  const startPt = fracToPoint(0, cx, cy, r);
  const endPt = fracToPoint(1, cx, cy, r);
  const startIcon = isNight ? "🌙" : "☀️";
  const endIcon = isNight ? "☀️" : "🌙";

  for (const [pt, icon, handler, timeLabel] of [
    [startPt, startIcon, input.onStartClick, input.startTimeLabel],
    [endPt, endIcon, input.onEndClick, input.endTimeLabel],
  ] as [{ x: number; y: number }, string, (() => void) | undefined, string | null | undefined][]) {
    const g = document.createElementNS(ns, "g");
    g.setAttribute("class", "arc-endpoint-icon");
    // Glow circle behind icon
    const glow = document.createElementNS(ns, "circle");
    glow.setAttribute("cx", String(pt.x));
    glow.setAttribute("cy", String(pt.y));
    glow.setAttribute("r", "16");
    glow.setAttribute("fill", isNight ? "rgba(100, 90, 150, 0.3)" : "rgba(232, 223, 245, 0.6)");
    g.appendChild(glow);
    // Icon text
    const txt = document.createElementNS(ns, "text");
    txt.setAttribute("x", String(pt.x));
    txt.setAttribute("y", String(pt.y + 1));
    txt.setAttribute("font-size", "18");
    txt.setAttribute("text-anchor", "middle");
    txt.setAttribute("dominant-baseline", "middle");
    txt.textContent = icon;
    g.appendChild(txt);
    // Time label below icon
    if (timeLabel) {
      const timeTxt = document.createElementNS(ns, "text");
      timeTxt.setAttribute("x", String(pt.x));
      timeTxt.setAttribute("y", String(pt.y + 18));
      timeTxt.setAttribute("font-size", "9");
      timeTxt.setAttribute("text-anchor", "middle");
      timeTxt.setAttribute("fill", "var(--text-light)");
      timeTxt.setAttribute("font-family", "var(--font)");
      timeTxt.textContent = timeLabel;
      g.appendChild(timeTxt);
    }
    // Transparent tap target
    const tap = document.createElementNS(ns, "circle");
    tap.setAttribute("cx", String(pt.x));
    tap.setAttribute("cy", String(pt.y));
    tap.setAttribute("r", "24");
    tap.setAttribute("fill", "transparent");
    tap.setAttribute("style", "cursor:pointer");
    if (handler) tap.addEventListener("click", handler);
    g.appendChild(tap);
    svg.appendChild(g);
  }

  // Current time indicator
  const nowFracRaw = timeToArcFractionRaw(new Date(), config);
  if (nowFracRaw >= 0 && nowFracRaw <= 1) {
    const nowFrac = Math.max(0, Math.min(1, nowFracRaw));
    const nowOuter = fracToPoint(nowFrac, cx, cy, r + trackWidth / 2 + 3);
    const nowInner = fracToPoint(nowFrac, cx, cy, r - trackWidth / 2 - 3);
    const marker = document.createElementNS(ns, "line");
    marker.setAttribute("x1", String(nowOuter.x));
    marker.setAttribute("y1", String(nowOuter.y));
    marker.setAttribute("x2", String(nowInner.x));
    marker.setAttribute("y2", String(nowInner.y));
    marker.setAttribute("stroke", "var(--sun)");
    marker.setAttribute("stroke-width", "3");
    marker.setAttribute("stroke-linecap", "round");
    svg.appendChild(marker);
  }

  // Collect bubbles
  const bubbles: (SleepBubble & { sleepIndex?: number })[] = [];

  for (let si = 0; si < input.todaySleeps.length; si++) {
    const s = input.todaySleeps[si];
    if (input.activeSleep && !s.end_time) continue;
    if (!s.end_time) continue;
    bubbles.push({
      startTime: new Date(s.start_time),
      endTime: new Date(s.end_time),
      type: s.type as "nap" | "night",
      status: "completed",
      sleepIndex: si,
    });
  }

  if (input.activeSleep) {
    bubbles.push({
      startTime: new Date(input.activeSleep.start_time),
      endTime: null,
      type: input.activeSleep.type as "nap" | "night",
      status: "active",
    });
  }

  if (input.prediction?.predictedNaps && !input.activeSleep) {
    input.prediction.predictedNaps.forEach((pred, idx) => {
      bubbles.push({
        startTime: new Date(pred.startTime),
        endTime: new Date(pred.endTime),
        type: "nap",
        status: "predicted",
        predictionIndex: idx,
      });
    });
  } else if (input.prediction?.nextNap && !input.activeSleep) {
    const predTime = new Date(input.prediction.nextNap);
    bubbles.push({
      startTime: predTime,
      endTime: new Date(predTime.getTime() + 45 * 60000),
      type: "nap",
      status: "predicted",
    });
  }

  // Render bubbles as arc segments
  for (const bubble of bubbles) {
    const startFracRaw = timeToArcFractionRaw(bubble.startTime, config);
    const endFracRaw = bubble.endTime
      ? timeToArcFractionRaw(bubble.endTime, config)
      : timeToArcFractionRaw(new Date(), config);

    if (startFracRaw > 1.05 && endFracRaw > 1.05) continue;
    if (startFracRaw < -0.05 && endFracRaw < -0.05) continue;

    const startFrac = timeToArcFraction(bubble.startTime, config);
    let endFrac = bubble.endTime
      ? timeToArcFraction(bubble.endTime, config)
      : timeToArcFraction(new Date(), config);

    // Active bubbles always get a minimum visual size so they're visible immediately
    if (bubble.status === "active" && endFrac - startFrac < 0.015) {
      endFrac = Math.min(1, startFrac + 0.015);
    }

    if (Math.abs(endFrac - startFrac) < 0.005) continue;

    const g = document.createElementNS(ns, "g");
    g.setAttribute("class", `arc-bubble arc-bubble-${bubble.status}`);

    const segPath = document.createElementNS(ns, "path");
    segPath.setAttribute("d", describeArc(cx, cy, r, startFrac, endFrac));
    segPath.setAttribute("fill", "none");
    segPath.setAttribute("stroke-linecap", "round");

    if (bubble.status === "completed") {
      segPath.setAttribute("stroke", bubble.type === "night" ? "var(--moon)" : "var(--peach-dark)");
      segPath.setAttribute("stroke-width", String(trackWidth + 2));
      segPath.setAttribute("opacity", "0.9");
    } else if (bubble.status === "active") {
      segPath.setAttribute("stroke", bubble.type === "night" ? "var(--moon)" : "var(--peach-dark)");
      segPath.setAttribute("stroke-width", String(trackWidth + 4));
      segPath.setAttribute("filter", "url(#arc-glow)");
      segPath.setAttribute("class", "arc-active-pulse");
    } else {
      segPath.setAttribute("stroke", "var(--moon)");
      segPath.setAttribute("stroke-width", String(trackWidth + 2));
      segPath.setAttribute("stroke-dasharray", "6 4");
      segPath.setAttribute("opacity", "0.35");
    }
    g.appendChild(segPath);

    // Tap target for completed sleep bubbles
    if (bubble.status === "completed" && input.onSleepClick && bubble.sleepIndex != null) {
      const tapPath = document.createElementNS(ns, "path");
      tapPath.setAttribute("d", describeArc(cx, cy, r, startFrac, endFrac));
      tapPath.setAttribute("fill", "none");
      tapPath.setAttribute("stroke", "transparent");
      tapPath.setAttribute("stroke-width", String(trackWidth + 16));
      tapPath.setAttribute("style", "cursor:pointer");
      const idx = bubble.sleepIndex;
      tapPath.addEventListener("click", () => input.onSleepClick!(idx));
      g.appendChild(tapPath);
    }

    // Tap target for predicted nap bubbles
    if (
      bubble.status === "predicted" &&
      input.onPredictedNapClick &&
      bubble.predictionIndex != null
    ) {
      const tapPath = document.createElementNS(ns, "path");
      tapPath.setAttribute("d", describeArc(cx, cy, r, startFrac, endFrac));
      tapPath.setAttribute("fill", "none");
      tapPath.setAttribute("stroke", "transparent");
      tapPath.setAttribute("stroke-width", String(trackWidth + 16));
      tapPath.setAttribute("style", "cursor:pointer");
      const predIdx = bubble.predictionIndex;
      tapPath.addEventListener("click", () => input.onPredictedNapClick!(predIdx));
      g.appendChild(tapPath);
    }

    // Duration/time label outside arc
    const midFrac = (startFrac + endFrac) / 2;
    const labelPt = fracToPoint(midFrac, cx, cy, r + 24);
    if (bubble.status === "completed" && bubble.endTime) {
      const durationMs = bubble.endTime.getTime() - bubble.startTime.getTime();
      if (durationMs > 10 * 60000) {
        const durLabel = document.createElementNS(ns, "text");
        durLabel.setAttribute("x", String(labelPt.x));
        durLabel.setAttribute("y", String(labelPt.y));
        durLabel.setAttribute("text-anchor", "middle");
        durLabel.setAttribute("dominant-baseline", "middle");
        durLabel.setAttribute("fill", "var(--text-light)");
        durLabel.setAttribute("font-size", "9");
        durLabel.textContent = formatDuration(durationMs);
        g.appendChild(durLabel);
      }
    } else if (bubble.status === "predicted") {
      const tLabel = document.createElementNS(ns, "text");
      tLabel.setAttribute("x", String(labelPt.x));
      tLabel.setAttribute("y", String(labelPt.y));
      tLabel.setAttribute("text-anchor", "middle");
      tLabel.setAttribute("dominant-baseline", "middle");
      tLabel.setAttribute("fill", "var(--text-light)");
      tLabel.setAttribute("font-size", "9");
      tLabel.setAttribute("opacity", "0.6");
      tLabel.textContent = formatTime(bubble.startTime);
      g.appendChild(tLabel);
    }

    svg.appendChild(g);
  }

  return svg;
}
