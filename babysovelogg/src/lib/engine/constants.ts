/** Wake window range in minutes [min, max] by age bracket. */
export interface WakeWindowRange {
  minMonths: number;
  maxMonths: number;
  minMinutes: number;
  maxMinutes: number;
}

export const WAKE_WINDOWS: WakeWindowRange[] = [
  { minMonths: 0, maxMonths: 1, minMinutes: 30, maxMinutes: 60 },
  { minMonths: 1, maxMonths: 2, minMinutes: 45, maxMinutes: 75 },
  { minMonths: 2, maxMonths: 3, minMinutes: 60, maxMinutes: 90 },
  { minMonths: 3, maxMonths: 4, minMinutes: 75, maxMinutes: 120 },
  { minMonths: 4, maxMonths: 6, minMinutes: 105, maxMinutes: 150 },
  { minMonths: 6, maxMonths: 8, minMinutes: 120, maxMinutes: 180 },
  { minMonths: 8, maxMonths: 10, minMinutes: 150, maxMinutes: 210 },
  { minMonths: 10, maxMonths: 12, minMinutes: 180, maxMinutes: 240 },
  { minMonths: 12, maxMonths: 18, minMinutes: 210, maxMinutes: 300 },
  { minMonths: 18, maxMonths: 24, minMinutes: 300, maxMinutes: 360 },
];

/** Age-appropriate number of naps per day. */
export interface NapCountRange {
  minMonths: number;
  maxMonths: number;
  naps: number; // typical count
  range: [number, number]; // [min, max]
}

export const NAP_COUNTS: NapCountRange[] = [
  { minMonths: 0, maxMonths: 2, naps: 6, range: [4, 8] },
  { minMonths: 2, maxMonths: 3, naps: 4, range: [3, 5] },
  { minMonths: 3, maxMonths: 6, naps: 3, range: [3, 4] },
  { minMonths: 6, maxMonths: 9, naps: 2, range: [2, 3] },
  { minMonths: 9, maxMonths: 12, naps: 2, range: [1, 2] },
  { minMonths: 12, maxMonths: 18, naps: 1, range: [1, 2] },
  { minMonths: 18, maxMonths: 24, naps: 1, range: [1, 1] },
];

/** Total sleep needs in hours per 24h. */
export interface SleepNeed {
  minMonths: number;
  maxMonths: number;
  totalHours: number; // typical
  range: [number, number]; // [min, max] hours
}

export const SLEEP_NEEDS: SleepNeed[] = [
  { minMonths: 0, maxMonths: 1, totalHours: 16.5, range: [14, 18] },
  { minMonths: 1, maxMonths: 3, totalHours: 15.5, range: [13, 17] },
  { minMonths: 3, maxMonths: 6, totalHours: 15, range: [13, 16] },
  { minMonths: 6, maxMonths: 9, totalHours: 14, range: [12, 15] },
  { minMonths: 9, maxMonths: 12, totalHours: 14, range: [12, 15] },
  { minMonths: 12, maxMonths: 18, totalHours: 13.5, range: [12, 14] },
  { minMonths: 18, maxMonths: 24, totalHours: 13, range: [11, 14] },
];

/**
 * Trend-anchored nap-budget cap thresholds. Used by `computeNapBudget` to
 * recommend a "wake by" for the day's last nap when today is on pace to
 * exceed the blended 7d/30d trend.
 *
 * Evidence base — see docs/sleep-science-research.md §12:
 *  - Brooks & Lack 2006 / Mednick 2003: N2-only naps restore alertness;
 *    minimum useful adult nap ≈ 10 min consolidated sleep (reaches N2).
 *  - Friedrich 2015: memory benefits demonstrated at 30 min naps in 12mo.
 *  - Lassonde 2016: even missed naps in 2yo compensated by 13% more
 *    night SWA + 25% better sleep efficiency same night — capping a
 *    long nap has modest, fast-correcting cost.
 *  - Nakagawa 2016 / Akacem 2015: long naps demonstrably shorten night
 *    sleep (69 min less night sleep, 38 min later DLMO in napping
 *    toddlers). The cap is evidence-consistent.
 *
 * Floors are *minimum useful* nap durations by age, not targets. The
 * engine never recommends a cap shorter than the age-band floor.
 */
