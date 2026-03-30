Report answering a couple questions about improving our sleep prediction
===

- How do the nap and sleep-time predictions work today in this app?
- How is our test setup for this? Are we set up to massively improve this while always getting better and knowing we do?
- Is there datasets for babies and their sleep we could use?
- What does the best literature say about baby sleep patterns and prediction today?
- What are options on what we could do to get better predictions? I assume there are many axis to this.

## 1. How predictions work today (2026-03-30)

The engine lives in src/lib/engine/ (~600 lines across 4 files). It's pure statistics, no ML.

Core flow:
wake-up time → getWakeWindow(age, recentSleeps) → predictDayNaps() → recommendBedtime()

Wake window calculation (schedule.ts:15-27): Starts with age-based defaults (e.g. 6-8mo = 120-180
min), then adapts using a 7-day moving average of the baby's actual wake gaps. Clamped to
age-appropriate min/max.

Day schedule (schedule.ts:51-84): Predicts all naps for the day. Uses positional wake windows (1st
nap has shorter window, last is longer — learned from the last 4+ days). Nap duration is learned
from 3+ recent completed naps (fallback: 60/45/30 min by age).

Bedtime (schedule.ts:86-119): Last wake + 1.15x wake window, clamped to 18:00–20:30.

Nap transition detection (schedule.ts:121-151): Compares recent 3-day nap count average vs earlier
days. Flags "dropping" if ≥0.5 nap difference over 5+ days.

Fallback chain: Positional wake window → average wake window → age-based defaults. Graceful
degradation when data is sparse.

---
## 2. Test setup

51 test files, ~8300 LOC using bun:test (unit/integration) + Playwright (E2E).

The prediction engine specifically has solid coverage:
- schedule.unit.ts (212 lines) — tests getWakeWindow, predictDayNaps, recommendBedtime, detectNapTransition with multiple age brackets and adaptation scenarios
- stats.unit.ts (159 lines) — tests wake window extraction, pause subtraction, weekly aggregation
- arc-utils.unit.ts (221 lines) — tests predicted bubble rendering
- timer-state.unit.ts (285 lines) — tests all 8 UI timer modes including countdown-to-nap and overtime
- E2E tests verify predicted bubbles appear on the arc

Are we set up to massively improve while always knowing we're getting better? Partially. We have:
- Good unit tests for the prediction functions
- A time-helper t(hour, min) and addCompletedSleep() fixtures making it easy to construct scenarios

What's missing for a confident improvement loop:
- No accuracy benchmarking — we don't measure "how far off were predictions from actuals"
- No golden datasets — no saved real-world sleep logs to regress against
- No scoring metric (MAE, RMSE) computed automatically
- No A/B comparison framework ("old algorithm vs new algorithm on same data")

To massively improve with confidence, we'd need a prediction accuracy test harness: feed N days of
real data, predict day N+1, compare to actual, report error. Then every algorithm change is
measured.

---
## 3. Available datasets

Best for us:

┌───────────────────────────────┬─────────────────────────────────┬─────────────────────┬──────────────────────────────────────────────────────────┐
│            Dataset            │              Size               │       Access        │                           What                           │
├───────────────────────────────┼─────────────────────────────────┼─────────────────────┼──────────────────────────────────────────────────────────┤
│ SHINE (NSRR)                  │ 433 infants at 1/6/12/24 months │ Free (registration) │ Real actigraphy, 5-7 day stretches per visit             │
├───────────────────────────────┼─────────────────────────────────┼─────────────────────┼──────────────────────────────────────────────────────────┤
│ Zenodo #5070945               │ 410 infants, 3-12 months        │ Open access         │ BISQ sleep questionnaire data (onset, duration, wakings) │
├───────────────────────────────┼─────────────────────────────────┼─────────────────────┼──────────────────────────────────────────────────────────┤
│ Galland 2012 meta-analysis    │ 34 studies aggregated           │ Published paper     │ Normative reference values by age (best lookup table)    │
├───────────────────────────────┼─────────────────────────────────┼─────────────────────┼──────────────────────────────────────────────────────────┤
│ Kaggle: Tracking Babies Daily │ Small, 0-2 years                │ Apache 2.0          │ Daily routine logs including sleep                       │
└───────────────────────────────┴─────────────────────────────────┴─────────────────────┴──────────────────────────────────────────────────────────┘

