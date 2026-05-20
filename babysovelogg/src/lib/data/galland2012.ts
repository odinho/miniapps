/**
 * Normative sleep reference values from:
 *
 * Galland BC, Taylor BJ, Elder DE, Herbison P.
 * "Normal sleep patterns in infants and children: A systematic review
 *  of observational studies."
 * Sleep Medicine Reviews 16 (2012) 213-222.
 * doi:10.1016/j.smrv.2011.06.001
 *
 * Data extracted from Tables 2 and 3 of the paper.
 * All values are from meta-analyses of questionnaire/diary data
 * across 34 studies (n up to ~34,000 children aged 0-12 years).
 *
 * Range = mean +/- 1.96 SD (i.e. 95% of observations).
 * "Lower limit" and "upper limit" in the paper represent this range.
 */

// ---------------------------------------------------------------------------
// Table 2 -- Sleep duration (hours/24h) by age-band
// ---------------------------------------------------------------------------
export const sleepDuration = {
  source: "Galland et al. 2012, Table 2",
  unit: "hours/24h",
  description: "Total sleep duration over 24 hours by age category",
  ageBands: [
    // --- Infants ---
    { label: "0-2 months",  ageMonths: [0, 2],   mean: 14.6, lower: 9.3,  upper: 20.0 },
    { label: "3 months",    ageMonths: [3, 3],   mean: 13.6, lower: 9.4,  upper: 17.8 },
    { label: "6 months",    ageMonths: [6, 6],   mean: 12.9, lower: 8.8,  upper: 17.0 },
    { label: "9 months",    ageMonths: [9, 9],   mean: 12.6, lower: 9.4,  upper: 15.8 },
    { label: "12 months",   ageMonths: [12, 12], mean: 12.9, lower: 10.1, upper: 15.8 },
    { label: "1-2 years",   ageMonths: [12, 24], mean: 12.6, lower: 10.0, upper: 15.2 },
    { label: "All infants", ageMonths: [0, 23],  mean: 12.7, lower: 9.0,  upper: 16.3, note: "excluding longitudinal duplicates" },

    // --- Toddlers ---
    { label: "2-3 years",     ageMonths: [24, 36],  mean: 12.0, lower: 9.7,  upper: 14.2 },
    { label: "4-5 years",     ageMonths: [48, 60],  mean: 11.5, lower: 9.1,  upper: 13.9 },
    { label: "All toddlers",  ageMonths: [24, 60],  mean: 11.9, lower: 9.9,  upper: 13.8, note: "excluding longitudinal duplicates" },

    // --- Children ---
    { label: "6 years",   ageMonths: [72, 72],   mean: 9.7,  lower: 8.1,  upper: 11.4 },
    { label: "7 years",   ageMonths: [84, 84],   mean: 9.4,  lower: 7.9,  upper: 10.9 },
    { label: "8 years",   ageMonths: [96, 96],   mean: 9.3,  lower: 7.8,  upper: 10.8 },
    { label: "9 years",   ageMonths: [108, 108], mean: 9.3,  lower: 7.8,  upper: 10.8 },
    { label: "10 years",  ageMonths: [120, 120], mean: 9.1,  lower: 7.6,  upper: 10.7 },
    { label: "11 years",  ageMonths: [132, 132], mean: 9.0,  lower: 7.3,  upper: 10.6 },
    { label: "12 years",  ageMonths: [144, 144], mean: 8.9,  lower: 7.3,  upper: 10.4 },
    { label: "All children", ageMonths: [72, 144], mean: 9.2, lower: 7.6,  upper: 10.8, note: "excluding longitudinal duplicates" },
  ],
} as const;

// ---------------------------------------------------------------------------
// Best-fit fractional polynomial regression equations (Figure 4)
// These allow continuous estimation for any age, not just discrete bands.
// ---------------------------------------------------------------------------
export const regressionEquations = {
  source: "Galland et al. 2012, Figure 4",
  description: "Best-fit fractional polynomial equations for age-related trends",

  /**
   * Total sleep duration (hours) as a function of age in years.
   * Applicable range: 0-12 years.
   * R^2 = 0.89
   *
   * Formula: 10.49 - 5.56 * [(age/10)^0.5 - 0.71]
   * where age is in years (e.g. 0.5 = 6 months)
   */
  sleepDurationHours(ageYears: number): number {
    return 10.49 - 5.56 * (Math.pow(ageYears / 10, 0.5) - 0.71);
  },

  /**
   * Number of night wakings as a function of age in months.
   * Applicable range: 0-24 months.
   * R^2 = 0.58
   *
   * Formula: 0.84 + 0.56 * [(age/10)^-0.5 - 1.10]
   * where age is in months
   */
  nightWakingsCount(ageMonths: number): number {
    if (ageMonths <= 0) return 1.7; // use 0-2 month band value
    return 0.84 + 0.56 * (Math.pow(ageMonths / 10, -0.5) - 1.10);
  },

  /**
   * Longest sleep period (hours) as a function of age in months.
   * Applicable range: 0-24 months.
   * R^2 = 0.96
   *
   * Formula: 7.79 + 1.32 * [ln(age/10) + 0.22]
   * where age is in months
   */
  longestSleepPeriodHours(ageMonths: number): number {
    if (ageMonths <= 0) return 5.7; // use 0-5 month band value
    return 7.79 + 1.32 * (Math.log(ageMonths / 10) + 0.22);
  },

  /**
   * Number of daytime naps as a function of age in months.
   * Applicable range: 0-24 months.
   * R^2 = 0.98
   *
   * Formula: 2.02 - [2.19 * ((age/10)^0.5 - 0.99)]
   * where age is in months
   */
  daytimeNapsCount(ageMonths: number): number {
    if (ageMonths <= 0) return 3.1; // use 0-5 month band value
    return 2.02 - 2.19 * (Math.pow(ageMonths / 10, 0.5) - 0.99);
  },
} as const;

