// Shared chart types. The reusable chart components (TimeSeriesChart /
// SleepTimelineChart) carry their own inline prop types (TsSeries,
// TimelineBlockRender); only the legend is shared here.

export interface LegendItem {
  label: string;
  colorVar: string;
  shape?: "line" | "box" | "dot";
}
