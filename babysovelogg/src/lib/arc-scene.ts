// Pure scene composition for the dashboard sleep Arc. Takes the same inputs
// the Arc.svelte component receives and returns a plain ArcScene object that
// describes everything the SVG should paint — no DOM, no Svelte, no Date.now()
// surprises (the clock is an explicit input).
//
// The Svelte component shrinks to "render this object". Geometry rules that
// used to live across half a dozen `$derived` blocks all live here, which is
// also where the 2026-05-17 regressions (duplicate wake-band labels, missing
// active-bubble dot, peach-band-in-night-mode) get pinned by unit tests.
//
// See followups.md → "Arc test coverage" for the four scenarios this exists
// to make testable.

import {
  describeArc,
  fracToPoint,
  getDayArcConfig,
  getNightArcConfig,
  isAtArcEndpoint,
  timeToArcFraction,
  timeToArcFractionRaw,
  collectBubbles,
  type ArcConfig,
} from "./arc-utils.js";
import { formatTime, formatDuration } from "./utils.js";

export interface ArcGeometry {
  size: number;
  cx: number;
  cy: number;
  r: number;
  trackWidth: number;
}

export const DEFAULT_ARC_GEOMETRY: ArcGeometry = {
  size: 320,
  cx: 160,
  cy: 160,
  r: 130,
  trackWidth: 14,
};

export interface ComposeArcInput {
  todaySleeps: Array<{ start_time: string; end_time: string | null; type: "nap" | "night" }>;
  activeSleep: {
    start_time: string;
    type: "nap" | "night";
    isPaused?: boolean;
    pauseTime?: string;
  } | null;
  prediction: {
    nextNap: string;
    bedtime?: string;
    predictedNaps?: Array<{ startTime: string; endTime: string }>;
  } | null;
  isNightMode: boolean;
  now: Date;
  wakeUpTime?: string | null;
  startTimeLabel?: string | null;
  endTimeLabel?: string | null;
  napConfidenceBands?: Array<{ lo: string; hi: string }>;
  activeWakeAt?: string | null;
  activeWakeBand?: { lo: string; hi: string } | null;
  skippedNap?: { plannedAt: string } | null;
  rescueWindow?: { earliest: string; latest: string } | null;
  /** Night-mode start anchor (ISO): bedtime — actual logged start of the
   * current night sleep, or the predicted bedtime when nothing is logged
   * yet. Falls through to a fixed 18:00 default. Day-mode end anchor too:
   * predicted bedtime anchors the right side of the day arc. */
  bedtime?: string | null;
  /** Night-mode end anchor (ISO): expectedNightEnd. Falls through to 06:00. */
  nightEnd?: string | null;
  geometry?: ArcGeometry;
}

type BubbleStatus = "completed" | "active" | "predicted";
type SleepKind = "nap" | "night";
/** Stroke colour token. The component maps this to CSS vars. */
type SceneColor = "moon" | "peach";

interface SceneBubble {
  /** Stable scene key — bubble path d or "dot:cx,cy,r" for the dot variant. */
  d: string;
  /** Same shape as d when this bubble is rendered as a path. Empty for dot variants. */
  tapD: string;
  status: BubbleStatus;
  type: SleepKind;
  color: SceneColor;
  /** Indices propagated from inputs for click handlers. */
  sleepIndex?: number;
  predictionIndex?: number;
  /** When set, render as a circle dot rather than a path. */
  dot: { cx: number; cy: number; r: number } | null;
  /** Visual weight relative to the track stroke width. */
  strokeWidth: number;
  opacity: number;
  dashArray: string | null;
  glow: boolean;
  pulse: boolean;
  label: { x: number; y: number; text: string; opacity: number } | null;
}

interface ScenePoint {
  x: number;
  y: number;
}

interface SceneEndpoint {
  pt: ScenePoint;
  icon: string;
  glow: string;
  label: string | null;
  /**
   * Set when an active sleep is anchored to this endpoint (start endpoint
   * for a sleep that just started near the arc-start, or end endpoint for a
   * sleep ending near the arc-end). The renderer draws a pulsing halo so the
   * endpoint itself communicates "active sleep here" — replacing the old
   * standalone dot anchor that visually collided with the endpoint icon.
   */
  activeHalo: { color: SceneColor } | null;
}