Ideal but closed: Mindell 2016 (156K sessions, 841 babies, from J&J bedtime app) and Nanit (1.78M
nights of video-derived data, 15+ papers). Both publish only aggregate stats.

---
## 4. What the science says

Circadian rhythm: Doesn't exist at birth. Melatonin production starts ~6 weeks, day-night rhythm at
9-12 weeks, fully entrained by 3-4 months.

Wake windows: Not directly studied as a concept in clinical research. Derived from the two-process
model (homeostatic sleep pressure + circadian rhythm). The commonly cited ranges are population
averages with wide individual variation.

Predictability: High inter-individual variability is the universal finding. BUT one longitudinal
study achieved 94% accuracy predicting 6-month sleep status from 1-month variables. Best predictors:
parental presence at sleep onset, night waking frequency, total sleep time. Feeding method and
gender were NOT predictive.

"Sleep regressions": The term doesn't appear in peer-reviewed literature. The 4-month "regression"
is actually permanent sleep architecture maturation (2-stage → 4-stage cycles). Others are tied to
motor milestones and nap transitions.

Commercial apps (Huckleberry, Napper, Bambii): All use variations of age-based wake windows +
individual tracking data + pattern matching. None have published their algorithms or submitted to
peer review.

---
## 5. Axes for better predictions

Here are the improvement dimensions, roughly ordered from easiest/highest-impact to hardest:

A. Better use of data we already collect

- Weighted recency — exponential decay instead of flat 7-day average (yesterday matters more than 6 days ago)
- Day-of-week patterns — some babies have different weekday/weekend rhythms
- Circadian time-of-day adjustment — morning wake windows are typically shorter than afternoon ones; our positional learning partially captures this but a time-of-day curve would be more robust
- Sleep debt tracking — if yesterday was a bad sleep day, today's windows may be shorter

B. Better statistical models

- Per-baby regression model — instead of averaging, fit a simple linear model: `wake_window = f(nap_position, time_of_day, prior_sleep_total, age)`
- Bayesian updating — start with population priors (from Galland/SHINE), update with each day's data. Gives both predictions and confidence intervals
- Nap duration prediction — currently flat average; could learn per-position and time-of-day patterns

C. Accuracy measurement infrastructure

- Backtest harness — replay historical data, predict each day, measure MAE/RMSE
- Golden test sets — curated real-world scenarios (good sleeper, bad sleeper, transition period, sick day)
- Accuracy dashboard — show the user "your predictions were within X minutes this week"

D. External data integration

- Population norms from SHINE/Galland — show "your baby vs typical" and use as Bayesian priors
- Milestone-aware predictions — flag likely disruption periods (motor milestones at ~4/8/12/18 months)
- Nap transition modeling — our detectNapTransition is threshold-based; could use smoother probabilistic model

E. Advanced modeling (higher effort)

- Hidden Markov Model — model the baby's latent "sleep state" (well-rested, overtired, transitioning) and predict differently per state
- Gaussian Process regression — nonparametric model that naturally gives uncertainty bounds
- Train on SHINE dataset — learn population-level patterns, then fine-tune per baby
- Ensemble — combine age-based, personal-average, and regression predictions with learned weights

F. UX-level improvements

- Confidence intervals — show "predicted 10:30, likely 10:15–10:45" instead of a single point
- "Why this prediction" explainability — "Based on your last 5 days, first wake window averages 2h15m"
- Manual override learning — if parent consistently starts naps earlier/later than predicted, adjust

---
The single highest-leverage thing would be C (accuracy measurement) — without it, we're flying blind
on whether any change actually helps. After that, A (better use of existing data) is low-hanging
fruit, and B (Bayesian updating with population priors) would give us both better predictions and
honest confidence intervals.
