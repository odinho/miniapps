# Making babysovelogg Work for Babies Under 6 Months

Consolidated plan. Authored 2026-04-03.
Synthesises analysis from four independent reports with adversarial review.

---

## The Problem

The engine performs well from ~7 months (44 min nap MAE on Halldis, 18–66 min
on baby_1 at 8–17mo). Below 6 months it falls apart:

| Baby | Age range | Nap MAE | Count acc. | Notes |
|------|-----------|---------|------------|-------|
| baby_1 | 0–3mo | ~570 min | ~25% | Polyphasic, no circadian rhythm |
| baby_1 | 4–6mo | 200–300 min | ~35% | Transitioning |
| baby_2 | 0–6mo | 105 min | 40% | Short dataset, noisy |
| baby_3 | 0–3mo | 244 min | 19% | Pure newborn |

These aren't tuning failures. The engine is built around assumptions that
don't hold for young babies:

1. **The day has a wake-up, a finite nap schedule, and a bedtime.** Before
   ~4 months, babies don't have this structure. Sleep is distributed across
   24 hours in irregular episodes.

2. **The night/day split is meaningful.** The Arc UI shows day (06–18) and
   night (18–06). Classification treats sleep after 20:00 as "night." For a
   newborn there is weak day/night differentiation — not none, but too weak to
   anchor predictions.

3. **Nap positions are consistent.** The engine predicts "nap 1 at X, nap 2
   at Y." A newborn has 5–8 interchangeable sleep episodes. Positional
   learning is meaningless.

4. **Wake windows are in the 60–90 min range.** Research puts 0–4 week wake
   windows at 30–60 minutes. A newborn that's been awake 45 minutes may be
   overtired; the engine wouldn't suggest sleep until 75 minutes.

5. **Circadian features help.** Habitual nap start anchoring is gated at ≥5mo
   (correct), but the entire learning pipeline — nap count learning, positional
   wake windows, bedtime learning — assumes a repeating daily structure that
   doesn't exist yet.

The current `Prediction` type in `app.svelte.ts` encodes these assumptions
directly: `nextNap`, `bedtime`, `predictedNaps`, `napsAllDone`. So long as
this is the only prediction shape, the rest of the app is trapped in one
developmental model.

---

## What the Science Says

Sleep development has distinct phases with fundamentally different
characteristics. (Full references in `sleep-science-research.md`.)

### Phase A: Weak Circadian (0–6 weeks)

- No endogenous melatonin production at birth. Emerges ~6 weeks.
- 50-minute sleep cycles starting in Active (REM) sleep.
- Sleep episodes: 1.5–4 hours, separated by 30–60 min wake/feed.
- Total sleep: ~14.6h/24h (Galland), with enormous variance (9.3–20.0h).
- Night wakings: 1.7/night mean (Galland) — but "night" itself is a weak
  concept.
- **What's predictable**: Almost nothing per-episode. The wake window (30–60
  min) is the only useful signal.

### Phase B: Emerging Circadian (6 weeks – 3 months)

- Melatonin production begins ~6 weeks, day-night rhythm by 9–12 weeks.
- Longest sleep stretch growing: ~4.75h at 1mo → 5–6h by 3mo.
- Still 4–5 episodes/day, but night episodes starting to consolidate.
- Bedtime beginning to emerge (but varies 60+ minutes day to day).
- **What's predictable**: Wake windows become more consistent. An emergent
  "longest stretch" (usually overnight) is the first sign of structure.

### Phase C: Consolidating (3–5 months)

- 24h circadian rhythm established by 3–4 months.
- Sleep architecture shifts from 2-stage to 4-stage (~4 months).
- 3–4 naps/day, becoming positional (1st nap = most consistent).
- Night sleep consolidating to 6+ hours.
- **What's predictable**: 1st nap timing becomes clock-anchored. Wake window
  learning is meaningful. But nap count and duration still variable. This is
  where the current engine should start working, but it enters cold with
  garbage learned data from phases A/B.

### Phase D: Established (5+ months)

The current engine's sweet spot. 2–3 naps, habitual times, learnable patterns.

---

## Core Decision: Strategy Selector with Downstream Engines

