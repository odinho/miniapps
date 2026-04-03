# Under-6-Month Strategy: Adversarial Review & Synthesis

Authored 2026-04-03. Compares `newborn-strategy-report.md` (Claude) and
`under-6mo-prediction-report.md` (Codex), critiques both, and produces a
stronger combined plan.

---

## Where Both Reports Agree

The diagnosis is nearly identical:

1. The engine assumes day/night structure with positional naps — newborns don't
   have this.
2. A strategy selector should choose between fundamentally different prediction
   modes.
3. Three strategies: polyphasic/survival, emerging/bridge, schedule (current).
4. The selector should be data-driven (not pure age gating).
5. The UI must change per strategy — bedtime countdowns are wrong for newborns.
6. The existing engine becomes the "schedule" strategy, largely unchanged.
7. No ML. Keep it explainable and deterministic.

This convergence is reassuring. The core direction is sound.

---

## Where They Diverge

### 1. Implementation Order

**Claude**: Survival (newborn) first → Emerging → UI.
**Codex**: Selector diagnostic first → Emerging engine → Newborn engine + UI.

**Codex is right here.** Building emerging first is lower-risk: it's closer to
the current engine (add soft windowing to existing schedule predictions), the
UI delta is smaller (soften labels, widen ranges), and it validates the
architecture before the bigger newborn UI rewrite. Starting with newborn mode
means building the most different engine AND the most different UI
simultaneously with the least data to validate against.

