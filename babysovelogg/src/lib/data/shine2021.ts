/**
 * Normative infant sleep data from the SHINE (Sleep Health in Infancy &
 * Early Childhood) study, extracted from public aggregate statistics on
 * the NSRR (National Sleep Research Resource).
 *
 * Primary paper:
 *   Yu X, Quante M, Rueschman M, et al.
 *   "Emergence of racial/ethnic and socioeconomic differences in objectively
 *    measured sleep-wake patterns in early infancy"
 *   Sleep 44(3), 2021. PMID: 33057653
 *
 * Study design:
 *   - 433 singleton full-term infants, Boston area
 *   - Philips Actiwatch 2 worn on ankle, 30-second epochs
 *   - 5-7 continuous days of recording per visit
 *   - Manually scored sleep/wake by trained scorers using diaries + actograms
 *   - 4 visits: ~1, ~6, ~12, ~24 months
 *
 * Data source: https://sleepdata.org/datasets/shine (public variable pages)
 * License: Non-commercial use only
 */

export interface ShineAgeBand {
  label: string;
  ageMonths: number;
  n: number;
  mean: number;
  sd: number;
  median: number;
}

// ---------------------------------------------------------------------------
// Actigraphy-measured sleep
// ---------------------------------------------------------------------------

/** Night sleep duration (minutes) */
export const nightSleepDuration: ShineAgeBand[] = [
  { label: "1 month",  ageMonths: 1,  n: 373, mean: 459.2, sd: 78.9, median: 468.0 },
  { label: "6 months", ageMonths: 6,  n: 322, mean: 525.1, sd: 71.9, median: 533.0 },
  { label: "12 months", ageMonths: 12, n: 301, mean: 537.1, sd: 59.9, median: 543.5 },
  { label: "24 months", ageMonths: 24, n: 261, mean: 537.0, sd: 64.9, median: 546.0 },
];

/** Daytime sleep duration (minutes) */
export const daytimeSleepDuration: ShineAgeBand[] = [
  { label: "1 month",  ageMonths: 1,  n: 374, mean: 213.1, sd: 63.5, median: 212.3 },
  { label: "6 months", ageMonths: 6,  n: 323, mean: 142.1, sd: 43.1, median: 140.5 },
  { label: "12 months", ageMonths: 12, n: 301, mean: 128.4, sd: 38.3, median: 125.5 },
  { label: "24 months", ageMonths: 24, n: 260, mean: 123.5, sd: 38.1, median: 120.3 },
];

/** Total 24-hour sleep (minutes) */
export const totalSleepDuration: ShineAgeBand[] = [
  { label: "1 month",  ageMonths: 1,  n: 371, mean: 681.8, sd: 115.3, median: 686.0 },
  { label: "6 months", ageMonths: 6,  n: 320, mean: 672.5, sd: 70.8,  median: 680.5 },
  { label: "12 months", ageMonths: 12, n: 295, mean: 670.1, sd: 54.0,  median: 671.5 },
  { label: "24 months", ageMonths: 24, n: 258, mean: 663.9, sd: 60.4,  median: 667.8 },
];

/** Longest unbroken night sleep stretch (minutes) */
export const longestNightStretch: ShineAgeBand[] = [
  { label: "1 month",  ageMonths: 1,  n: 373, mean: 285.6, sd: 108.0, median: 267.0 },
  { label: "6 months", ageMonths: 6,  n: 322, mean: 458.9, sd: 101.8, median: 474.5 },
  { label: "12 months", ageMonths: 12, n: 301, mean: 502.8, sd: 82.8,  median: 511.0 },
  { label: "24 months", ageMonths: 24, n: 261, mean: 521.7, sd: 75.2,  median: 534.0 },
];

/** Night wake-after-sleep-onset / WASO (minutes) */
export const nightWASO: ShineAgeBand[] = [
  { label: "1 month",  ageMonths: 1,  n: 373, mean: 43.2, sd: 27.7, median: 36.5 },
  { label: "6 months", ageMonths: 6,  n: 322, mean: 53.5, sd: 21.5, median: 49.0 },
  { label: "12 months", ageMonths: 12, n: 301, mean: 52.6, sd: 17.6, median: 50.0 },
  { label: "24 months", ageMonths: 24, n: 261, mean: 48.4, sd: 15.6, median: 46.5 },
];

/** Number of night wake intervals (actigraphy-detected) */
export const nightWakeIntervals: ShineAgeBand[] = [
  { label: "1 month",  ageMonths: 1,  n: 373, mean: 3.2, sd: 1.7, median: 3.0 },
  { label: "6 months", ageMonths: 6,  n: 322, mean: 1.1, sd: 1.1, median: 0.9 },
  { label: "12 months", ageMonths: 12, n: 301, mean: 0.6, sd: 0.8, median: 0.3 },
  { label: "24 months", ageMonths: 24, n: 261, mean: 0.3, sd: 0.4, median: 0.2 },
];