The app should first decide what kind of sleep world the baby is in, then
offer predictions and UI that match. This is the same principle as the existing
chaotic-vs-habitual blending, but at a higher level.

Three prediction strategies:

```
                    ┌──────────────┐
                    │   Strategy   │
                    │   Selector   │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
      ┌──────────────┐ ┌────────┐ ┌──────────┐
      │   Newborn    │ │Emerging│ │ Routine  │
      │   Guidance   │ │ Rhythm │ │ Schedule │
      └──────────────┘ └────────┘ └──────────┘
```

### 1. Newborn Guidance (Phase A/B: ~0–8 weeks default)

Not a schedule predictor — a "what comes next" advisor.

A newborn parent doesn't benefit from "nap 3 at 14:15." They benefit from:
- "Your baby has been awake 40 minutes. The sleep window is approaching."
- "Your baby has slept 13.8 hours in the last 24 hours. That's normal for
  this age (range: 9–17h)."
- "Your baby's longest stretch was 3.5h this week, up from 2.8h last week."

What the engine predicts:
- **Next sleep window** (earliest–latest from wake window range, not a point)
- **Sleep pressure level** (low / rising / high, from current wake duration
  vs recent tolerance)
- **Expected sleep duration** as a range from recent episodes
- **Longest stretch trend** (current value + weekly change)
- **Total 24h sleep** vs age-appropriate norms (Galland/SHINE)

What it does NOT predict:
- Specific nap times for the day
- Bedtime
- Positional predictions (1st nap, 2nd nap)
- Night end time

For learning purposes: **ignore the nap/night label.** Treat all episodes as
undifferentiated sleep. Learn wake windows and durations from all episodes
regardless of classification. The label is for parent display only.

### 2. Emerging Rhythm (Phase B/C: ~6 weeks – 4 months default)

The transition bridge. Not a separate giant engine — a constrained adapter
around the current schedule engine that uses schedule-mode outputs where
signals are strong and window/range outputs where signals are weak.

Key insight: different nap positions mature at different rates. The 1st nap of
the day typically becomes consistent first (strongest circadian signal from
morning light). The last nap before "bed" is the most variable and last to
stabilise.

What it does:
- **Gradually introduces structure**: Predict morning nap once it's consistent
  (SD < 30 min), but keep newborn-style window predictions for later naps.
- **Soft bedtime**: Once a consistent evening long-stretch start emerges, show
  it as a range ("kveldsøvn truleg mellom 19:30 og 21:00"), not a point.
- **Per-element confidence**: "Morning nap: consistent. Afternoon nap: still
  variable." This is more honest than either full-schedule or full-guidance.
- **Reuse current schedule logic** where its per-signal consistency weights
  (getHabitualBedtimeWeight, computeHabitualNapWeights) indicate strength.
  Don't duplicate the math.

### 3. Routine Schedule (Phase D: 5+ months = current engine)

The existing engine, largely unchanged. The main benefit of the strategy
architecture: it now receives **clean context**. The newborn and emerging
strategies have been properly handling data for months without forcing it into
the schedule model's assumptions, so learned parameters are meaningful from
day one of schedule mode.

---

## How the Selector Decides

Age is a strong prior, not the decision. Behaviour should be the real signal.

### Selection signals

```typescript
interface StrategySignals {
  ageMonths: number;
  ageWeeks: number;
  daysOfUsableData: number;
  completeDays: number;               // days with recognisable day structure
  nightDayRatio: number;              // % of sleep in 18:00–08:00 window
  longestStretchConsistency: number;  // SD of longest sleep start time (min)
  firstNapConsistency: number;        // SD of first morning nap start (min)
  napCountSD: number;                 // SD of daily nap count
  wakeWindowSD: number;               // SD of observed wake windows (min)
  loggingCompleteness: number;        // fraction of days with complete data
}
```

### Initial rules (simple, age-heavy)

```
ageWeeks < 6                              → newborn_guidance
ageMonths >= 5 AND completeDays >= 7
  AND nightDayRatio > 0.55                → routine_schedule
otherwise                                 → emerging_rhythm
```

### Data-quality override

Promote to routine_schedule early if:
- nightDayRatio > 0.6 AND firstNapConsistency < 30 AND ageWeeks > 10

Demote to emerging_rhythm if:
- routine_schedule selected but completeDays < 5 or loggingCompleteness < 0.5