interface SceneNowMarker {
  visible: boolean;
  outer: ScenePoint;
  inner: ScenePoint;
}

interface ScenePlannedTrack {
  visible: boolean;
  d: string;
  color: SceneColor;
  wakeMarker: { x: number; y: number; label: string } | null;
  /**
   * Small filled circle at the outer edge of the bubble at the wake fraction.
   * Replaces the old perpendicular tick which slashed through the bubble and
   * read as a disconnected element. Drawn after bubbles so it stays visible
   * during overrun (when the bubble extends past the wake position).
   */
  wakeDot: { cx: number; cy: number; r: number } | null;
}

interface SceneBand {
  visible: boolean;
  d: string;
  color: SceneColor;
}

interface SceneSkippedBlob {
  visible: boolean;
  d: string;
  label: { x: number; y: number; text: string };
}

interface SceneRescueBlob {
  visible: boolean;
  d: string;
}

interface ArcScene {
  config: ArcConfig;
  geometry: ArcGeometry;
  /** Background track path covering the full arc. */
  trackD: string;
  /** Whether the background track uses night colours. */
  isNight: boolean;
  start: SceneEndpoint;
  end: SceneEndpoint;
  nowMarker: SceneNowMarker;
  bubbles: SceneBubble[];
  /** Confidence bands for predicted nap starts (drawn beneath bubbles). */
  confidenceBands: SceneBand[];
  /** Confidence band around the active sleep's wake estimate. */
  activeWakeBand: SceneBand;
  plannedTrack: ScenePlannedTrack;
  skippedBlob: SceneSkippedBlob | null;
  rescueBlob: SceneRescueBlob | null;
}

/**
 * Visual classification for an active sleep: very-short renders as a dot
 * anchor instead of a thin sliver that disappears next to wake-band paint.
 *
 * 13 min on a 720-min night arc is 0.018 of the arc — invisible. Bumping
 * active sleep up to 0.03 (~22 min on 12-h arcs) ensures the parent can
 * always see *where* the active bubble started.
 */
const VERY_SHORT_THRESHOLD_ACTIVE = 0.03;
const VERY_SHORT_THRESHOLD_OTHER = 0.015;

/**
 * Bubble-to-endpoint proximity for the "active halo" rule. When an active
 * sleep starts within this fraction of the start endpoint (or ends within
 * this much of the end endpoint), we drop the separate bubble dot and
 * instead pulse a halo around the endpoint icon itself. Solves the
 * 2026-05-17 screenshot complaint: a fresh-bedtime active sleep used to
 * paint a tiny dot right next to the moon endpoint, and the rounded line
 * cap visually fused with the endpoint glow into a "weird round-and-line"
 * blob.
 *
 * The threshold is wider than ARC_ENDPOINT_PROXIMITY (used for label
 * dedup) because what triggers the halo is *visual* overlap between the
 * stroke-width-rounded bubble cap and the r=16 endpoint glow — not just
 * label-position duplication.
 */
const HALO_PROXIMITY = 0.05;

function colorForType(t: SleepKind): SceneColor {
  return t === "night" ? "moon" : "peach";
}

/**
 * Compose the full Arc scene from inputs. Pure: same inputs → same scene.
 *
 * All rules that used to live as inline `$derived` blocks in Arc.svelte
 * (very-short dot rendering, endpoint-proximity marker suppression,
 * active-bubble wake-band color, overtime band hiding, etc.) live here so
 * they're unit-testable as object-level assertions on the returned scene.
 */