/** Night sleep efficiency (%) */
export const nightSleepEfficiency: ShineAgeBand[] = [
  { label: "1 month",  ageMonths: 1,  n: 373, mean: 90.0, sd: 5.3, median: 90.8 },
  { label: "6 months", ageMonths: 6,  n: 322, mean: 90.1, sd: 3.8, median: 90.7 },
  { label: "12 months", ageMonths: 12, n: 301, mean: 90.5, sd: 3.1, median: 91.0 },
  { label: "24 months", ageMonths: 24, n: 261, mean: 91.3, sd: 2.6, median: 91.7 },
];

// ---------------------------------------------------------------------------
// Timing (clock hours)
// ---------------------------------------------------------------------------

/** Average bedtime (decimal hours, 24h clock) */
export const avgBedtime: ShineAgeBand[] = [
  { label: "1 month",  ageMonths: 1,  n: 373, mean: 20.1, sd: 0.7, median: 19.9 },
  { label: "6 months", ageMonths: 6,  n: 322, mean: 20.2, sd: 0.9, median: 20.1 },
  { label: "12 months", ageMonths: 12, n: 301, mean: 20.5, sd: 1.0, median: 20.4 },
  { label: "24 months", ageMonths: 24, n: 261, mean: 20.9, sd: 1.0, median: 20.9 },
];

/** Average wake time (decimal hours, 24h clock) */
export const avgWakeTime: ShineAgeBand[] = [
  { label: "1 month",  ageMonths: 1,  n: 373, mean: 7.2, sd: 1.1, median: 7.5 },
  { label: "6 months", ageMonths: 6,  n: 322, mean: 7.0, sd: 1.0, median: 7.1 },
  { label: "12 months", ageMonths: 12, n: 301, mean: 6.9, sd: 0.8, median: 7.0 },
  { label: "24 months", ageMonths: 24, n: 261, mean: 7.1, sd: 1.0, median: 7.3 },
];

// ---------------------------------------------------------------------------
// Parent-reported (diary/questionnaire)
// ---------------------------------------------------------------------------

/** Parent-reported naps per day */
export const parentReportedNaps: ShineAgeBand[] = [
  { label: "1 month",  ageMonths: 1,  n: 398, mean: 4.1, sd: 1.5, median: 4.0 },
  { label: "6 months", ageMonths: 6,  n: 307, mean: 2.8, sd: 0.8, median: 3.0 },
  { label: "12 months", ageMonths: 12, n: 340, mean: 1.8, sd: 0.6, median: 2.0 },
  { label: "24 months", ageMonths: 24, n: 327, mean: 1.0, sd: 0.2, median: 1.0 },
];

/** Parent-reported longest night sleep stretch (hours) */
export const parentReportedLongestNight: ShineAgeBand[] = [
  { label: "1 month",  ageMonths: 1,  n: 398, mean: 3.8, sd: 1.2, median: 3.5 },
  { label: "6 months", ageMonths: 6,  n: 307, mean: 6.8, sd: 2.6, median: 7.0 },
  { label: "12 months", ageMonths: 12, n: 340, mean: 7.9, sd: 2.8, median: 8.0 },
  { label: "24 months", ageMonths: 24, n: 327, mean: 9.1, sd: 2.4, median: 10.0 },
];

// ---------------------------------------------------------------------------
// Convenience export
// ---------------------------------------------------------------------------

export const shine2021 = {
  citation: {
    authors: "Yu X, Quante M, Rueschman M, et al.",
    title: "Emergence of racial/ethnic and socioeconomic differences in objectively measured sleep-wake patterns in early infancy",
    journal: "Sleep",
    year: 2021,
    volume: "44(3)",
    pmid: 33057653,
    studyName: "Rise & SHINE",
    subjects: 433,
    agePoints: [1, 6, 12, 24],
    dataSource: "Actigraphy (Philips Actiwatch 2) + parent diary/questionnaire",
    scoring: "Manual sleep/wake scoring by trained scorers, 30-sec epochs, low threshold (80 counts)",
  },
  nightSleepDuration,
  daytimeSleepDuration,
  totalSleepDuration,
  longestNightStretch,
  nightWASO,
  nightWakeIntervals,
  nightSleepEfficiency,
  avgBedtime,
  avgWakeTime,
  parentReportedNaps,
  parentReportedLongestNight,
} as const;
