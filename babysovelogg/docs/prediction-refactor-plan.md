# Prediction Engine Refactor Plan

Authored 2026-04-02. Covers the full scope of improvements to nap/sleep prediction.

---

## Current State Assessment

The engine predicts **nap onset times** reasonably well for a baby with a stable schedule (34 min MAE at 8 months on Halldis data). The supporting infrastructure — backtest harness, baseline comparisons, calibration tracking — is solid.

But **duration prediction is amateurish**, **wake time prediction is naive**, and there's **no sleep cycle awareness** at all. The backtest doesn't even measure duration accuracy, so we've been blind to these problems.

### What works

| Component | Quality | Notes |
|-----------|---------|-------|
| Backtest harness | Good | Day-ahead + intra-day, baseline comparisons, warm-up curves |
| Nap count learning | Good | Recency-weighted hypothesis scoring adapts during transitions |
| Positional wake windows | Good | Learns 1st vs 2nd nap WW independently |
| Calibration / confidence | Adequate | Tracks data quality, but CIs never validated against actuals |

### What's broken or missing

| Problem | Where | Severity |
|---------|-------|----------|
| Nap duration is a flat average across all positions | `schedule.ts:387-405` | High — wrong for both 1st and 2nd nap |
| Night duration is a flat average | `schedule.ts:368-384` | High — ignores circadian wake anchor |
| Backtest has no duration/wake-time metrics | `backtest.ts:14-23` | High — can't measure if improvements work |
| No sleep cycle awareness anywhere | all of engine/ | High — misses the dominant structure in baby sleep |
| Bedtime: yesterday-repeated beats the engine by 51% | baselines.unit.ts | Medium — 26.1 vs 39.3 min MAE |
| 9mo nap MAE spikes to 148.7 min (vs 34 at 8mo) | backtest snapshot | Medium — transition handling is poor |
| Galland regression equations unused | galland2012.ts | Low — step functions work OK for now |
| SHINE actigraphy data unused | shine2021.ts | Low — useful for defaults but not urgent |
| Confidence intervals never validated | confidence.ts | Medium — "95% CI" might be way off |

---

## Phase 1: Measure What We're Blind To

**Goal:** Add metrics and tests so that any algorithm change is measurable. Write tests that are implementation-independent — they test outcomes, not internals.

### 1a. Extend backtest metrics

Add to `DayResult` in `backtest.ts`:

- `napEndErrors: number[]` — predicted end time vs actual end time, per matched nap
- `napDurationErrors: number[]` — predicted duration vs actual duration, per matched nap

Add to `BacktestResult`:

- `napDurationMAE: number` — mean absolute error on nap duration (minutes)
- `napEndMAE: number` — mean absolute error on nap end time (minutes)

These piggyback on the existing matched-nap loop (line 104), so the change is small.

### 1b. Add night wake-time backtest

Currently the backtest only measures bedtime (night start). Add:

- `wakeTimeError: number | null` — predicted morning wake vs actual morning wake
- `wakeTimeMAE: number` — aggregate

This uses `getLearnedNightDuration` (or whatever replaces it) to predict next-morning wake, compared to the next day's `wakeTime`.

### 1c. New test suite: `duration-prediction.unit.ts`

Implementation-independent tests against fixture data:

```
describe("nap duration prediction")
  it("1st-nap duration MAE < X min on halldis data")
  it("2nd-nap duration MAE < X min on halldis data")
  it("predicts longer 1st naps than 2nd naps for 7-8mo baby")
  it("duration improves with more data (day 15+ < day 1-3)")

describe("night wake-time prediction")
  it("wake-time MAE < X min on halldis data")
  it("wake-time prediction beats naive bedtime+average approach")
  it("accounts for circadian anchor (wake time varies less than bedtime)")

describe("confidence interval coverage")
  it("predicted ranges contain actual times >= 60% of the time")
  it("wider ranges at cold start, narrower with more data")
```

Thresholds (X) are set by first running the current algorithm to establish a baseline, then only tightening as improvements land. The tests should work with any implementation.

### 1d. Add duration columns to baseline comparison

Extend `baselines.unit.ts` to compare duration MAE across all predictors. This tells us if a simple baseline (e.g., "yesterday's nap durations") beats the engine on duration — just like we already know it does for bedtime.

---

## Phase 2: Low-Hanging Improvements

Changes that use data we already have and don't require new modeling.

### 2a. Positional nap duration

Currently `getLearnedNapDuration` averages all nap durations into one number. The fix:

- Group recent nap durations by position (1st nap of day, 2nd nap, etc.) — same approach as `getPositionalWakeWindows`
- Return a per-position duration array
- `predictDayNaps` uses `positionalDurations[i]` instead of a single `napDurationMinutes`
- Fallback: if not enough samples at a position, use the global average

**Expected impact:** Should clearly separate 1st-nap duration (typically 60-90 min) from 2nd-nap duration (typically 30-45 min). Directly measurable via Phase 1 metrics.

### 2b. Circadian wake-time anchor

