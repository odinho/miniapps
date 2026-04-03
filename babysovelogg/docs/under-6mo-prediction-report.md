# Under-6-Month Prediction Strategy Report

Authored 2026-04-03. Focus: how to make the app materially better for babies under 6 months without breaking the current strengths of the existing predictor.

## Executive Summary

The current system is already halfway to a multi-engine architecture, but it is expressed as one large schedule engine with feature flags and dynamic blending inside it. That works reasonably well for older babies with emerging routine. It is a poor top-level model for newborns.

The core problem is not just tuning. It is that the app currently assumes a single prediction shape:

- day starts with a wake-up
- the day contains a finite nap schedule
- the day ends with a meaningful bedtime
- overnight sleep can be modeled as a distinct night block

That is a decent fit for habitual babies with a real day/night structure. It is not a good fit for many babies in the `0-2 month` range, and it is only partially right for `2-5 months`.

The right direction is:

1. Introduce a higher-level `prediction strategy selector`.
2. Split the current engine into a `routine-oriented schedule engine`.
3. Add separate downstream engines for `newborn polyphasic` and `emerging circadian` phases.
4. Let the UI render different guidance modes based on the selected strategy instead of forcing all babies into `next nap / bedtime / night end`.

This should be treated as a major product project, not a small refactor.

## What The Current System Does Well

The current engine is stronger than a naive age-table approach and already contains useful ingredients we should keep:

- recency-weighted learning
- dynamic blending between pressure-based and habitual signals
- nap-count adaptation
- positional wake windows and nap durations
- habitual bedtime and wake anchoring
- confidence and calibration output

In practice, the current architecture is:

- one schedule engine in [`src/lib/engine/schedule.ts`](/home/odin/Kode/miniapps/babysovelogg/src/lib/engine/schedule.ts)
- one state assembly path in [`src/lib/engine/state.ts`](/home/odin/Kode/miniapps/babysovelogg/src/lib/engine/state.ts)
- one app prediction shape in [`src/lib/stores/app.svelte.ts`](/home/odin/Kode/miniapps/babysovelogg/src/lib/stores/app.svelte.ts)
- one dashboard/timer model centered on `Neste lur`, `Leggetid`, and `night` in [`src/routes/+page.svelte`](/home/odin/Kode/miniapps/babysovelogg/src/routes/+page.svelte) and [`src/lib/timer-state.ts`](/home/odin/Kode/miniapps/babysovelogg/src/lib/timer-state.ts)

This is a coherent design. The problem is that it encodes one developmental model.

## Where The Current Model Breaks Under 6 Months

### 1. The current predictor is schedule-first, but newborns are not schedule-first

The engine is built around:

- `predictNextNap`
- `predictDayNaps`
- `recommendBedtime`
- `predictNightEndTime`

That assumes the parent benefits from a projected daily schedule. For many `0-2 month` babies, the more useful question is not "when is bedtime?" but:

- is the baby likely approaching a sleep window soon
- how long has the baby been awake relative to recent tolerance
- are we in a generally sleepy part of the 24h cycle or not
- is today broadly fragmented or broadly consolidating

That is a different product.

### 2. Day/night classification is too structurally rigid

The current classification logic in [`src/lib/engine/classification.ts`](/home/odin/Kode/miniapps/babysovelogg/src/lib/engine/classification.ts) is hour-based with nap-quota disambiguation. That is reasonable for older babies, but it hard-codes a strong `nap` versus `night` worldview:

- before 06:00 or after 20:00 is night
- before 16:00 is nap
- late afternoon resolves via nap quota

That will misrepresent newborn sleep, where long evening and early-night stretches are often not meaningfully distinct from other sleep blocks in the same way they are at 6-10 months.

### 3. The UI assumes bedtime is always a central parent-facing concept

The timer and dashboard currently pivot between:

- next nap countdown
- overtime after missed nap
- bedtime countdown
- deep-night wake countdown

For `0-2 months`, this will often feel false precision. Worse, it can actively distort the parent mental model by implying that the baby should already be running on a stable day plan.

### 4. The state contract only supports one kind of prediction output

The `Prediction` object currently assumes this output schema:

- `nextNap`
- `bedtime`
- `predictedNaps`
- `napsAllDone`
- `expectedNapEnd`
- `expectedNightEnd`
- `confidence`
- `calibration`

That shape bakes schedule-mode into the app state. It makes it hard to express other useful outputs like:

- likely sleepy window in the next 30-90 min
- current routine maturity
- whether the baby currently behaves more polyphasically or more circadian
- alternate plans when the baby is in transition

## Product Principle For Under 6 Months

The app should not ask one engine to be universally smart. It should first decide what kind of sleep world the baby is currently in, then offer predictions and UI that match that world.

That means the higher-level concept should be:

## Proposed Architecture

### A. Add a top-level `strategy selector`

Introduce a small orchestration layer, for example:

- `src/lib/engine/strategy.ts`

This layer should:

- classify the baby into a prediction phase
- choose the downstream engine
- expose a normalized result for the UI
- expose the chosen strategy and rationale

Suggested strategies:

- `newborn_polyphasic`
- `emerging_circadian`
- `routine_schedule`
- later: `transition_split_schedule`

### B. Keep one shared feature-extraction layer

Do not duplicate all the sleep parsing and statistics logic inside each engine. Build a shared derived-feature layer once and reuse it.

Shared inputs/features should include:

- age in weeks and months
- recent sleep fragment distribution across 24h
- longest sleep stretch
- night-consolidation score
- stability of wake times
- stability of bedtime-like starts
- nap-count confidence
- frequency of feeds or diaper changes near wakes if available later
- number of complete days versus fragmented logging days

The existing cache work in [`src/lib/engine/schedule.ts`](/home/odin/Kode/miniapps/babysovelogg/src/lib/engine/schedule.ts) is a good starting point, but it should move conceptually from "schedule cache" to "sleep pattern features".

### C. Downstream engines should return different native outputs

Do not force every engine to think in `nextNap + bedtime`.

Instead, each engine should return:

- a common minimal shell for rendering
- a strategy-specific payload

For example:

```ts
type PredictionStrategy =
  | "newborn_polyphasic"
  | "emerging_circadian"
  | "routine_schedule";

interface StrategySelection {
  strategy: PredictionStrategy;
  confidence: "low" | "medium" | "high";
  reasons: string[];
}

interface BasePrediction {
  strategy: PredictionStrategy;
  selection: StrategySelection;
  confidence: ConfidenceResult | null;
  calibration: CalibrationReport | null;
}

interface NewbornPrediction extends BasePrediction {
  strategy: "newborn_polyphasic";
  nextSleepWindow: { start: string; end: string } | null;
  likelySleepPressure: "low" | "rising" | "high";
  expectedCurrentSleepEnd: string | null;
  overnightView: null;
}

interface EmergingCircadianPrediction extends BasePrediction {
  strategy: "emerging_circadian";
  nextNap: string | null;
  nextSleepWindow: { start: string; end: string } | null;
  probableEveningSleepWindow: { start: string; end: string } | null;
  expectedCurrentSleepEnd: string | null;
}

interface RoutinePrediction extends BasePrediction {
  strategy: "routine_schedule";
  nextNap: string;
  bedtime: string;
  predictedNaps: PredictedNap[] | null;
  expectedNapEnd: string | null;
  expectedNightEnd: string | null;
}
```

This is the key architectural move. The current `Prediction` type should become a union, not a single rigid object.

## Proposed Strategy Selector

Use age as a strong prior, but not the only input.

### Phase bands

- `0-2 months`: default strongly toward `newborn_polyphasic`
- `2-5 months`: default toward `emerging_circadian`
- `5+ months`: default toward `routine_schedule`

But allow behavior to override age at the margins.

### Suggested selection features

Build a `routine maturity score` and a `circadian consolidation score`.

Candidate signals:

- longest sleep stretch in past 7 days
- fraction of total sleep occurring in local night hours
- standard deviation of wake-up time
- standard deviation of first substantial morning wake
- consistency of evening long-sleep onset
- proportion of days where a meaningful bedtime-like block exists
- proportion of complete days with a stable nap count
- amount of missing/incomplete data

The selector can then use simple rule-based thresholds:

- very low consolidation + age under 10 weeks => `newborn_polyphasic`
- moderate consolidation but unstable nap schedule => `emerging_circadian`
- clear wake/nap/bedtime regularity => `routine_schedule`