export const NAP_BUDGET = {
  /** Tolerance window (minutes). Overshoot beyond this promotes advisory → firm push. */
  TOLERANCE_MIN: 20,
  /** Lead time for the push notification before wakeBy. */
  FIRM_PUSH_LEAD_MIN: 5,
  /** Min elapsed nap time before emitting a cap (don't propose for a baby that just fell asleep). */
  MIN_ELAPSED_BEFORE_CAP_MIN: 20,
  /** Min recent-data days required for the trend target to be considered stable. */
  MIN_TREND_DAYS: 7,
  /** Stdev/mean above this means recent variance is too high — suppress to avoid bad days driving caps. */
  MAX_STDEV_FRACTION: 0.12,
  /** Blend weights for the trend target: 0.6·avg7d + 0.4·avg30d. */
  BLEND_WEIGHT_7D: 0.6,
  BLEND_WEIGHT_30D: 0.4,
  /** Cycle-boundary nudge window — only nudge wakeBy inward within this. */
  CYCLE_NUDGE_WINDOW_MIN: 10,
  /**
   * Lead time subtracted from the cap so the parent has a minute or two to
   * physically get to the baby before the next cycle starts. Only applied
   * in the established-track mode — for first-contact recommendations the
   * cap aligns to the cycle boundary itself.
   */
  EARLY_WAKE_LEAD_MIN: 5,
  /**
   * When the 7d mean drops at least this many minutes below the 30d mean,
   * we infer the parent has been actively capping naps for ~a week and
   * the engine switches to the tighter "established" mode (sub-cycle cap
   * minus lead time). Picked so it triggers after ~1 week of consistent
   * 20-30 min/day cap savings — exactly the rhythm the user described.
   */
  ESTABLISHED_TRACK_DELTA_MIN: 25,
} as const;

/**
 * Minimum useful nap duration by age. Floors, not targets. Sources cited
 * in the NAP_BUDGET docblock above and in docs/sleep-science-research.md §12.
 * `findByAge` interpolates between bands.
 */
export const NAP_FLOOR_BY_AGE: Array<{ minMonths: number; maxMonths: number; floorMin: number }> = [
  // 0–6mo: N1+N2 reached by ~10-15 min; cycle ~45-50 min. Floor 20 min.
  { minMonths: 0, maxMonths: 6, floorMin: 20 },
  // 6–14mo: Friedrich 2015 shows memory benefits at 30 min in 12mo. Floor 22 min.
  { minMonths: 6, maxMonths: 14, floorMin: 22 },
  // 14–24mo: cycle lengthens (~50-60 min); N3 begins to contribute. Floor 28 min.
  { minMonths: 14, maxMonths: 24, floorMin: 28 },
  // 24mo+: nap SWA declining (Kurth 2016) but transition window. Floor 30 min.
  { minMonths: 24, maxMonths: 999, floorMin: 30 },
];

/** Rescue nap thresholds (based on pediatric sleep consultant consensus + sleep cycle biology). */
export const RESCUE_NAP = {
  /** Absolute floor for short-nap threshold (minutes) — avoids catching micro-naps from low data */
  SHORT_NAP_FLOOR_MIN: 15,
  /** Floor for rescue-nap cap (minutes) — guards against low-data cycle estimates */
  CAP_FLOOR_MIN: 20,
  /** Ceiling for rescue-nap cap (minutes) — past this it's effectively a real nap */
  CAP_CEILING_MIN: 60,
  /** Light-phase window (minutes) each side of cycle boundary — same as timer-state LIGHT_WINDOW */
  LIGHT_WINDOW_MIN: 8,
  /** Minimum pre-bedtime wake window (minutes) — hard floor */
  MIN_PRE_BEDTIME_WAKE: 90,
} as const;

/** Find the matching range for a given age in months. */
export function findByAge<T extends { minMonths: number; maxMonths: number }>(
  ranges: T[],
  ageMonths: number,
): T {
  // Negative ageMonths can leak in from direct callers (tests, scripts) that
  // skip `calculateAgeMonths`'s clamp. Treat them as the youngest bracket
  // rather than falling through to the oldest one.
  if (ageMonths < ranges[0].minMonths) return ranges[0];
  const match = ranges.find((r) => ageMonths >= r.minMonths && ageMonths < r.maxMonths);
  // Fallback to last range if older than defined
  return match ?? ranges[ranges.length - 1];
}