Current `expectedNightEnd` = `bedtime + avg_night_duration`. Real babies have a characteristic wake time that barely moves with bedtime — SHINE data shows wake time SD of only 0.8-1.1h across all ages, vs bedtime SD of 0.7-1.0h.

Better approach: blend two signals:

```
predicted_wake = α * (bedtime + learned_night_duration) + (1-α) * learned_wake_time
```

Where `learned_wake_time` is the average morning wake time from recent data. Start with α=0.5, let the backtest tune it. The circadian component acts as a regularizer — a 30-min late bedtime shouldn't shift wake by 30 min.

### 2c. Bedtime anchoring

The engine loses to yesterday-repeated on bedtime (39.3 vs 26.1 min MAE). This is because bedtime is heavily determined by family routine, not just sleep pressure.

Add a `learned_bedtime` component: average bedtime from recent nights, blended with the current pressure-based calculation. Same idea as wake-time anchoring — circadian/routine regularity as a prior.

### 2d. Sleep-cycle-aware duration rounding

Infant sleep cycles: ~50 min (young), ~55-60 min (older). Nap durations cluster at cycle boundaries: 25 min (half), 50 min (1 cycle), 100 min (2 cycles).

After computing a raw predicted duration, snap to the nearest likely cycle boundary:

```
cycle_length = age < 6 ? 50 : 55  // minutes
candidates = [cycle_length/2, cycle_length, cycle_length*1.5, cycle_length*2]
snapped = nearest(candidates, raw_prediction)
```

This is a soft bias, not a hard snap — blend the snapped value with the learned value. The insight is that a baby almost never sleeps exactly 37 minutes; they sleep ~25 or ~50.

---

## Phase 3: Sleep Pressure and Budget Modeling

These require more careful design but are the path to substantially better predictions.

### 3a. Total daily sleep budget

Babies have a roughly fixed total sleep need per 24h (Galland 2012: 12.9h at 6mo, 12.6h at 9mo). If today's naps were longer than average, tonight's sleep should be shorter (and vice versa).

Implementation:

- Track `total_nap_minutes_today` after each nap
- Compare to `expected_total_nap_minutes` (from positional durations)
- Adjust predicted night duration: `night_pred -= (actual_naps - expected_naps) * budget_factor`
- Also works in reverse: after a short night, predict longer naps

