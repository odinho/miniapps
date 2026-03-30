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
// Table 3 -- Night wakings (number per night), infants only
// ---------------------------------------------------------------------------
export const nightWakings = {
  source: "Galland et al. 2012, Table 3",
  unit: "wakings/night",
  description: "Number of parent-reported night wakings per night (infant data only)",
  ageBands: [
    { label: "0-2 months",  ageMonths: [0, 2],   mean: 1.7, lower: 0, upper: 3.4 },
    { label: "3-6 months",  ageMonths: [3, 6],   mean: 0.8, lower: 0, upper: 3.0 },
    { label: "7-11 months", ageMonths: [7, 11],  mean: 1.1, lower: 0, upper: 3.1 },
    { label: "1-2 years",   ageMonths: [12, 24], mean: 0.7, lower: 0, upper: 2.5 },
    { label: "All infants", ageMonths: [0, 23],  mean: 0.8, lower: 0, upper: 2.9, note: "excluding longitudinal duplicates" },
  ],
} as const;

// ---------------------------------------------------------------------------
// Table 3 -- Sleep latency (minutes to fall asleep), infants only
// ---------------------------------------------------------------------------
export const sleepLatency = {
  source: "Galland et al. 2012, Table 3",
  unit: "minutes",
  description: "Time taken to fall asleep (sleep onset latency). Meta-analysis for infants only; individual studies reported 17 min for 3-6 year olds",
  ageBands: [
    { label: "All infants (0-2 years)", ageMonths: [0, 24], mean: 19, lower: 0, upper: 43 },
  ],
  individualStudyValues: [
    { label: "3-4 years", ageMonths: [36, 48], mean: 17, source: "ref 55 (Walker)" },
    { label: "3-5 years", ageMonths: [36, 60], mean: 17.4, source: "ref 38 (Mindell)" },
    { label: "5-6 years", ageMonths: [60, 72], mean: 16, source: "ref 55 (Walker)" },
    { label: "3-12 years", ageMonths: [36, 144], mean: 17, note: "average across individual studies" },
  ],
} as const;

// ---------------------------------------------------------------------------
// Table 3 -- Longest sleep period (hours), infants only
// ---------------------------------------------------------------------------
export const longestSleepPeriod = {
  source: "Galland et al. 2012, Table 3",
  unit: "hours",
  description: "Longest unbroken sleep period overnight (infant data only, 4 studies)",
  ageBands: [
    { label: "0-5 months",  ageMonths: [0, 5],   mean: 5.7, lower: 1.8, upper: 9.6 },
    { label: "6-24 months", ageMonths: [6, 24],  mean: 8.3, lower: 3.0, upper: 13.7 },
    { label: "All infants", ageMonths: [0, 23],  mean: 7.1, lower: 2.3, upper: 11.8 },
  ],
} as const;

// ---------------------------------------------------------------------------
// Table 3 -- Number of daytime naps, infants only
// ---------------------------------------------------------------------------
export const daytimeNaps = {
  source: "Galland et al. 2012, Table 3",
  unit: "naps/day",
  description: "Number of daytime naps per day (infant data only)",
  ageBands: [
    { label: "0-5 months",   ageMonths: [0, 5],   mean: 3.1, lower: 1.2, upper: 5.0 },
    { label: "6-11 months",  ageMonths: [6, 11],  mean: 2.2, lower: 0.9, upper: 3.5 },
    { label: "1-2 years",    ageMonths: [12, 24], mean: 1.2, lower: 0.4, upper: 2.1 },
    { label: "All infants",  ageMonths: [0, 23],  mean: 1.7, lower: 0.6, upper: 2.8, note: "excluding longitudinal duplicates" },
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

// ---------------------------------------------------------------------------
// Summary reference values from the abstract (quick-reference)
// ---------------------------------------------------------------------------
export const summaryReferenceValues = {
  source: "Galland et al. 2012, Abstract",
  sleepDuration: {
    description: "Total sleep duration (mean, range as mean +/- 1.96 SD)",
    infant:          { mean: 12.8, range: [9.7, 15.9], unit: "hours" },
    toddlerPreschool: { mean: 11.9, range: [9.9, 13.8], unit: "hours" },
    child:           { mean: 9.2,  range: [7.6, 10.8], unit: "hours" },
  },
  asianCountryDifference: {
    description: "Children from predominantly Asian countries sleep ~1h less than Caucasian/non-Asian across 0-12 year range",
    differenceMinutes: -59.4,
    pValue: 0.025,
  },
} as const;

// ---------------------------------------------------------------------------
// Developmental rate-of-change data (from Results text)
// ---------------------------------------------------------------------------
export const developmentalRates = {
  source: "Galland et al. 2012, Results section",

  sleepDurationDecline: [
    { period: "1-6 months",   ratePerMonth: -10.5, unit: "min/month" },
    { period: "7-12 months",  ratePerMonth: -5.4,  unit: "min/month" },
    { period: "1-4 years",    ratePerYear: -7.8,   unit: "min/year" },
    { period: "5-12 years",   ratePerYear: -5.9,   unit: "min/year" },
  ],

  nightWakingsDecline: [
    { period: "1-6 months",   ratePerMonth: -0.33, unit: "wakings/month" },
    { period: "7-12 months",  ratePerMonth: -0.04, unit: "wakings/month" },
    { period: "13-24 months", ratePerMonth: -0.01, unit: "wakings/month" },
  ],

  longestSleepPeriodIncrease: [
    { period: "1-6 months",   ratePerMonth: 39,  unit: "min/month" },
    { period: "7-12 months",  ratePerMonth: 9.9, unit: "min/month" },
    { period: "13-24 months", ratePerMonth: 5.1, unit: "min/month" },
  ],

  daytimeNapsDecline: [
    { period: "1-6 months",   ratePerMonth: -0.28, unit: "naps/month" },
    { period: "7-12 months",  ratePerMonth: -0.1,  unit: "naps/month" },
    { period: "13-24 months", ratePerMonth: -0.09, unit: "naps/month" },
  ],
} as const;

// ---------------------------------------------------------------------------
// Convenience: all data as a single export for JSON serialization
// ---------------------------------------------------------------------------
export const galland2012 = {
  citation: {
    authors: "Galland BC, Taylor BJ, Elder DE, Herbison P",
    title: "Normal sleep patterns in infants and children: A systematic review of observational studies",
    journal: "Sleep Medicine Reviews",
    year: 2012,
    volume: 16,
    pages: "213-222",
    doi: "10.1016/j.smrv.2011.06.001",
    studiesIncluded: 34,
    totalParticipants: "~34,000",
    ageRange: "0-12 years",
    dataSource: "Parental report (questionnaires and sleep diaries)",
  },
  sleepDuration,
  nightWakings,
  sleepLatency,
  longestSleepPeriod,
  daytimeNaps,
  summaryReferenceValues,
  developmentalRates,
} as const;