### Hysteresis

Strategy transitions must be:
- **Sustained**: Require 3+ consecutive days qualifying for the new strategy.
- **One-directional by default**: newborn → emerging → schedule. Regression
  only on clear disruption signals (structure score drops below threshold for
  5+ consecutive days).
- **Manually overridable**: A settings toggle for auto / newborn / emerging /
  schedule, for both debugging and parent control.

### Why not a continuous score yet

Both analysis reports proposed elaborate numerical structure scores with
weighted components. This is premature. We have ~120 days of 0–3mo data across
3 noisy Kaggle babies. Tuning a continuous score on this is overfitting the
selector — ironic when we're trying to avoid overfitting the engine. Start
with simple rules. Add a continuous score when we have enough babies to
validate it.

---

## What Changes Where

### Prediction Type (app.svelte.ts)

The `Prediction` interface becomes a discriminated union. This is the
highest-leverage architectural change — without it, everything downstream
stays trapped.

Start incremental: augment the existing `Prediction` with a `strategy` field
and optional strategy-specific fields. Convert to a full union once the second
engine is actually shipping. Premature type splitting creates dead code.

```typescript
// Phase 1: augment
interface Prediction {
  strategy: "newborn_guidance" | "emerging_rhythm" | "routine_schedule";
  // Existing fields (optional for non-schedule strategies)
  nextNap: string | null;
  bedtime: string | null;
  predictedNaps: PredictedNap[] | null;
  napsAllDone: boolean;
  expectedNapEnd: string | null;
  expectedNightEnd: string | null;
  confidence: ConfidenceResult | null;
  calibration: CalibrationReport | null;
  // Newborn/emerging fields
  sleepWindow: { earliest: string; latest: string } | null;
  sleepPressure: "low" | "rising" | "high" | null;
  totalSleep24h: number | null;         // minutes
  longestStretch: number | null;        // minutes
  longestStretchTrend: "growing" | "stable" | "shrinking" | null;
  ageNorms: { min: number; max: number; typical: number } | null; // hours/24h
}
```

### Feature Extraction (new: engine/features.ts)

Extract the statistics/pattern-detection code from schedule.ts into a shared
layer that all engines and the selector can use:

- Wake window distribution (mean, SD) from cache
- Nap count distribution and stability
- Bedtime/wake time consistency metrics
- Night-day sleep ratio
- Longest sleep stretch tracking and consistency
- Per-position nap start consistency
- Logging completeness / data quality metrics

This is pure refactoring. schedule.ts calls into features.ts instead of
computing inline. No behaviour change.

### Strategy Selector (new: engine/strategy.ts)

Orchestration layer:
- Computes strategy signals from features
- Selects strategy (with hysteresis)
- Routes to the appropriate engine
- Returns normalised prediction

### Engines

- **engine/schedule.ts**: The current engine, unchanged. Becomes the
  routine_schedule path.
- **engine/newborn.ts**: Minimal. Calls `getWakeWindow()` and recent-duration
  stats from features.ts. Returns sleep window + pressure level + 24h totals.
  No schedule logic.
- **engine/emerging.ts**: Adapter around the schedule engine. Calls schedule
  functions for elements where per-signal consistency is high; falls back to
  newborn-style window predictions for elements where consistency is low.

### Classification (classification.ts)

No changes to persisted nap/night labels. The data model stays.

For the newborn engine: simply ignore the labels when learning. All episodes
are treated as undifferentiated sleep for wake window and duration calculations.

For the strategy selector: compute derived concepts (night-day ratio,
longest-stretch-start consistency, morning-nap consistency) in the feature
layer. These are analytical signals, not record types — they don't persist.

### Constants (constants.ts)

Immediate fix regardless of strategy work:

```typescript
// Current (too coarse):
{ minMonths: 0, maxMonths: 3, minMinutes: 60, maxMinutes: 90 }

// Proposed:
{ minMonths: 0, maxMonths: 1, minMinutes: 30, maxMinutes: 60 },
{ minMonths: 1, maxMonths: 2, minMinutes: 45, maxMinutes: 75 },
{ minMonths: 2, maxMonths: 3, minMinutes: 60, maxMinutes: 90 },

// Nap counts (current):
{ minMonths: 0, maxMonths: 3, naps: 4, range: [3, 5] }

// Proposed:
{ minMonths: 0, maxMonths: 2, naps: 6, range: [4, 8] },
{ minMonths: 2, maxMonths: 3, naps: 4, range: [3, 5] },
```