export function composeArc(input: ComposeArcInput): ArcScene {
  const {
    todaySleeps,
    activeSleep,
    prediction,
    isNightMode,
    now,
    wakeUpTime = null,
    startTimeLabel = null,
    endTimeLabel = null,
    napConfidenceBands = [],
    activeWakeAt = null,
    activeWakeBand = null,
    skippedNap = null,
    rescueWindow = null,
    bedtime = null,
    nightEnd = null,
    geometry = DEFAULT_ARC_GEOMETRY,
  } = input;

  const config = isNightMode
    ? getNightArcConfig(bedtime, nightEnd, now)
    : getDayArcConfig(wakeUpTime, bedtime, now);
  const { cx, cy, r, trackWidth } = geometry;

  const trackD = describeArc(cx, cy, r, 0, 1);
  const startPt = fracToPoint(0, cx, cy, r);
  // End endpoint slides up the arc during overrun: the time window extends
  // to fit `now`, but the icon stays anchored to the *planned* end event
  // (expectedNightEnd / predicted bedtime) so the parent still sees where
  // the plan was. Without an end anchor, frac is 1 (legacy bottom-right).
  const endEventIso = isNightMode ? nightEnd : bedtime;
  const endEventFrac = endEventIso
    ? Math.max(0, Math.min(1, timeToArcFraction(new Date(endEventIso), config)))
    : 1;
  const endPt = fracToPoint(endEventFrac, cx, cy, r);
  const startIcon = isNightMode ? "\u{1F319}" : "\u{2600}\u{FE0F}";
  const endIcon = isNightMode ? "\u{2600}\u{FE0F}" : "\u{1F319}";
  const glow = isNightMode ? "rgba(100, 90, 150, 0.3)" : "rgba(232, 223, 245, 0.6)";

  const nowFracRaw = timeToArcFractionRaw(now, config);
  const nowVisible = nowFracRaw >= 0 && nowFracRaw <= 1;
  const nowFrac = Math.max(0, Math.min(1, nowFracRaw));
  const nowOuter = fracToPoint(nowFrac, cx, cy, r + trackWidth / 2 + 3);
  const nowInner = fracToPoint(nowFrac, cx, cy, r - trackWidth / 2 - 3);

  const rawBubbles = collectBubbles(todaySleeps, activeSleep, prediction, now);
  const bubbles: SceneBubble[] = [];
  let startHalo: SceneEndpoint["activeHalo"] = null;
  let endHalo: SceneEndpoint["activeHalo"] = null;

  for (const bubble of rawBubbles) {
    const startFracRaw = timeToArcFractionRaw(bubble.startTime, config);
    const endFracRaw = bubble.endTime
      ? timeToArcFractionRaw(bubble.endTime, config)
      : timeToArcFractionRaw(now, config);

    if (startFracRaw > 1.05 && endFracRaw > 1.05) continue;
    if (startFracRaw < -0.05 && endFracRaw < -0.05) continue;

    const startFrac = timeToArcFraction(bubble.startTime, config);
    let endFrac = bubble.endTime
      ? timeToArcFraction(bubble.endTime, config)
      : timeToArcFraction(now, config);

    // Sleep is outside this arc's time window (clamping inverted start/end)
    if (endFrac < startFrac) continue;

    const threshold =
      bubble.status === "active" ? VERY_SHORT_THRESHOLD_ACTIVE : VERY_SHORT_THRESHOLD_OTHER;
    const isVeryShort = endFrac - startFrac < threshold;

    // Endpoint-halo rule: a very-short active sleep that hugs either
    // endpoint gets *no* bubble — the endpoint icon itself pulses to
    // signal "active sleep here". Stops the rounded-cap-vs-glow visual
    // collision the 2026-05-17 screenshot reported.
    if (bubble.status === "active" && isVeryShort) {
      if (startFrac < HALO_PROXIMITY) {
        startHalo = { color: colorForType(bubble.type) };
        continue;
      }
      if (endFrac > 1 - HALO_PROXIMITY) {
        endHalo = { color: colorForType(bubble.type) };
        continue;
      }
    }

    if (bubble.status === "active" && isVeryShort) {
      endFrac = Math.min(1, startFrac + 0.015);
    }

    if (Math.abs(endFrac - startFrac) < 0.005) continue;

    const d = describeArc(cx, cy, r, startFrac, endFrac);
    const midFrac = (startFrac + endFrac) / 2;
    const midPt = fracToPoint(midFrac, cx, cy, r + 24);
    const startLabelFrac = Math.min(startFrac + 0.02, midFrac);
    const startLabelPt = fracToPoint(startLabelFrac, cx, cy, r + 24);

    let strokeWidth = trackWidth + 2;
    let opacity = 1;
    let dashArray: string | null = null;
    let glowOn = false;
    let pulseOn = false;

    if (bubble.status === "completed") {
      opacity = 0.9;
    } else if (bubble.status === "active") {
      strokeWidth = trackWidth + 4;
      glowOn = true;
      pulseOn = true;
    } else {
      dashArray = "6 4";
      opacity = 0.5;
    }

    let label: SceneBubble["label"] = null;
    if (bubble.status === "completed" && bubble.endTime) {
      const durationMs = bubble.endTime.getTime() - bubble.startTime.getTime();
      if (durationMs > 10 * 60000) {
        label = { x: midPt.x, y: midPt.y, text: formatDuration(durationMs), opacity: 1 };
      }
    } else if (bubble.status === "active") {
      const elapsed = now.getTime() - bubble.startTime.getTime();
      const startTimeStr = formatTime(bubble.startTime);
      // Suppress when the start label duplicates the start-endpoint label
      // (night-mode active sleep that starts at bedtime endpoint).
      const duplicatesEndpoint = startTimeLabel === startTimeStr;
      if (elapsed > 3 * 60000 && !duplicatesEndpoint) {
        label = {
          x: startLabelPt.x,
          y: startLabelPt.y,
          text: startTimeStr,
          opacity: 0.8,
        };
      }
    } else if (bubble.status === "predicted") {
      label = {
        x: startLabelPt.x,
        y: startLabelPt.y,
        text: formatTime(bubble.startTime),
        opacity: 0.6,
      };
    }

    let dot: SceneBubble["dot"] = null;
    let tapD = d;
    if (bubble.status === "active" && isVeryShort) {
      const dotPt = fracToPoint(startFrac, cx, cy, r);
      dot = { cx: dotPt.x, cy: dotPt.y, r: strokeWidth / 2 };
      tapD = "";
    }

    bubbles.push({
      d: dot ? `dot:${dot.cx.toFixed(2)},${dot.cy.toFixed(2)},${dot.r.toFixed(2)}` : d,
      tapD,
      status: bubble.status,
      type: bubble.type,
      color: colorForType(bubble.type),
      sleepIndex: bubble.sleepIndex,
      predictionIndex: bubble.predictionIndex,
      dot,
      strokeWidth,
      opacity,
      dashArray,
      glow: glowOn,
      pulse: pulseOn,
      label,
    });
  }

  const confidenceBands: SceneBand[] = napConfidenceBands.map((band) => {
    const hiMs = new Date(band.hi).getTime();
    if (hiMs < now.getTime()) return { visible: false, d: "", color: "peach" };
    const loFrac = timeToArcFraction(new Date(band.lo), config);
    const hiFrac = timeToArcFraction(new Date(band.hi), config);
    if (hiFrac <= loFrac || hiFrac - loFrac < 0.005) {
      return { visible: false, d: "", color: "peach" };
    }
    return { visible: true, d: describeArc(cx, cy, r, loFrac, hiFrac), color: "peach" };
  });

  // Active wake band: same colour family as the active sleep. Stays
  // visible past `band.hi` so the parent can see whether now is inside or
  // outside the expected wake window during overrun. The 2026-05-17 wrong-
  // colour bug (peach band on a night arc) is still guarded by sourcing
  // colour from `activeSleep.type`.
  let activeWakeBandOut: SceneBand = { visible: false, d: "", color: "peach" };
  if (activeSleep && activeWakeBand) {
    const loFrac = timeToArcFraction(new Date(activeWakeBand.lo), config);
    const hiFrac = timeToArcFraction(new Date(activeWakeBand.hi), config);
    if (hiFrac > loFrac && hiFrac - loFrac >= 0.005) {
      activeWakeBandOut = {
        visible: true,
        d: describeArc(cx, cy, r, loFrac, hiFrac),
        color: colorForType(activeSleep.type),
      };
    }
  }

  let plannedTrack: ScenePlannedTrack = {
    visible: false,
    d: "",
    color: "peach",
    wakeMarker: null,
    wakeDot: null,
  };
  if (activeSleep && activeWakeAt) {
    const startFrac = timeToArcFraction(new Date(activeSleep.start_time), config);
    const wakeFracRaw = timeToArcFractionRaw(new Date(activeWakeAt), config);
    const wakeFrac = Math.max(0, Math.min(1, wakeFracRaw));

    if (wakeFrac - startFrac >= 0.005) {
      const wakeLabel = formatTime(new Date(activeWakeAt));
      // Two-gate endpoint check: geometric proximity OR a label match against
      // the endpoint label that's already on the same side. The label match
      // catches the 2026-05-17 case where 05:48:42 fell at frac 0.984 (just
      // inside 1 - 0.015) but formatted to the same "05:49" as the endpoint.
      const wakeAtEndpoint =
        isAtArcEndpoint(wakeFrac) ||
        (wakeFrac > 0.5 && endTimeLabel === wakeLabel) ||
        (wakeFrac < 0.5 && startTimeLabel === wakeLabel);

      // Wake indicator: small filled circle on the bubble's outer edge with
      // the label above. Replaces the old perpendicular tick, which slashed
      // through the bubble and read as a disconnected stick-and-label.
      const dotPt = fracToPoint(wakeFrac, cx, cy, r + trackWidth / 2 + 1);
      const markerPt = fracToPoint(wakeFrac, cx, cy, r + 22);

      plannedTrack = {
        visible: true,
        d: describeArc(cx, cy, r, startFrac, wakeFrac),
        color: colorForType(activeSleep.type),
        wakeMarker: wakeAtEndpoint
          ? null
          : { x: markerPt.x, y: markerPt.y, label: wakeLabel },
        wakeDot: wakeAtEndpoint
          ? null
          : { cx: dotPt.x, cy: dotPt.y, r: 3 },
      };
    }
  }

  let skippedBlob: SceneSkippedBlob | null = null;
  if (skippedNap) {
    const plannedMs = new Date(skippedNap.plannedAt).getTime();
    const loFrac = timeToArcFraction(new Date(plannedMs), config);
    const hiFrac = timeToArcFraction(new Date(plannedMs + 45 * 60_000), config);
    if (hiFrac - loFrac >= 0.005) {
      const d = describeArc(cx, cy, r, loFrac, hiFrac);
      const labelFrac = Math.min(loFrac + 0.02, hiFrac);
      const labelPt = fracToPoint(labelFrac, cx, cy, r + 24);
      skippedBlob = {
        visible: true,
        d,
        label: { x: labelPt.x, y: labelPt.y, text: formatTime(skippedNap.plannedAt) },
      };
    }
  }

  let rescueBlob: SceneRescueBlob | null = null;
  if (rescueWindow) {
    const lo = new Date(rescueWindow.earliest);
    const hi = new Date(rescueWindow.latest);
    if (hi.getTime() >= now.getTime()) {
      const loFrac = timeToArcFraction(lo, config);
      const hiFrac = timeToArcFraction(hi, config);
      if (hiFrac - loFrac >= 0.005) {
        rescueBlob = { visible: true, d: describeArc(cx, cy, r, loFrac, hiFrac) };
      }
    }
  }

  return {
    config,
    geometry,
    trackD,
    isNight: isNightMode,
    start: {
      pt: startPt,
      icon: startIcon,
      glow,
      label: startTimeLabel,
      activeHalo: startHalo,
    },
    end: {
      pt: endPt,
      icon: endIcon,
      glow,
      label: endTimeLabel,
      activeHalo: endHalo,
    },
    nowMarker: { visible: nowVisible, outer: nowOuter, inner: nowInner },
    bubbles,
    confidenceBands,
    activeWakeBand: activeWakeBandOut,
    plannedTrack,
    skippedBlob,
    rescueBlob,
  };
}
