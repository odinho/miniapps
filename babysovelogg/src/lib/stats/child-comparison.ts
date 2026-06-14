import { formatDuration } from "$lib/utils.js";
import type { ChildStats } from "$lib/stats/multi-child-stats.js";

// Cross-child comparison (P3-3): each child's key sleep metrics side by side,
// plus the divergence between exactly two children. Pure — reads each child's
// already-computed ComputedStats (30-day window).

export interface ComparisonRow {
  label: string;
  /** Formatted value per child, in `children` order. */
  values: string[];
  /** Absolute difference between the two children (empty unless exactly 2). */
  divergence: string;
}

const fmtMin = (n: number) => formatDuration(Math.round(n) * 60_000);
const fmtCount = (n: number) => String(Math.round(n * 10) / 10);

function totalPerDayMin(c: ChildStats): number {
  return c.stats.allStats.avgNapMinutesPerDay + c.stats.allStats.avgNightMinutesPerDay;
}

function longestStretchMin(c: ChildStats): number {
  return c.stats.nightStretches.reduce((max, s) => Math.max(max, s.minutes), 0);
}

export function buildComparisonRows(children: ChildStats[]): ComparisonRow[] {
  if (children.length < 2) return [];

  const metrics: { label: string; value: (c: ChildStats) => number; fmt: (n: number) => string }[] = [
    { label: "Total søvn/dag", value: totalPerDayMin, fmt: fmtMin },
    { label: "Nattesøvn/dag", value: (c) => c.stats.allStats.avgNightMinutesPerDay, fmt: fmtMin },
    { label: "Lurar/dag", value: (c) => c.stats.allStats.avgNapsPerDay, fmt: fmtCount },
    { label: "Lengste nattestrekk", value: longestStretchMin, fmt: fmtMin },
  ];

  return metrics.map((m) => {
    const nums = children.map(m.value);
    return {
      label: m.label,
      values: nums.map(m.fmt),
      divergence: children.length === 2 ? m.fmt(Math.abs(nums[0] - nums[1])) : "",
    };
  });
}