Important: this is a tactical mitigation. It should not be confused with
solving the architectural problem.

### State Assembly (engine/state.ts)

Instead of directly calling schedule functions, state assembly routes through
the strategy selector:

```
buildContext → computeFeatures → selectStrategy → runEngine → prediction
```

When strategy = routine_schedule, the code path is identical to today.

### Timer State (timer-state.ts)

Add `kind: 'sleep-window'` mode for newborn/emerging strategies:

```typescript
| { kind: 'sleep-window'; windowStart: number; windowEnd: number;
    pressure: 'low' | 'rising' | 'high' }
```

Shows "sleep window in ~X min" instead of "neste lur om HH:MM."

### UI (adaptive, not three modes)

One dashboard with conditional rendering, not three separate page layouts:

- **Timer center**: Shows countdown (schedule) or sleep-window (newborn) or
  hybrid (emerging) based on `prediction.strategy`.
- **Arc**: Add a 24h mode parameter for newborn strategy (full circle instead
  of 12h half). Keep 12h day/night arcs for emerging/schedule.
- **Bedtime section**: Hidden when strategy = newborn_guidance.
- **Context card** (new): Total sleep, longest stretch, age norms. Prominent
  in newborn/emerging, compact in schedule.
- **Predictions**: Shown as ranges ("~12:10–12:40") in emerging mode, point
  predictions in schedule mode.
- **Guidance text**: Phase-appropriate, factual context in newborn/emerging.
  "I denne fasen er søvnen ofte ujamn gjennom døgnet." Not prescriptive.

This is conditional rendering in existing components, not separate component
trees. The strategy field drives rendering decisions.

### Backtest

Strategy-aware metrics. For each day, record which strategy was active.

Newborn-mode metrics:
- **Sleep window hit rate**: % of actual sleeps starting within the predicted
  earliest–latest window
- **Total sleep prediction error**: predicted vs actual 24h total
- **Longest stretch prediction error**: predicted vs actual

Schedule-mode metrics: unchanged.

The existing backtest harness can be reused. It just needs to know which
strategy was active for scoring.

---

## Transition Hygiene

A critical issue neither original report addressed: **what happens to learned
data when the strategy changes?**

When a baby graduates from newborn → emerging → schedule, the schedule engine's
learning functions (getLearnedNapCount, getLearnedBedtimeWakeWindow, etc.)
will include data from the newborn phase that doesn't match the schedule
model. Random 2-month-old wake windows will pollute the learned wake window
for weeks via the lookback.

**Fix**: On strategy promotion to routine_schedule, narrow the learning
lookback to data from the most recent 10 days. This ensures the schedule
engine learns from data that reflects the current phase, not historical chaos.

For the newborn engine going the other direction (temporary regression to
emerging during illness/travel): the newborn engine doesn't use positional
learning, so it doesn't care about historical schedule data. No special
handling needed.

---

## What "Helpful" Means for Newborn Parents

The biggest product insight: for newborn parents, the most valuable output may
not be prediction accuracy. It may be **context and normalisation**.

A parent at 03:00 doesn't need "next sleep in 45 minutes." They need:
- "This is normal. Your baby has slept 14.2h in the last 24h — right in the
  middle of the normal range for this age."
- "The longest stretch was 3.5 hours. That's typical at 4 weeks."
- "Your longest stretch has grown from 2.5h to 3.5h this week." — The most
  actionable insight in the newborn phase.

The newborn engine's most important outputs are **context** (total sleep, age
norms, longest stretch trend), with prediction (sleep window) as secondary.

### The co-parent use case

During the newborn phase, parents often split shifts. The app showing "your
baby last slept X ago, usually sleeps Y minutes around this time" is
enormously helpful for the parent who just woke up without context. This
doesn't need prediction at all — just good state display.

---

## Feed Tracking (Optional Enhancement, Phase 6)

