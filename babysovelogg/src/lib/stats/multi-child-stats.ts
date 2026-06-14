import { computeAllStats, type ComputedStats } from "$lib/stats-view-utils.js";
import type { SleepEntry, DiaperLogRow } from "$lib/types.js";

/** How /stats presents its children:
 *  - single: one child (or the primary alias) — the legacy view, unchanged.
 *  - twinOverlay: same-age twins share one chart, two colour-coded series.
 *  - siblingTwoUp: mixed-age siblings get stacked per-child panels (age norms
 *    differ, so overlaying a shared norm band would mislead). */
export type StatsMode = "single" | "twinOverlay" | "siblingTwoUp";

export function statsMode(childCount: number, isTwinMode: boolean): StatsMode {
  if (childCount <= 1) return "single";
  return isTwinMode ? "twinOverlay" : "siblingTwoUp";
}

export interface StatsChild {
  id: number;
  name: string;
  timezone?: string;
  birthdate?: string;
}

export interface ChildStats {
  babyId: number;
  name: string;
  stats: ComputedStats;
}

export interface ChildRawData {
  baby: StatsChild;
  sleeps: SleepEntry[];
  diapers: DiaperLogRow[];
}

/** Pure: one ComputedStats per child from already-fetched data. Each child is
 *  computed independently (same as the single-baby path) — the shared-domain
 *  overlay scaling happens later, in the chart layer. */
export function computeChildrenStats(inputs: ChildRawData[], now?: number): ChildStats[] {
  return inputs.map((i) => ({
    babyId: i.baby.id,
    name: i.baby.name,
    stats: computeAllStats(i.sleeps, i.diapers, i.baby.timezone, i.baby.birthdate, now),
  }));
}

async function fetchOrThrow(resp: Response, label: string): Promise<unknown> {
  if (!resp.ok) throw new Error(`${label} failed: ${resp.status}`);
  return resp.json();
}

/** Fetch each child's sleeps + diapers, scoped via `?baby=<id>`. `full` switches
 *  between the 44-day window (30 visible + rolling buffer) and all history,
 *  mirroring fetchStatsData / fetchFullHistory. */
export async function fetchChildrenRawData(
  babies: StatsChild[],
  full: boolean,
): Promise<ChildRawData[]> {
  const range = full ? "limit=10000" : `from=${new Date(Date.now() - 44 * 86400000).toISOString()}&limit=500`;
  return Promise.all(
    babies.map(async (baby) => {
      const [sleepRes, diaperRes] = await Promise.all([
        fetch(`/api/sleeps?baby=${baby.id}&${range}`),
        fetch(`/api/diapers?baby=${baby.id}&${range}`),
      ]);
      const [sleeps, diapers] = await Promise.all([
        fetchOrThrow(sleepRes, "/api/sleeps") as Promise<SleepEntry[]>,
        fetchOrThrow(diaperRes, "/api/diapers") as Promise<DiaperLogRow[]>,
      ]);
      return { baby, sleeps, diapers };
    }),
  );
}

/** Convenience: fetch + compute per child in one call. */
export async function fetchChildrenStats(
  babies: StatsChild[],
  full: boolean,
  now?: number,
): Promise<ChildStats[]> {
  return computeChildrenStats(await fetchChildrenRawData(babies, full), now);
}