The diagnostic-first phase (run selector, log it, don't change behavior) is
also smart. It lets us see if the selector makes sensible decisions on baby_1's
0–29mo trajectory before we ship anything.

### 2. Prediction Type Design

**Claude**: Mentions union type in passing, doesn't spec it.
**Codex**: Full discriminated union with `NewbornPrediction |
EmergingCircadianPrediction | RoutinePrediction`, each with strategy-specific
fields.

**Codex's approach is architecturally cleaner** and pays off immediately in the
UI (TypeScript narrows the type, each component gets exactly its fields). But
it has a cost: every consumer of `Prediction` needs to handle three cases. The
timer-state, arc-utils, and page.svelte all pattern-match on prediction fields
today.

**Pragmatic middle ground**: Start with the existing `Prediction` interface
augmented with optional strategy-specific fields and a `strategy` discriminant.
Migrate to the full union in phase 2 when we actually have two engines running.
Premature type splitting before the second engine exists just creates dead code
branches.

### 3. Classification / Derived Concepts

**Claude**: Keep nap/night classification, add `classifySleepForSurvival()`.
**Codex**: Add derived concepts (`major_sleep_block`, `bedtime_like_block`,
`morning_anchor_wake`) alongside the existing nap/night types.

**Both are partially right.** The derived concepts are useful for the
*selector* (detecting structure emergence) but shouldn't leak into the data
model or the sleep log. They belong in the feature-extraction layer, not the
classification layer. The nap/night classification stays for storage and
display; derived concepts live in the strategy selector's input.

### 4. Shared Feature Extraction

**Codex** is stronger here — explicitly proposes factoring out `features.ts`
or `patterns.ts` from schedule.ts. **Claude** acknowledges existing signals
can be reused but doesn't propose refactoring them into a shared layer.

**Codex is right.** The cache and statistic computations in schedule.ts (wake
window SD, nap count stability, bedtime consistency) are already general. They
should be available to the selector and all engines without importing from
schedule.ts. This is a meaningful refactor but avoids duplication.

### 5. Hysteresis

**Codex** explicitly calls out the need for hysteresis in strategy transitions
(don't flip modes day-to-day). **Claude** doesn't mention this at all.

**This is important and Claude's report missed it.** A selector that flips
between "emerging" and "schedule" on alternating days would be worse than no
selector. Strategy transitions should require sustained evidence (e.g., 3+ days
of consistent signal) and ideally be one-directional during normal development
(survival → emerging → schedule), with regression only on clear disruption
signals.

### 6. File Structure

**Claude**: New files `survival.ts`, `emerging.ts`.
**Codex**: `engine/engines/routine-schedule.ts`, `engine/engines/newborn-polyphasic.ts`, `engine/engines/emerging-circadian.ts` plus `engine/features.ts` and `engine/strategy.ts`.

Codex's structure is cleaner but maybe premature. The current engine is one
~1100-line file that works. We don't need three engine files until we have
three engines. Start with `strategy.ts` + `features.ts`, and keep new engine
code in `survival.ts` / `emerging.ts` alongside schedule.ts. If it grows
unwieldy, refactor to subdirs.

---

## Hidden Assumptions Both Reports Share (And Whether They Hold)

### Assumption 1: "Newborns need a fundamentally different predictor"

Both reports take this as given. But **scrutinize it**: the survival-mode
predictor is essentially "wake window + recent average duration" — which is
exactly what the schedule engine already does when it has <4 sleeps and all
features are off. The "survival engine" is the schedule engine's cold-start
fallback, rebranded.

**The real issue is the UI, not the math.** What breaks for newborns is:
- Showing "Neste lur 10:30" when no such precision exists
- Showing bedtime countdowns when there's no bedtime
- Forcing a 12h day/night split on polyphasic sleep
- The nap count framework (nap 1, nap 2, ...) when episodes are interchangeable

A simpler path might be: **keep one engine, change the UI presentation based
on the structure score.** When structure is low, show wake-window ranges
instead of point predictions. When structure is high, show the full schedule.

**Counter-argument**: The schedule engine's prediction pipeline (resolveNapCount
→ predictDayNaps → recommendBedtime) imposes assumptions even internally. It
tries to predict "nap 3 of 3" for a baby with 6 irregular sleeps. The
predictions are wrong before the UI even sees them. So yes, the predictor does
need to differ — but perhaps less than both reports suggest. The survival
engine may be just a thin wrapper that calls `getWakeWindow()` and
`getLearnedNapDuration()` and skips the scheduling logic.

**Verdict**: The predictor needs to differ, but it should be thin. The heavy
lift is the UI and the feature extraction, not the prediction math itself.

### Assumption 2: "The strategy selector should be continuous/score-based"

Both propose a numerical structure score or maturity score. This sounds elegant
but has a practical problem: **we have no ground truth for what the score
"should" be at any given point.** We can compute SD of wake times for baby_1 at
2 months, but we don't know whether that SD means "survival" or "emerging."

The thresholds will be tuned on gut feel or ~3 noisy Kaggle babies. That's
not much better than age gating.

**Better approach**: Start with age as the strong default. Add data-quality
overrides for clear cases (e.g., a 3-month-old with >70% night sleep and
consistent 1st nap → promote to emerging). Don't try to compute a smooth score
until we have enough babies to validate the score against outcomes.

The score concept is right for later. But shipping a score-based selector on
N=3 noisy datasets is overfitting the selector, which is ironic given that
both reports warn against overfitting the engine.

### Assumption 3: "Three distinct UI modes are needed"

This risks a complexity explosion. Three UIs means three sets of components to
build, test, and maintain. Both reports acknowledge this risk but still
propose three modes.

**Challenge**: Could we get 80% of the value with a single adaptive UI?
- Arc shows 24h when structure is low, transitions to 12h+12h when structure
  is high (parameterize `arcStartHour/arcEndHour`)
- Timer shows "sleep window in ~X min" when structure is low, "nap at HH:MM"
  when high
- Bedtime section appears/disappears based on whether we have a bedtime signal
- All of this is conditional rendering in the existing components, not separate
  component trees

**Verdict**: Start with one adaptive UI that degrades gracefully, not three
separate modes. The strategy field still exists in the data (engines still
differ), but the UI reads `prediction.strategy` and adjusts rendering, not
switches to a completely different page layout.

### Assumption 4: "The existing data model is fine"

Both reports say "keep the data model, change the interpretation." But there's
a hidden issue: **newborn sleep episodes don't map cleanly to the SleepLogRow
nap/night classification.** A newborn's 3-hour sleep starting at 17:00 — is it
a nap or night? The current classifier says nap (h < 18). But if the baby
sleeps 17:00–20:00, wakes to feed, then sleeps 20:30–01:00, the parent
experiences these as the start of "night" with a feed wake.

The nap/night label is forced at log time and can't be revised without a
manual edit. For newborns, this creates noisy training data: the "night" label
gets applied inconsistently, and the engine's night-duration learning is
poisoned.

**Mitigation**: For strategy = survival/emerging, **don't use the nap/night
label for learning at all.** Treat all sleep episodes as undifferentiated.
Learn wake windows and durations from all episodes regardless of label. The
label is for the parent's display only.

### Assumption 5: "Feed tracking would help but is out of scope"

Both reports mention it; neither commits. But this might be the highest-ROI
thing for newborn prediction accuracy.

**Why feeds matter**: A newborn's sleep timing is dominated by hunger/satiation
cycles. A baby who just completed a full feed is much more likely to sleep
within 15–30 minutes than one who snacked. The wake window is really a
post-feed window.

**Minimal viable version**: Don't build a full feed tracker. Just add a "fed"
button on the active-wake screen. Record timestamp only (not duration, not
breast/bottle). Use the time-since-last-feed as an additional signal in the
survival engine's sleep-window prediction.

This is a small data model change (one optional `last_feed_time` field on
DayStartRow or a separate minimal table) and a single button in the UI.
**High value for low cost**, and it only applies in survival/emerging mode.

### Assumption 6: "The Arc visualization is the right container"

Both reports discuss adapting the Arc. But the Arc is a 270-degree half-day
visualization built around the concept of "day starts at wake, ends at
bedtime." For newborns, there IS no day start or bedtime.

A 24h Arc is possible (just make it 360 degrees / full circle) but it becomes
a very different component — closer to a clock face. At that point you're
not parameterizing the Arc, you're building a new viz.

**Alternative for survival mode**: A simple **horizontal timeline** showing
the last 12–24 hours of sleep episodes as colored bars. This is:
- Easier to build than adapting the Arc
- More intuitive for newborn parents (linear time, not circular)
- Better at showing patterns (consecutive episodes are visually adjacent)
- Easy to scroll back to see "is the longest stretch growing?"

The Arc comes back in emerging/schedule mode where the circular day metaphor
makes sense.

---

## What Both Reports Miss Entirely

### 1. Cold-start when transitioning strategies

When the selector promotes a baby from survival → emerging → schedule, what
happens to the data? The schedule engine's learning functions
(getLearnedNapCount, getLearnedBedtimeWakeWindow, etc.) will include data from
the newborn phase that doesn't match the schedule model. Those 2-month-old
random wake windows will pollute the learned wake window for months due to the
lookback window.

**Fix**: Strategy transitions should reset or narrow the learning lookback.
When entering schedule mode, only use data from the last N days (where N is
small enough that most data is from the current phase). Or apply a strategy
tag to historical data and filter by it.

This is architecturally important and neither report addresses it.

### 2. Multi-baby validation strategy

Both reports note that we have sparse, noisy data for young babies. Neither
proposes a concrete plan for getting more/better data.

Options:
- **Halldis historical**: Halldis's fixture starts at 6 months. But Odin has
  Napper data from earlier months. If importable, this is the highest-quality
  newborn data we could have.
- **Synthetic fixtures**: Generate realistic newborn sleep patterns from
  SHINE/Galland population statistics. Not ideal but useful for stress-testing
  the selector and survival engine.
- **baby_1 deep dive**: baby_1 has 620 days spanning 0–29 months. Despite
  being Kaggle data, it's the best trajectory we have. Worth a per-month
  breakdown of what the selector WOULD have chosen and whether it seems right.

### 3. What "helpful" means for newborn parents

Both reports focus on prediction accuracy. But the biggest product win for
newborn parents might not be better predictions — it might be **normalization
and reassurance.**

A newborn parent at 3:00 doesn't need to know "next sleep in 45 minutes."
They need to know "this is normal. Your baby has slept 14.2 hours in the last
24h, which is right in the middle of the normal range. The longest stretch was
3.5 hours, which is typical for 4 weeks."

The survival engine's most valuable output might be **context**, not
**prediction**: total sleep tracking, developmental milestones ("longest
stretch is growing!"), and age-appropriate norms from Galland/SHINE.

### 4. The partner/co-parent use case

During the newborn phase, parents often split shifts (one sleeps 20:00–02:00,
the other 02:00–08:00). The app could show "your baby last slept X ago,
usually sleeps Y minutes at this time of day" — purely informational — and
that would be enormously helpful for the parent who just woke up to a crying
baby without context.

This doesn't need prediction at all. It's just good state display. But it's
high-value for newborn families and neither report mentions it.

---

## Revised Implementation Plan

Incorporating the best of both reports and the critiques above:

### Phase 0: Feature Extraction Refactor (Foundation)

Extract the statistics/pattern-detection code from schedule.ts into
`engine/features.ts`:
- Wake window distribution (mean, SD) from cache
- Nap count distribution and stability
- Bedtime/wake time consistency metrics
- Night-day sleep ratio
- Longest sleep stretch tracking
- Per-position nap start consistency

This is purely mechanical refactoring. No behavior change. schedule.ts calls
into features.ts instead of computing inline.

**Validates**: Nothing breaks. Multi-baby backtest passes unchanged.

### Phase 1: Strategy Selector (Diagnostic Only)

Build `engine/strategy.ts`:
- Computes a strategy recommendation from features + age
- Initial rules: age < 6 weeks → survival, age > 5 months → schedule,
  between → emerging. Override to schedule if night-day ratio > 0.6 AND first
  nap SD < 30 min AND age > 10 weeks.
- Logs strategy + reasons to the prediction output
- **Does not change predictions.** The schedule engine still runs for everyone.
- Add strategy to backtest output so we can see what it would have chosen for
  baby_1 at each month.

**Validates**: Strategy choices look sensible on baby_1's trajectory. No
regression.

### Phase 2: Adaptive UI (Single UI, Strategy-Aware)

Don't build three UIs. Make the existing UI adaptive:
- `timer-state.ts`: Add `kind: 'sleep-window'` mode (shows range, not
  countdown) when strategy !== 'schedule'
- Arc: Add 24h mode (full-circle option) for survival strategy. Keep 12h arcs
  for emerging/schedule.
- Hide bedtime section when strategy === 'survival'
- Show "sleep window" instead of "next nap" when strategy !== 'schedule'
- Add a context card showing total sleep, longest stretch, age norms
- Emerging mode: show predictions with explicit ranges ("~12:10–12:40")

This is conditional rendering, not separate components.

### Phase 3: Survival Engine

Build `engine/survival.ts`:
- Minimal: wake-window-based sleep window prediction (no nap positions, no
  bedtime, no day schedule)
- Expected duration as a range from recent episodes
- Longest stretch tracker (current value + 7-day trend)
- Total 24h sleep vs Galland norms
- Wire into state.ts: when strategy === 'survival', call survival engine
  instead of schedule engine

**Backtest**: New survival-mode metrics (sleep window hit rate). Test on
baby_1 0–3mo, baby_3, baby_5.

### Phase 4: Emerging Engine

Build `engine/emerging.ts`:
- Blend of survival (for uncertain nap positions) and schedule (for consistent
  ones)
- Soft bedtime window instead of point prediction
- Structure-strength indicator for each element ("morning nap: consistent,
  afternoon nap: still variable")
- Wire into state.ts for strategy === 'emerging'

**Backtest**: Test on baby_1 3–6mo, baby_2. Measure: does emerging engine beat
the schedule engine on these months?

### Phase 5: Transition Hygiene

- Add hysteresis to strategy transitions (require 3+ consecutive days of
  qualifying signal before promoting)
- Strategy transitions are one-directional by default (survival → emerging →
  schedule), with regression only on explicit disruption signals (structure
  score drops below threshold for 5+ days)
- When transitioning to schedule mode, narrow the lookback to data from the
  last 10 days (avoid poisoning from newborn-phase data)
- Tag historical predictions with strategy so the backtest can measure
  per-strategy accuracy

### Phase 6: Feed Tracking (Optional, High-Impact)

- Add a "fed" button to the wake screen (survival/emerging modes only)
- Store as `feed_time` in day_starts or a simple `feeds` table
- Use time-since-feed as an additional signal in survival engine sleep window
  estimation
- Display: "last fed X minutes ago" in the context card

### Phase 7: Newborn Guidance Content

- Age-appropriate norms from Galland/SHINE shown in context cards
- "Is this normal?" section for common newborn concerns
- Developmental milestones: "Longest stretch growing!", "Circadian rhythm
  emerging!"
- Gentle, factual, not prescriptive. No medical advice.

---

## Concrete Decisions

Based on this analysis, the recommended decisions are:

1. **Yes, multi-engine architecture with strategy selector.** Both reports
   agree; the critique reinforces it but with a thinner survival engine than
   either proposed.

2. **Build emerging before survival.** (Codex's ordering.) It validates the
   architecture with lower risk and smaller UI delta.

3. **Start with age-based selector, add data overrides later.** Don't
   over-engineer the score on N=3 babies. Ship simple rules, collect data,
   refine.

4. **One adaptive UI, not three separate modes.** Conditional rendering
   within the existing components, driven by `prediction.strategy`.

5. **Prediction type**: Augment the existing `Prediction` interface with a
   `strategy` discriminant and optional strategy-specific fields. Migrate to a
   full discriminated union only when we have two engines shipping.

6. **Add hysteresis to strategy transitions.** 3-day minimum, one-directional
   by default.

7. **Don't learn nap/night separately in survival mode.** Treat all episodes
   as undifferentiated sleep for learning purposes.

8. **Narrow lookback on strategy promotion.** When entering schedule mode,
   don't let newborn-phase data poison learned parameters.

9. **Extract features.ts from schedule.ts as Phase 0.** Unblocks everything
   else.

10. **Feed tracking as Phase 6.** Highest ROI for newborn prediction accuracy,
    but not on the critical path.

---

## What NOT To Do

- **Don't build a fancy structure score before we have data to validate it.**
  Both reports have elaborate score formulas with arbitrary thresholds. Ship
  simple age-based rules with 2–3 data overrides. Iterate.

- **Don't refactor schedule.ts into three engine files prematurely.** Wait
  until the second engine actually exists.

- **Don't pursue Phase 4 cycle modeling (from prediction-refactor-plan.md)
  until the strategy architecture is in place.** Cycle-based duration modeling
  is a Phase D improvement; it doesn't help if we're still forcing newborns
  into the schedule model.

- **Don't add derived classification types (major_sleep_block etc.) to the
  data model.** Compute them in the feature layer, use them in the selector,
  but don't persist them. They're analytical lenses, not record types.

- **Don't optimize for Kaggle babies 2/3/5.** The data is too noisy and short.
  Use them for smoke-testing, not for tuning.

---

## Summary Table: What Each Report Got Right

| Aspect | Claude | Codex | Synthesis |
|--------|--------|-------|-----------|
| Core diagnosis | Yes | Yes | Agreed |
| Three strategies | Yes | Yes | Agreed |
| Implementation order | Wrong (survival first) | Right (emerging first) | Emerging first |
| Prediction types | Underspecified | Good union design | Incremental: augment → union |
| Selector design | Elaborate score | Rule-based + signals | Simple age rules + overrides |
| Hysteresis | Missing | Explicit | Adopt from Codex |
| Shared features layer | Implicit | Explicit | Adopt from Codex |
| UI approach | Three separate modes | Three modes | One adaptive UI |
| Classification | Minor change | Derived concepts | Feature-layer only |
| Cold-start on transition | Missing | Missing | Added: narrow lookback |
| Feed tracking | Mentioned, deferred | Not mentioned | Phase 6, minimal |
| Parent context/norms | In survival output | Not emphasized | Promoted to core value |
| Co-parent use case | Missing | Missing | Added |
| Validation strategy | Baby_1 mentioned | General | baby_1 trajectory analysis required |
| File structure | Two new files | Engine subdirectory | Start simple, grow |