Feed timing is the strongest predictor of newborn sleep. A baby who just
completed a full feed is much more likely to sleep within 15–30 minutes. The
wake window is really a post-feed window.

This is explicitly NOT a phase-1 dependency. Designing around data we don't
have is a mistake.

Minimal viable version (later phase):
- Add a "fed" button to the wake screen (newborn/emerging modes only)
- Store timestamp only (not duration, not breast/bottle)
- Use time-since-last-feed as an additional signal in sleep window estimation
- Display "sist mata X minutt sidan" in the context card

Small data model change, single UI button, high value for newborn accuracy.

---

## Rejected Ideas

### "There is no night for newborns"

Too absolute. Newborn day/night structure is weak and should not be
over-trusted for prediction — but it's not absent. Even at 2 weeks, longest
stretches tend to be nocturnal. The correct stance: classification is fine for
display, but prediction should not depend on it.

### Feed-sleep cycle as the core newborn model

Feeds are the strongest signal but we don't track them. The core newborn model
is wake-tolerance and recent-episode patterns. Feed data is a future
enhancement, not a design dependency.

### Age bands alone drive mode switching

Too brittle. A 10-week baby with strong evening consolidation should get
different treatment from a chaotic 10-week baby. Age is a prior, behaviour is
the decision signal.

### Three separate UI modes

Too expensive, too much to maintain. One adaptive UI with conditional
rendering achieves the same user experience with far less code.

### Coaching and milestones in early phases

Prove prediction usefulness first. Coaching text is high-value but should come
after the selector and engines are validated.

### Elaborate continuous structure score on N=3 babies

Overfitting the selector. Ship simple rules, collect data, refine.

---

## Implementation Plan

### Phase 0: Feature Extraction Refactor

Extract statistics from schedule.ts into `engine/features.ts`. Pure
refactoring — no behaviour change. Multi-baby backtest passes unchanged.

This unblocks everything else without risk.

### Phase 1: Constants Fix + Strategy Diagnostics

In parallel:

**1a.** Split 0–3mo wake window and nap count brackets into finer bands.
Add tests showing the current engine is less wrong for 0–8 weeks after this
change. Measurable via existing multi-baby backtest.

**1b.** Build `engine/strategy.ts`. Compute strategy signals and selection.
Log strategy per day in backtest output. **Do not change predictions.** Run
on baby_1's full 0–29mo trajectory and verify transitions look sensible.

### Phase 2: Prediction Contract + Emerging Engine

**2a.** Augment the `Prediction` type with `strategy` discriminant and
optional newborn/emerging fields. Route state assembly through the strategy
selector. When strategy = routine_schedule, the code path is identical to
today. **Zero regression risk.**

**2b.** Build `engine/emerging.ts`. The emerging engine reuses current schedule
logic where signals are strong, falls back to window/range predictions where
signals are weak. This is the lowest-risk second engine because it's an
adapter, not a rewrite.