The `budget_factor` should be <1.0 (not fully compensatory — the body doesn't perfectly trade nap for night), tuned via backtest.

### 3b. Onset latency feedback loop

The `fall_asleep_time` field exists and `latency.ts` categorizes it, but the result is never fed back into the next prediction. Close the loop:

- If latency > 20 min (undertired): add 10-15 min to next wake window
- If latency < 5 min (overtired): subtract 10-15 min from next wake window
- Decay the adjustment over subsequent naps (it's a one-time signal)

This requires the intra-day backtest to validate, since it's a within-day adjustment.

### 3c. Better nap transition handling

The 9mo cliff (148.7 min MAE) happens because the engine keeps predicting 2 naps when the baby has shifted to 1. Current detection (`detectNapTransition`) requires 5 days and a 0.5-nap difference, which is too slow.

Improvements:

- Weight the most recent 2-3 days much more heavily during known transition ages (7-9mo, 13-18mo)
- Use a "transition mode" where confidence intervals widen and the engine shows both schedules (e.g., "if 2 naps: ... / if 1 nap: ...")
- Detect single-nap days as a strong signal at transition ages (currently these are treated the same as missing data)

### 3d. Use Galland regression equations for continuous defaults

Replace the step-function lookup tables in `constants.ts` with the Galland fractional polynomial equations from `galland2012.ts`. The equations have R^2 = 0.89-0.98 and provide smooth, continuous estimates instead of jumping at age boundaries.

The step functions remain as sanity-check clamps, but the primary default comes from the regression.

---

## Phase 4: Deeper Sleep Cycle Modeling

This is aspirational — the most impactful but also the most complex.

### 4a. Cycle-based duration model

Instead of predicting duration in minutes, predict the number of sleep cycles:

```
predicted_cycles = f(nap_position, age, time_of_day, prior_wake_duration)
predicted_duration = predicted_cycles * cycle_length(age)
```

Where `cycle_length(age)` uses the known developmental curve (~50 min at birth, ~60 min by 12mo).

Benefits:
- Naturally explains why nap durations cluster at specific values
- Makes "short nap" = "woke after 1 cycle" a first-class concept
- Night sleep becomes "N cycles" which predicts wake times at cycle boundaries

### 4b. Wake probability at cycle boundaries

During an active sleep, the baby is most likely to wake at cycle transitions. Model this as:

```
wake_probability(t) = base_rate * (1 + amplitude * cos(2π * t / cycle_length))
```

This gives a sinusoidal wake probability that peaks every ~50-55 min. For active sleep tracking, this means:
- "Baby has been asleep 45 min → likely to wake in ~5-10 min (cycle boundary)"
- "Baby has been asleep 55 min and still sleeping → probably entering another cycle, likely 50+ more min"

This would power a real-time "likely wake in X min" display during active naps.

### 4c. Night wake prediction

Using the cycle model + SHINE night wake interval data:
- Night sleep = sequence of cycles with wake probability at each transition
- Young babies (< 6mo): ~3.2 wake intervals/night (SHINE)
- Older babies (> 12mo): ~0.6 wake intervals/night
- Predict likely wake windows (e.g., "may wake around 23:30, 02:00, 04:30")

This is the most speculative part — probably needs more data than we have for individual calibration.

---

## What NOT To Do

- **Don't add ML/neural networks.** N=1 baby (or N=6 with Kaggle). Any model complex enough to overfit will overfit. The current transparent, explainable approach is correct for the data size.
- **Don't tune thresholds on Halldis data.** Every constant tuned on one baby is a potential regression for the next. Use multi-baby backtest to validate.
- **Don't add external variables we can't track.** Illness, teething, milestones — we can't predict these, so modeling them adds complexity without predictive power. What we can do is detect them (sudden accuracy drop → suggest "was baby unwell?") and widen confidence intervals.
- **Don't break the working parts.** Nap onset prediction at 34 min MAE (8mo) is good. Phase 2-4 changes should not regress this. The regression guards in `backtest.unit.ts` protect against this.

---

## Implementation Order

```
Phase 1 (tests first)     ✅ DONE
  1a. Duration metrics in backtest
  1b. Wake-time metrics in backtest  
  1c. duration-prediction.unit.ts
  1d. Duration baselines

Phase 2 (quick wins)       ✅ DONE
  2a. Positional nap duration
  2b. Circadian wake-time anchor (data-driven blend weight)
  2c. Bedtime anchoring (data-driven blend weight)
  2d. Cycle-aware duration rounding (soft bias)

Phase 3 (pressure modeling) ✅ PARTIALLY DONE
  3a. Daily sleep budget     ✅ (hurts wake MAE by 1.4 min — needs tuning)
  3b. Onset latency feedback   (needs fall_asleep_time data)
  3c. Transition handling      (9mo cliff: 149 min MAE — biggest remaining problem)
  3d. Galland regression equations (minor improvement over step functions)

Feature toggle system        ✅ DONE
  - PredictionFeatures on BabyContext
  - Ablation test (tests/unit/ablation.unit.ts)
  - Backtest accepts features option

Phase 4 (cycle modeling)     FUTURE
  4a. Cycle-based duration model
  4b. Wake probability at boundaries
  4c. Night wake prediction
```

Each phase has its own backtest targets. Phase 1 establishes baselines. Phases 2-4 must show measurable improvement on those baselines before merging.

---

## Feature Ablation Results (2026-04-02)

Measured on Halldis data (82 days). Delta = what happens when you disable the feature:

| Feature | nap MAE | dur MAE | bed MAE | wake MAE | Verdict |
|---------|---------|---------|---------|----------|---------|
| positionalDuration | +0.8 | +0.4 | 0 | 0 | **Helps** nap timing and duration |
| habitualWake | 0 | 0 | 0 | +3.3 | **Helps** wake prediction |
| habitualBedtime | 0 | 0 | **+17** | 0 | **Biggest single contributor** |
| cycleBias | 0 | 0 | 0 | +0.2 | Marginal |
| sleepBudget | 0 | 0 | 0 | -1.4 | **Hurts** — needs tuning or disabling |
| weightedRecency | 0 | 0 | 0 | 0 | Neutral on this dataset |

**Key insight:** habitualBedtime alone accounts for +17 min bedtime improvement. The data-driven weight system means consistent families get near-100% habitual weight automatically.

**sleepBudget hurts slightly** — the 50% compensation factor may be too aggressive, or the signal is noisy on this dataset. Consider tuning down to 25% or making it adaptive.

### Future: Dynamic Feature Selection

Not yet implemented. The idea:
- Run ablation per-baby during initial data collection
- Auto-disable features that hurt that specific baby's predictions
- Log feature on/off decisions with backtest deltas
- Re-evaluate periodically as more data arrives
- Show parents a "prediction quality" indicator based on recent accuracy

This requires the multi-baby backtest infrastructure to validate across populations.

---

## Results Summary (Phase 1 baseline → current)

| Metric | Phase 1 baseline | Current | Change |
|--------|---------|---------|--------|
| Nap start MAE | 58.5 min | 57.8 min | -1% |
| **Nap duration MAE** | 23.5 min | **23.4 min** | ~ |
| **Bedtime MAE** | 39.3 min | **22.3 min** | **-43%** |
| **Wake time MAE** | 46.5 min | **44.9 min** | -3% |
| Nap end MAE | 64.7 min | 63.8 min | -1% |
| 9mo nap start MAE | 148.7 min | 148.9 min | unchanged |
| Engine beats all baselines | No (bedtime) | **Yes** | Fixed |
| CI coverage | 54% | 54% | unchanged |
