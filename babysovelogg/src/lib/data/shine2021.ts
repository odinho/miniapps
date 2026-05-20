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

/** Daytime sleep duration (minutes) */
export const daytimeSleepDuration: ShineAgeBand[] = [
  { label: "1 month",  ageMonths: 1,  n: 374, mean: 213.1, sd: 63.5, median: 212.3 },
  { label: "6 months", ageMonths: 6,  n: 323, mean: 142.1, sd: 43.1, median: 140.5 },
  { label: "12 months", ageMonths: 12, n: 301, mean: 128.4, sd: 38.3, median: 125.5 },
  { label: "24 months", ageMonths: 24, n: 260, mean: 123.5, sd: 38.1, median: 120.3 },
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