**2c.** Minimal UI adaptation: soften labels ("neste lur truleg rundt
12:10–12:40"), hide bedtime when confidence is low, show ranges. Conditional
rendering in existing components.

**Why emerging before newborn**: It's closer to the current engine, the UI
delta is smaller, and it validates the architecture before the bigger newborn
changes.

### Phase 3: Newborn Engine + Adaptive UI

**3a.** Build `engine/newborn.ts`. Minimal: wake-window sleep window, pressure
level, duration range, 24h totals + Galland/SHINE norms, longest stretch
tracking.

**3b.** Add 24h Arc mode (full circle). Add `sleep-window` timer mode. Add
context card (total sleep, longest stretch, age norms). Hide bedtime section.

**3c.** New backtest metrics: sleep window hit rate, 24h total error, longest
stretch error. Test on baby_1 0–3mo, baby_3, baby_5.

### Phase 4: Transition Hygiene + Hysteresis

- 3-day minimum evidence for strategy transitions
- One-directional default (newborn → emerging → schedule)
- Regression only on sustained disruption (5+ days)
- Narrow lookback on promotion to routine_schedule (10 days)
- Manual override in settings
- Strategy stability metrics in backtest

### Phase 5: Newborn Dashboard + Guidance

- Fuller newborn-specific context display
- Longest stretch weekly trend chart
- Age-appropriate explanatory text (factual, not prescriptive)
- "Is this normal?" section with Galland/SHINE norms
- Only after selector stability is validated

### Phase 6: Feed Tracking

- "Fed" button, timestamp only
- Time-since-feed as sleep window signal
- Display in context card

---

## Validation Strategy

### Data we have

| Baby | Age range | Days | Quality | Use |
|------|-----------|------|---------|-----|
| halldis | 6–9mo | 87 | High (ground truth) | Regression guard for schedule mode |
| baby_1 | 0–29mo | 620 | Medium (Kaggle) | Full trajectory: validate selector transitions |
| baby_2 | 0–6mo | 55 | Low (noisy) | Smoke test newborn/emerging |
| baby_3 | 0–3mo | 51 | Low (noisy) | Smoke test newborn |
| baby_5 | 0–2mo | 9 | Very low (sparse) | Minimal smoke test |

### What to measure

1. **Selector sanity**: Run on baby_1's full trajectory. Do transition points
   align with developmental phases? Does the selector choose newborn at 0–2mo,
   emerging at 2–4mo, schedule at 5+mo? Eyeball it before automating.

2. **No regression**: Schedule-mode predictions on Halldis must not degrade.
   Existing regression guards in backtest.unit.ts protect this.

3. **Newborn improvement**: Sleep window hit rate on baby_1 0–3mo and baby_3
   should be > 50% (actual sleep started within predicted window). Low bar
   because the data is noisy.

4. **Emerging improvement**: Does the emerging engine beat the schedule engine
   on baby_1 3–6mo? Nap MAE and bedtime MAE should both improve.

### What we still need

- **Early Halldis data**: If Napper export data from 0–6 months is available,
  it would be our highest-quality newborn dataset.
- **Synthetic fixtures**: Generate realistic newborn patterns from SHINE/Galland
  population statistics for stress-testing the selector.
- **More real babies**: The architecture supports this, but validation quality
  is limited by N=3 noisy Kaggle datasets for the newborn phase.

---

## Risks

| Risk | Mitigation |
|------|------------|
| Regression on 5+ month babies | Strategy = routine_schedule is the exact current code path. Backtest guards protect. |
| Selector instability (flipping modes) | Hysteresis: 3-day minimum, one-directional default, manual override. |
| UI complexity explosion | One adaptive UI, not three modes. Conditional rendering. |
| Overfitting selector on N=3 noisy babies | Simple age-based rules with 2–3 data overrides. Continuous score later. |
| Bad logging masquerades as developmental chaos | Data-quality guard: loggingCompleteness check prevents low-data from triggering mode changes. |
| Newborn-phase data poisons schedule learning | Narrow lookback (10 days) on promotion to routine_schedule. |
| Constants fix creates false confidence | Explicitly tracked as tactical mitigation, not architecture solution. |
| Project scope creep | Gated phases with measurable exit criteria. Each phase must show improvement before next begins. |

---

## What This Unlocks Beyond Newborns

The strategy selector pattern has value past 6 months:

- **Illness/regression detection**: Structure score drops → widen confidence
  intervals, shift toward pressure-based predictions, re-engage habitual
  learning as patterns return.
- **Travel/timezone disruption**: Circadian anchor temporarily invalid →
  emerging mode until new rhythm establishes.
- **Per-baby feature adaptation**: The strategy selector is effectively a
  higher-level feature selector. The "dynamic feature selection" idea from the
  prediction refactor plan becomes a natural extension.
- **Routine building**: As patterns emerge in the emerging phase, the app can
  help parents establish a routine: "Your baby's morning nap has been
  consistent at ~09:15. Try to protect this window." Tracking → coaching.

---

## Open Questions

Resolve before implementation:

1. What loggingCompleteness threshold makes the selector abstain vs switch?
   (Propose: < 0.5 → stay in current mode, don't transition.)
2. How do we validate selector transitions without circular scoring? (Propose:
   eyeball baby_1 trajectory first, then define objective criteria.)
3. Should the newborn engine ignore persisted nap/night entirely, or
   downweight? (Propose: ignore for learning, keep for display.)
4. Can we import early Halldis data from Napper for validation?
5. What's the minimum viable emerging engine — just widen confidence intervals
   on the schedule engine's output, or a real adapter with per-element
   confidence?
