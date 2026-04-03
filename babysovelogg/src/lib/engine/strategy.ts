/**
 * Strategy selector: decides which prediction strategy to use based on
 * the baby's age and observed sleep patterns.
 *
 * Three strategies:
 * - newborn_guidance:  0–~8 weeks, no schedule structure
 * - emerging_rhythm:   ~6 weeks – ~5 months, transitional
 * - routine_schedule:  5+ months, the existing schedule engine
 *
 * Hysteresis rules:
 * - Transitions require 3+ consecutive qualifying days (except age-gated newborn)
 * - Default direction: newborn → emerging → schedule
 * - Regression (schedule → emerging) only on 5+ days of sustained disruption
 * - Manual override bypasses all rules
 */
import type { StrategySignals } from "./features.js";

export type Strategy = "newborn_guidance" | "emerging_rhythm" | "routine_schedule";

/** Manual strategy override from settings. null = auto. */
export type StrategyOverride = Strategy | null;

const STRATEGY_ORDER: Record<Strategy, number> = {
  newborn_guidance: 0,
  emerging_rhythm: 1,
  routine_schedule: 2,
};

export interface StrategyContext {
  /** The strategy that was active previously (null on first run) */
  previous: Strategy | null;
  /** How many consecutive days the raw selector has suggested a different strategy */
  consecutiveDaysAtCandidate: number;
  /** Manual override from settings (null = auto) */
  override: StrategyOverride;
}

/**
 * Select a prediction strategy from computed signals.
 *
 * @param signals - Computed strategy signals
 * @param ctx - Optional hysteresis context. Without it, behaves statelessly.
 */
export function selectStrategy(
  signals: StrategySignals,
  ctx?: StrategyContext,
): Strategy {
  // Manual override always wins
  if (ctx?.override) return ctx.override;

  const raw = selectRaw(signals);

  // Without hysteresis context, return raw selection
  if (!ctx?.previous) return raw;

  // Age-gated newborn: no hysteresis needed — if age says newborn, it's newborn
  if (raw === "newborn_guidance") return raw;

  const prevOrder = STRATEGY_ORDER[ctx.previous];
  const rawOrder = STRATEGY_ORDER[raw];

  // Forward progression (newborn → emerging → schedule): require 3+ days
  if (rawOrder > prevOrder) {
    return ctx.consecutiveDaysAtCandidate >= 3 ? raw : ctx.previous;
  }

  // Regression (schedule → emerging, or emerging → newborn): require 5+ days
  if (rawOrder < prevOrder) {
    return ctx.consecutiveDaysAtCandidate >= 5 ? raw : ctx.previous;
  }

  // Same strategy — no change
  return raw;
}

/** Raw (stateless) strategy selection from signals. */
function selectRaw(signals: StrategySignals): Strategy {
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
