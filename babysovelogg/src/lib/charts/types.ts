// Generic chart model the reusable chart components render. Builders/data-shapers
// produce these (paths from charts/paths.ts, geometry from charts/scales.ts);
// TimeSeriesChart / SleepTimelineChart consume them. Designed for N series so
// twins overlay in one chart — each series carries its own id + colour.

export interface ChartDims {
  W: number;
  H: number;
  PAD_L: number;
  PAD_R: number;
  PAD_T: number;
  PAD_B: number;
}

/** An axis tick / label: `pos` is the pixel coordinate (y for value axis, x for
 *  the date axis), `label` the rendered text. */
export interface AxisTick {
  pos: number;
  label: string;
}

export type SeriesStyle = "line" | "area" | "rolling" | "band" | "step";

/** One rendered series (already projected to an SVG path). `id` is stable
 *  (e.g. a baby id) so colour + legend stay consistent across charts; `colorVar`
 *  is a CSS custom-property token, not a literal colour. */
export interface ChartSeries {
  id: string;
  label?: string;
  colorVar?: string;
  style: SeriesStyle;
  path: string;
  /** Fill/stroke opacity override (translucent area fills). */
  opacity?: number;
}

/** A translucent reference region (e.g. the age-norm band). */
export interface ReferenceBand {
  path: string;
  colorVar?: string;
  opacity?: number;
}

export interface TimeSeriesModel {
  series: ChartSeries[];
  bands?: ReferenceBand[];
  yTicks: AxisTick[];
  xLabels: AxisTick[];
  /** Y pixel positions for horizontal grid lines. */
  gridLines: number[];
}

export interface LegendItem {
  label: string;
  colorVar: string;
  shape?: "line" | "box" | "dot";
}

// ── Sleep timeline (gantt) ─────────────────────────────────────

/** A sleep block on the 24h timeline. `childId`/`colorVar` are set in twin
 *  overlay so two children's blocks stay distinguishable (thin per-child lanes
 *  use `y`); single-baby leaves them undefined. */
export interface TimelineBlock {
  x: number;
  w: number;
  y: number;
  type: "nap" | "night";
  childId?: string;
  colorVar?: string;
}

export interface TimelineRow {
  date: string;
  dateLabel: string;
  y: number;
  blocks: TimelineBlock[];
}

export interface TimelineModel {
  rows: TimelineRow[];
  hourLabels: AxisTick[];
  height: number;
}
