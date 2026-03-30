# Prediction Engine: Next Steps

## Current state (2026-03-30)

Backtest on 6 babies (Halldis + 5 Kaggle):
- Halldis (parent-logged, 7-9mo): 58 min nap MAE, 40 min bedtime MAE
- baby_1 (auto-tracked, 11-17mo): 22-57 min nap MAE, 27-42 min bedtime MAE
- Algorithm works well at 8+ months with parent-logged-quality data
- Struggles with auto-tracked newborn data (different granularity)

## Algorithm improvements

### Target bedtime (backward planning)
Parent sets desired bedtime (e.g. 18:30). Algorithm works backward:
- Bedtime anchor → last wake window → latest nap end → nap start → ...
- Both forward (from wake-up) and backward (from target bedtime) plans
  run simultaneously, showing the parent what to aim for
- Learning period: 4-5 days to calibrate, then starts adjusting
- Self-fulfilling loop: app recommends → parent follows → sleep improves
- Napper has this feature and it works well

### Live bedtime projection during naps
When a nap is in progress, project bedtime from the nap's current
duration. "If she wakes now → bedtime 18:15. If she sleeps 30 more
min → bedtime 18:45." Helps parent decide whether to wake the baby.

### Weighted recency
Exponential decay instead of flat 7-day average. Recent days count more.
- Risk: with N=6 babies we can't validate properly, might overfit to noise
- Reward: ~5-10 min faster adaptation during transitions
- Recommendation: skip until we have 50+ babies to test against

### Confidence intervals
Show "predicted 10:30, likely 10:15-10:45" instead of a point estimate.
Use the variance from the lookback window. Wider intervals when the
baby's pattern is variable, narrower when consistent.

## Data collection improvements

### Wake-up context (re-add from Napper)
Two separate signals:
1. "How did you find them?" — sleeping still / awake & calm / crying
2. "How long had they been awake?" — just woke / a few minutes / waiting

Separates sleep quality (was sleep restorative?) from response time
(did parent arrive fast enough?). Currently confounded — baby cries
because parent was late, not because sleep was bad.

### Sleep onset latency guidance
Already have `fall_asleep_time` field. Add in-app explanation:
- Short (<5 min): possibly overtired
- Normal (10-20 min): good timing
- Long (>30 min): possibly undertired
- Galland 2012: infant mean = 19 min (range 0-43)

### Nap quality signal
Short nap (30 min = 1 sleep cycle) vs long (90+ min = multi-cycle).
Short naps indicate timing was off. Could adjust next wake window:
- After short nap → slightly shorter next WW (baby didn't fully reset)
- After long nap → normal or slightly longer next WW

### In-app tooltips
Brief explanations for each data point: what it means, why we ask,
how it helps predictions. Teaches the parent sleep science gradually.

## UI redesign

### What to show
- Prediction arc with confidence bands (not just a point)
- Population comparison: "your baby vs typical" using Galland/SHINE norms
- Trend charts: nap count, wake windows, bedtime over weeks/months
- Nap transition indicator: "she may be dropping to 1 nap"
- Sleep quality score based on duration, consistency, onset latency

### How to surface predictions
- "Why this prediction?" explainability — "Based on last 5 days, first
  wake window averages 4h15m"
- Manual override learning — if parent consistently differs from
  prediction, adapt faster
- Target bedtime mode vs. follow-the-baby mode

### What data to surface from SHINE/Galland
- Age-appropriate ranges for total sleep, nap count, bedtime
- "Is my baby normal?" with z-scores and percentile bands
- Developmental milestones that affect sleep (4mo, 8mo, 12mo)

## More data

### Parent-logged data from babysovelogg users
The most valuable data source. Real diary-style logs matching our
data model. Even 5 more families would double our validation set.

### Zenodo infant sleep data
152 infants with actigraphy at 3/6/12 months. Sleep cycle dynamics
(LIDS), not nap timing. Useful for understanding sleep architecture
but not directly for nap prediction.

### SHINE raw data
Blocked: requires HIPAA training + non-commercial license.
Aggregate stats already extracted into shine2021.ts.

### Kaggle data limitations
Auto-tracked, not parent-logged. Many micro-sleeps at young ages.
Useful at 8+ months where nap count converges with parent-logged
patterns. No birthdates (estimated). US timezone (assumed Eastern).
