/**
 * Strategy selector: decides which prediction strategy to use based on
 * the baby's age and observed sleep patterns.
 *
 * Three strategies:
 * - newborn_guidance:  0–~8 weeks, no schedule structure
 * - emerging_rhythm:   ~6 weeks – ~5 months, transitional
 * - routine_schedule:  5+ months, the existing schedule engine
 */
import type { StrategySignals } from "./features.js";

export type Strategy = "newborn_guidance" | "emerging_rhythm" | "routine_schedule";

/**
 * Select a prediction strategy from computed signals.
 *
 * Initial rules are deliberately simple and age-heavy.
 * Data-quality overrides can promote or demote.
 */
export function selectStrategy(signals: StrategySignals): Strategy {
  // Rule 1: Very young babies → newborn guidance
  if (signals.ageWeeks < 6) {
    return "newborn_guidance";
  }

  // Rule 2: Established babies with enough data → routine schedule
  if (
    signals.ageMonths >= 5
    && signals.completeDays >= 7
    && signals.nightDayRatio > 0.55
  ) {
    return "routine_schedule";
  }

  // Data-quality promotion: early graduation to routine_schedule
  if (
    signals.ageWeeks > 10
    && signals.nightDayRatio > 0.6
    && signals.firstNapConsistency < 30
    && signals.completeDays >= 5
  ) {
    return "routine_schedule";
  }

  // Data-quality demotion: not enough data for routine even if age qualifies
  if (
    signals.ageMonths >= 5
    && (signals.completeDays < 5 || signals.loggingCompleteness < 0.5)
  ) {
    return "emerging_rhythm";
  }

  // Default: emerging rhythm for the transition period
  return "emerging_rhythm";
}
