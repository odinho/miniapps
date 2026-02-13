/** Wake window range in minutes [min, max] by age bracket. */
export interface WakeWindowRange {
  minMonths: number;
  maxMonths: number;
  minMinutes: number;
  maxMinutes: number;
}

export const WAKE_WINDOWS: WakeWindowRange[] = [
  { minMonths: 0, maxMonths: 3, minMinutes: 60, maxMinutes: 90 },
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
  { minMonths: 0, maxMonths: 3, naps: 4, range: [3, 5] },
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
  { minMonths: 0, maxMonths: 3, totalHours: 16, range: [14, 17] },
  { minMonths: 3, maxMonths: 6, totalHours: 15, range: [13, 16] },
  { minMonths: 6, maxMonths: 9, totalHours: 14, range: [12, 15] },
  { minMonths: 9, maxMonths: 12, totalHours: 14, range: [12, 15] },
  { minMonths: 12, maxMonths: 18, totalHours: 13.5, range: [12, 14] },
  { minMonths: 18, maxMonths: 24, totalHours: 13, range: [11, 14] },
];

/** Find the matching range for a given age in months. */
export function findByAge<T extends { minMonths: number; maxMonths: number }>(
  ranges: T[],
  ageMonths: number
): T {
  const match = ranges.find((r) => ageMonths >= r.minMonths && ageMonths < r.maxMonths);
  // Fallback to last range if older than defined
  return match ?? ranges[ranges.length - 1];
}