This should remain explicit and interpretable. No ML is needed.

## Downstream Engine Design

### 1. `newborn_polyphasic` engine

This engine should answer a different parent question: "What is useful right now?" rather than "What is the schedule for today?"

#### What it should predict

- next likely sleep window, not exact next nap time
- current wake-pressure level
- likely end of the current sleep if actively sleeping
- broad overnight expectation, not a precise wake time

#### What it should not emphasize

- bedtime countdown
- full day nap schedule
- `naps all done`
- hard nap versus night separation

#### Modeling approach

Inputs:

- recent wake durations, weighted heavily by recency
- age prior in weeks
- time-of-day as a weak modifier, not a hard partition
- whether recent sleep has shown emerging evening consolidation

Outputs:

- `nextSleepWindowStart = now + lower-bound wake tolerance`
- `nextSleepWindowEnd = now + upper-bound wake tolerance`
- `likelySleepPressure` derived from current wake duration versus recent tolerated wake spans

This is still explainable and deterministic. It is just not schedule-shaped.

#### Product behavior

The UI should say things like:

- `Truleg søvnvindauge snart`
- `Vaken ei stund no`
- `I denne fasen er søvnen ofte ujamn gjennom døgnet`

That is more honest and more useful than fake bedtime precision.

### 2. `emerging_circadian` engine

This is the bridge engine for roughly `2-5 months`.

The important product job here is not perfect schedule prediction. It is helping parents notice and gently shape an emerging rhythm.

#### What it should predict

- next likely nap or sleep window
- probable evening sleep window instead of hard bedtime
- current sleep-end estimate
- routine-strength indicators

#### Modeling approach

Blend:

- wake-pressure model
- early circadian signal
- consistency scoring

This engine should tolerate ambiguity directly. It can say:

- `Neste lur truleg rundt 12:10-12:40`
- `Kveldsøvn truleg mellom 19:30 og 21:00`

This is better than pretending the family already has a firm bedtime.

#### Key difference from current engine

The current engine tries to infer a complete daily schedule and then trims it. The emerging-circadian engine should predict only the next useful horizon plus a soft evening outlook.

### 3. `routine_schedule` engine

This is effectively the current engine, with refactoring rather than replacement.

It should remain the default for babies with:

- meaningful wake-up anchor
- stable nap count
- stable bedtime-like block
- enough complete days

The current feature-blended logic remains valuable here.

## UI Strategy By Phase

The UI should reflect the selected strategy, not just the age.

### A. `newborn_polyphasic` UI

Dashboard should shift from schedule view to guidance view.

Primary card:

- current awake time
- likely sleep window soon
- pressure label: `låg`, `stigande`, `høg`

Secondary guidance:

- expected range for current sleep end if sleeping
- note that day/night rhythm is still developing
- gentle education, not correction

Arc/timer implications:

- the current day/night arc is not the right hero component
- either simplify it heavily or replace it for this strategy
- bedtime labels should disappear

### B. `emerging_circadian` UI

Hybrid view.

Primary card:

- next likely nap window
- probable evening sleep window

Secondary card:

- rhythm maturity indicator
- consistency trend over the last 7-14 days

Arc/timer implications:

- keep the timer concept
- replace hard `Leggetid om` with softer evening guidance when confidence is low

### C. `routine_schedule` UI

Current dashboard mostly stays.

This lets the product grow without destabilizing what already works for older babies.

## Classification Changes Needed

The current `nap` versus `night` classification should stop being the only conceptual backbone for prediction.

Recommended change:

1. Keep persisted sleep records as `nap` and `night` for now, because the rest of the app already uses that schema.
2. Add derived concepts used only by the strategy layer:
   - `major_sleep_block`
   - `sleep_fragment`
   - `bedtime_like_block`
   - `morning_anchor_wake`
3. For `0-2 months`, prediction logic should rely more on these derived concepts than on the raw `nap/night` split.

This avoids a risky data-model rewrite while still escaping the current conceptual trap.

## Data And State Model Changes

### 1. Replace the single `Prediction` shape with a discriminated union

File affected first:

- [`src/lib/stores/app.svelte.ts`](/home/odin/Kode/miniapps/babysovelogg/src/lib/stores/app.svelte.ts)

This is the main enabler for strategy-specific UI.

### 2. Insert a strategy layer into state assembly

File affected first:

- [`src/lib/engine/state.ts`](/home/odin/Kode/miniapps/babysovelogg/src/lib/engine/state.ts)

Instead of directly calling schedule functions, state assembly should:

- build shared features/context
- select strategy
- run the chosen engine
- return the strategy-specific prediction payload

### 3. Split `schedule.ts`

Recommended target structure:

- `engine/features.ts` or `engine/patterns.ts`
- `engine/strategy.ts`
- `engine/engines/routine-schedule.ts`
- `engine/engines/newborn-polyphasic.ts`
- `engine/engines/emerging-circadian.ts`

This is better than making `schedule.ts` even more branch-heavy.

## Metrics We Should Add

The current backtest work is good, but under-6-month success will need different metrics.

### For `newborn_polyphasic`

- sleep-window hit rate
- proportion of actual sleeps that begin within predicted window
- calibration of pressure labels
- parent-useful horizon metric: was the guidance right within 30-60 minutes

### For `emerging_circadian`

- next-sleep-window MAE
- evening-window hit rate
- routine-maturity classification stability

### For strategy selection itself

- strategy chosen per day over time
- how often strategy flips
- whether flips align with visible consolidation changes

Avoid a selector that thrashes between modes day to day. Add hysteresis.

## Practical Implementation Plan

### Phase 1. Make strategy selection visible without changing behavior

Goal: no product risk.

- add shared feature extraction
- add `strategy.ts`
- compute and expose selected strategy using current data
- keep using the current routine schedule engine for actual predictions
- log or render strategy internally for inspection

This gives us a safe diagnostic phase.

### Phase 2. Introduce `emerging_circadian` engine

Do this before newborn mode. It is closer to the current model and will validate the architecture with less UI upheaval.

- add soft next-window predictions
- add evening-window instead of hard bedtime where appropriate
- update timer/dashboard to branch on strategy
- keep the old schedule UI for `routine_schedule`

### Phase 3. Introduce `newborn_polyphasic` engine and newborn UI

- remove bedtime-first framing in newborn mode
- center awake time plus likely sleep window
- hide or substantially simplify the current day/night arc
- keep active-sleep end estimates if they are useful

### Phase 4. Improve classification and metrics

- derive `major_sleep_block` and `bedtime_like_block`
- add newborn/emerging backtests
- add transition hysteresis and confidence thresholds for strategy changes

## Risks

### 1. Overfitting age bands

Age should guide strategy choice, but behavior must matter. A 10-week baby with unusually strong evening consolidation should not be treated identically to a chaotic 10-week baby.

### 2. UI complexity explosion

Do not build three totally separate apps. Use one shell with strategy-specific center content and prediction cards.

### 3. Selector instability

If the strategy changes too often, parents will lose trust. Use:

- minimum evidence thresholds
- confidence levels
- hysteresis before switching modes

### 4. Too much precision in newborn mode

Do not replace fake bedtime precision with fake sleep-window precision. Newborn outputs should remain ranges, not exact timestamps, unless confidence is unusually high.

## Recommended Decisions

If we want the app to become genuinely strong for babies under 6 months, I recommend these concrete decisions now:

1. Commit to a multi-engine architecture with a strategy selector.
2. Treat the current engine as the `routine_schedule` engine, not the universal engine.
3. Build `emerging_circadian` before `newborn_polyphasic`.
4. Change the prediction state shape into a discriminated union.
5. Let UI differ by strategy, especially removing `bedtime-first` framing in newborn mode.
6. Add strategy metrics and hysteresis before enabling automatic switching broadly.

## Bottom Line

Yes, this should become a higher-level concept with downstream engines.

The current dynamic blending between habitual and chaotic is useful, but it is operating too far down in the stack. For babies under 6 months, the main issue is often not "which weights should this predictor use?" but "which kind of predictor should be active at all?"

If the app chooses the right prediction mode first, then the existing work on blending, confidence, and adaptation becomes much more valuable. That is the path to making the app truly helpful in the newborn phase and then genuinely useful as parents work toward a stable routine.
