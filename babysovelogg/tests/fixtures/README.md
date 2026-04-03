# Test Fixtures

Backtest fixture data for the sleep prediction engine. Each file is
`{ birthdate: string, days: DayRecord[] }`.

## Data Sources

### halldis-sleep.json — PRIMARY

Parent-logged via Napper app + babysovelogg. Europe/Oslo timezone.

- **86 days**, 6-9 months old
- High quality: consistent logging, accurate wake times, complete nights
- This is **our** baby — the only dataset where we control data quality
- Use this as the primary benchmark for all prediction changes

### baby_1-sleep.json — SECONDARY

Kaggle "Tracking Babies Daily" dataset. America/New_York timezone.

- **805 days**, 2 weeks to ~36 months
- 90% of days have night entries. Good longitudinal coverage.
- **Signal window: 8-17 months** — nap MAE 18-66 min, comparable to Halldis.
  This is where the engine's predictions are meaningful.
- 0-7 months: chaotic newborn sleep (6-11 naps/day, fragmented nights).
  High MAE is expected — no algorithm works well here.
- 18+ months: single nap, data gets sparser. After month 24, tracking
  becomes intermittent with multi-week gaps.
- Last ~80 days have declining quality (missing nights, 6-month gap at end).

### baby_2-sleep.json — LOW QUALITY

- **147 days**, ~0-8 months. Only 35% of days have night entries.
- Many days are nap-only — night sleep simply wasn't logged.
- Some anomalous night entries (18+ hours — likely data entry errors).
- Decent for 3-7 month nap patterns where data exists, but bed/wake
  predictions are unreliable due to missing night data.

### baby_3-sleep.json — NEWBORN ONLY

- **71 days**, ~0-3 months. 86% night coverage.
- Most night entries are very short (< 4h) — fragmented newborn sleep.
- High nap counts (31% of days have 6+ naps).
- Useful for testing newborn-specific edge cases, not for validating
  the prediction engine (no circadian rhythm at this age).

### baby_4-sleep.json — TOO SHORT

- **26 days**, ~0-1.5 months. Only 1 night entry in the entire dataset.
- Clean data within its limited scope, but too short for meaningful
  backtesting. Count/timing predictions have almost no learning data.
- Mostly useful as a cold-start edge case.

### baby_5-sleep.json — FRAGMENTED

- **43 days**, ~0-2.5 months. 21% night coverage.
- Extreme fragmentation: 46% of days have 6-9 naps.
- 11-day tracking dropout in the middle.
- Very short night entries (avg 3.6h) — likely partial overnight segments.
- Use only for stress-testing fragmentation handling.

## Usage Guidelines

**For prediction quality evaluation:** Use halldis and baby_1 (8-17mo).
These are the only datasets with enough quality data to meaningfully
evaluate the engine. Don't let baby_2-5 regressions block changes that
help these two.

**For robustness testing:** baby_2-5 are useful as edge cases — missing
nights, sparse data, newborn chaos. The engine should handle them
gracefully (not crash, not produce absurd predictions) but the metrics
on these datasets are not reliable benchmarks.

**Missing data:** Many days in baby_2-5 have no night entry. This means
the backtest can't score bedtime/wake predictions for those days. The
engine should treat missing data as missing — not infer or fabricate
entries. In the live app, the UI handles this by prompting parents to
backfill forgotten wake-ups.

## Classification Notes

Sleep type (nap vs night) is determined by the `kaggle-to-fixture.ts`
script using a simple heuristic: night if duration > 6h, or if duration
> 3h AND start hour is 18:00-05:59 local. This misses short overnight
fragments (< 3h) common in newborn data, which get classified as naps.
This is a known limitation — the Kaggle CSV doesn't distinguish sleep
types, so we infer from timing and duration.
