# Prediction Engine: Next Steps

## Current state (2026-03-30)

### What we built this session
- **Backtest harness** with 83-day golden dataset (Halldis) + 5 Kaggle babies
- **Learned nap count** from data (mode with >60% dominance, validated against SHINE population SDs)
- **Adapted wake window range** — unions ranges from all age brackets where the learned nap count is valid
- **Separated nap vs bedtime wake windows** — nap prediction only uses gaps before naps, bedtime uses nap→night gaps separately
- **Population norms** from Galland 2012 (regression equations, 34 studies) and SHINE 2021 (433 babies, actigraphy)
- **TZ-correct learning** — day grouping uses baby's IANA timezone throughout
- **Fixture tooling** — converters for Napper CSV, our DB, and Kaggle CSV

### Accuracy
```
Halldis (parent-logged, 7-9mo):  58 min nap MAE, 40 min bedtime MAE
baby_1 (auto-tracked, 8-17mo):  22-57 min nap MAE, 27-42 min bedtime MAE
```
Algorithm works well at 8+ months with parent-logged-quality data.
Kaggle newborn data is auto-tracked (many micro-sleeps) — different granularity than parent-logged.

### Architecture assessment (from codex review)
> It is a reasonable heuristic engine for a single baby with sparse data.
> Simple, debuggable, age-prior-driven, adapts from observed behavior
> instead of pretending to do ML with tiny datasets. For this product,
> that is the right starting point.

## Priority roadmap

### 1. BabyContext refactor
Replace scattered params (ageMonths, recentSleeps, tz, customNapCount) with a single `BabyContext` object threaded through the engine. Enables clean timezone handling, eliminates forgotten-parameter bugs. See `docs/refactor-baby-context.md`.

### 2. More parent-logged data
The single most valuable thing for improving predictions. Real diary-style logs matching our data model. Even 5 more families would double our validation set. The Kaggle auto-tracked data is useful for validation at 8+ months but doesn't match the granularity of parent-logged data at younger ages.

### 3. Target bedtime (backward planning)
Parent sets desired bedtime (e.g. 18:30). Algorithm works backward to space naps optimally. Both forward (from wake-up) and backward (from target bedtime) plans run simultaneously. Self-fulfilling loop: app recommends → parent follows → sleep improves. Napper has this and it works well.

### 4. Confidence intervals / ranges
Show "predicted 10:30, likely 10:15-10:45" instead of a point estimate. Use variance from the lookback window. Wider when the baby's pattern is variable. Codex: "predict ranges, not just a single time — more honest and more usable."

### 5. UI redesign
- Population comparison ("your baby vs typical") using Galland/SHINE norms
- Live bedtime projection during naps ("if she wakes now → 18:15, 30 more min → 18:45")
- "Why this prediction?" explainability
- Trend charts: nap count, wake windows, bedtime over weeks/months
- Nap transition indicator
- Target bedtime mode vs follow-the-baby mode
- In-app tooltips teaching sleep science

### 6. Transition-specific logic
The 2→1 nap transition is the hardest prediction period. Currently uses a hard >60% mode switch. Codex: "keep both hypotheses alive and score them" instead of abrupt switching. Model the transition as a probabilistic state, not a binary flip.

### 7. Trivial baseline comparisons
Compare our engine against: age-default only, yesterday-repeated, 3-day moving average. If the engine can't consistently beat those, it's too complex for its gain. Healthy sanity check. Track per-month, not just aggregate.

### 8. Weighted recency
Exponential decay instead of flat 7-day average. Deferred — low reward with current data (N=6), risk of overfitting to noise. Revisit when we have a handful of good parent-logged transition datasets. Can test offline behind the benchmark harness without shipping to production.

### 9. Calibration tracking
Track not just MAE but when the engine should trust itself vs back off. If learned nap count is weak or wake windows have few examples, surface wider ranges or fall back to age defaults instead of pretending certainty.

## Data collection improvements

### Wake-up context (re-add from Napper)
Two separate signals to avoid confounding:
1. "How did you find them?" — sleeping still / awake & calm / crying
2. "How long had they been awake?" — just woke / a few minutes / waiting

Baby crying because parent was late is not the same as baby crying because sleep was bad.

### Sleep onset latency guidance
Already have `fall_asleep_time` field. Add in-app explanation:
- Short (<5 min): possibly overtired
- Normal (10-20 min): good timing (Galland 2012: infant mean 19 min)
- Long (>30 min): possibly undertired

### ~~Nap quality signal~~ — tested and rejected (2026-03-31)
Hypothesis: short nap → shorter next WW, long nap → longer. Tested via intra-day replay harness across 6 babies (2448 nap-to-nap gaps). Result: no adjustment wins on 5/6 babies and every nap-duration bucket. After short naps (≤30m), actual gap averaged 104 min — shorter than after normal naps (114 min) but the engine's base prediction already accounts for this via learned positional wake windows. Adding an explicit adjustment (both 15% and 7% variants) makes MAE worse. "Stick to the plan" is the right default. Revisit only with significantly more parent-logged data.

## Reference data in the codebase

- `src/lib/data/galland2012.ts` — normative tables + regression equations from 34 studies (~34K children). Nap counts, sleep duration, latency, night wakings, longest stretch. Open published data.
- `src/lib/data/shine2021.ts` — actigraphy stats from 433 infants at 1/6/12/24 months. Night/day sleep, bedtime, wake time, WASO, efficiency. From public NSRR variable pages.
- SHINE raw per-baby data blocked (HIPAA training + non-commercial license).
- Zenodo LIDS data (152 infants) — sleep cycle dynamics, not nap timing. In `data-zenodo-infant-sleep/`.

## Key learnings

- **Nap vs bedtime wake windows are fundamentally different signals.** Averaging them together inflated nap predictions by ~60 min. Separating them was the single biggest accuracy improvement.
- **Age-based constants are good priors but bad ceilings.** The index-alignment bug capped 1-nap babies at 240 min when they needed 360. Population data (SHINE/Galland) validates the age defaults as reasonable starting points.
- **The data source matters more than the algorithm.** Auto-tracked data (Kaggle) gives 8+ naps/day at 3 months where parent-logged data gives 3-4. The algorithm can't compensate for input granularity mismatch.
- **Server TZ = baby TZ is a pragmatic single-tenant design**, but tests are multi-tenant. Threading TZ properly through the engine (and eventually via BabyContext) solves this cleanly.
- **Adjusting wake windows after short naps doesn't help.** Tested across 2448 gaps on 6 babies — "stick to the plan" beats both 15% and 7% adjustments. The engine's learned positional wake windows already capture the pattern implicitly.
