# Review of `newborn-strategy-report.md` and `under-6mo-prediction-report.md`

Authored 2026-04-03. Purpose: compare both reports, critique them adversarially, surface hidden assumptions, and produce a tighter combined direction.

## Bottom-Line Verdict

Both reports are directionally correct on the main point:

- the current predictor is not just poorly tuned for newborns
- it is built around the wrong top-level abstraction
- the app needs a higher-level strategy selector with different downstream prediction modes

That said, neither report should be taken as-is.

Claude's report is stronger on:

- quantitative motivation
- developmental phase framing
- immediate low-risk corrections
- product examples that feel concrete

My report is stronger on:

- actual repo architecture constraints
- why the current `Prediction` contract is the real bottleneck
- how to refactor without turning `schedule.ts` into a bigger blob
- where the UI/state seams actually are

The best outcome is not choosing one report. It is:

1. keep Claude's empirical framing and a few quick fixes
2. keep my architectural refactor direction
3. reject the weaker claims in both
4. narrow the project to a staged rollout with measurable gates

## Findings

### 1. Both reports are right that this is a strategy-selection problem, not only a tuning problem

This is the strongest shared conclusion and should be treated as the core decision.

The current stack is structurally schedule-first:

- [`src/lib/engine/schedule.ts`](/home/odin/Kode/miniapps/babysovelogg/src/lib/engine/schedule.ts)
- [`src/lib/engine/state.ts`](/home/odin/Kode/miniapps/babysovelogg/src/lib/engine/state.ts)
- [`src/lib/stores/app.svelte.ts`](/home/odin/Kode/miniapps/babysovelogg/src/lib/stores/app.svelte.ts)
- [`src/lib/timer-state.ts`](/home/odin/Kode/miniapps/babysovelogg/src/lib/timer-state.ts)
- [`src/routes/+page.svelte`](/home/odin/Kode/miniapps/babysovelogg/src/routes/+page.svelte)

So long as the app state assumes:

- `nextNap`
- `bedtime`
- `predictedNaps`
- `napsAllDone`

the rest of the app will keep forcing all babies into one worldview.

### 2. Claude's report is more useful as a product brief, but it overstates several scientific and product claims

Good:

- it makes the case with backtest numbers
- it identifies immediate constant problems for very young babies
- it gives a clearer name to the newborn-mode product job: not schedule prediction, but near-term guidance

Weak:

- it sometimes talks as if there "is no night" for newborns; that is too absolute
- it leans hard on a feed-sleep-cycle framing even though the app does not track feeds
- it proposes celebratory and coaching UI ideas before proving the selector and engines
- it implies more confidence in the phase boundaries than the repo data really supports

This matters because over-strong framing causes bad product decisions later.

### 3. My report is more correct on architecture, but it is too abstract in a few places

Good:

- it correctly identifies the `Prediction` union as the key enabler
- it avoids requiring a risky persistence-model rewrite
- it separates shared feature extraction from downstream engines
- it is realistic about UI branching by strategy

Weak:

- it does not include enough immediate low-risk improvements
- it is light on how to score strategy selection concretely
- it underplays the value of the existing multi-baby backtest as the decision gate
- it does not sharply prioritize "what should change this week" versus later phases

### 4. The biggest hidden assumption in both reports is that age-phase labels are stable enough to drive UX mode changes

This is the main thing to challenge.

Both reports say, in different ways:

- `0-2 months` or `0-6 weeks` is newborn mode
- `2-5 months` or `6 weeks-4 months` is emerging mode
- `5+ months` is schedule mode

That is reasonable as an initial prior. It is not good enough as a mode switch.

Problems:

- some babies consolidate earlier
- some babies remain highly irregular well beyond 5 months
- logged data quality can make a routine baby look chaotic
- one noisy week should not flip the entire UI mode

Conclusion:

- age should be a prior
- behavior should be the decision signal
- strategy changes need hysteresis and confidence thresholds

### 5. Both reports under-discuss the risk of bad logging contaminating strategy selection

This is a major hidden assumption.

The current engine already has logic around incomplete days and missing nights. For under-6-month babies, the logging problem is worse:

- newborn parents are more sleep deprived
- many short episodes are easy to miss
- the distinction between one long sleep and multiple interrupted fragments may be logged inconsistently

If the strategy selector is driven by:

- night/day ratio
- first nap consistency
- wake window SD
- complete day counts

then poor logging can masquerade as developmental chaos.

This means the selector must include explicit data-quality guards, not just behavioral signals.

### 6. Claude's "feed-sleep cycle" idea is directionally good but currently too dependent on missing data

This needs to be tightened.

The report says feed timing is the strongest predictor and suggests survival mode around a feed-sleep-cycle concept. That is plausible product thinking, but in this app today:

- feeds are not tracked
- adding feeds is not a small extension
- using feeds as a central conceptual model risks designing around unavailable input

Better formulation:

- newborn mode should be "recent wake tolerance + recent fragment pattern"
- feed timing is a future optional enhancer, not a phase-1 dependency

### 7. Claude is probably right that newborn constants should be corrected immediately

This is the strongest practical improvement missing from my report.

Current issues in [`src/lib/engine/constants.ts`](/home/odin/Kode/miniapps/babysovelogg/src/lib/engine/constants.ts):

- `0-3 months` wake window is a single `60-90 min` band
- `0-3 months` nap count defaults to `4`, range `3-5`

That is almost certainly too coarse for the earliest weeks, even if the larger architecture also needs to change.

Important caveat:

- this should be done as a tactical mitigation
- not as an attempt to make the current schedule engine "good enough" for newborns

### 8. My report is more right about not rewriting persisted nap/night semantics yet

Claude says forcing `nap` versus `night` onto newborns creates garbage in the data model. That is conceptually fair, but changing the persisted model now would be a mistake.

The app already depends on `nap` and `night` across:

- stats
- arc rendering
- timer state
- event projections
- tests

The better path is:

- keep persisted `nap`/`night`
- add derived strategy-level concepts such as `major_sleep_block`, `bedtime_like_block`, and `morning_anchor_wake`
- let the predictor use those derived concepts instead of relying only on persisted type

This is the cleaner migration path.

### 9. The full newborn UI should be treated as a later phase, not debated as a phase-1 dependency

Claude leans toward a more distinct newborn surface. My report also says the current arc may not be the right hero component. Both are directionally reasonable. The main implementation point is sequencing, not whether the richer UI should exist.

The right framing is:

- phase 1 should not depend on a large UI split
- later phases should absolutely allow a fuller newborn-specific UI
- the architecture should explicitly prepare for that split from the start

So the recommendation is not "avoid a full newborn UI". It is:

- make the state and engine model capable of supporting it
- ship the first engine changes with minimal UI branching
- add the full newborn UI as a dedicated later phase

### 10. Neither report is strong enough on rollout safety

This project can easily sprawl.

The correct sequencing is not:

1. invent three engines
2. invent three UIs
3. hope the selector works

It should be:

1. expose strategy signals and selector diagnostics
2. fix obvious newborn constants
3. add a minimal newborn/emerging prediction union to state
4. introduce one alternate engine with narrow scope
5. gate strategy switching with hysteresis
6. only then expand UI differentiation

## Hidden Assumptions To Reject

These are the claims that should not quietly survive into implementation.

### Reject: "There is no night for newborns"

Too absolute. Better:

- newborn day/night structure is weak and should not be over-trusted for prediction

### Reject: "Feed-sleep cycle should be the core newborn model"

Too dependent on data the app does not have. Better:

- wake-tolerance and fragment-pattern guidance should be the core
- feed data is optional future enrichment

### Reject: "Age bands are enough to drive automatic mode switching"

Too brittle. Better:

- age is a prior, not a decision

### Reject: "We need a brand-new UI mode first"

Too expensive early. Better:

- change prediction semantics first
- keep the dashboard shell stable while branching the center content
- plan the full newborn UI as a later explicit phase

### Reject: "The emerging strategy should already do coaching and milestones"

Too early. Better:

- prove prediction usefulness first
- add coaching text later

## Strongest Combined Direction

The best merged position is:

### 1. Add a strategy selector, but keep it narrow and explicit

Start with three modes:

- `newborn_guidance`
- `emerging_rhythm`
- `routine_schedule`

I would rename `survival` to `newborn_guidance`. It is a better product term and avoids sounding medical or alarming.

### 2. Change the prediction contract first

This is the highest-leverage architectural change.

Turn `Prediction` in [`src/lib/stores/app.svelte.ts`](/home/odin/Kode/miniapps/babysovelogg/src/lib/stores/app.svelte.ts) into a discriminated union. Without this, the rest of the project stays trapped.

### 3. Add a shared strategy-feature layer

Build derived signals once:

- days of usable data
- longest stretch length and start consistency
- percent of sleep in local-night hours
- wake-span distribution
- first substantial morning sleep consistency
- nap-count stability
- logging completeness / fragmentation quality

### 4. Implement the newborn engine as a minimal horizon predictor, not a full model

Phase-1 newborn engine should predict only:

- next likely sleep window
- current wake-pressure label
- expected current sleep end if sleeping

It should not try to solve:

- total 24h schedule
- feed-based modeling
- explicit bedtime
- full 24h generative simulation

### 5. Implement emerging mode as "partial schedule confidence", not a separate giant engine

This is where Claude's report is slightly too ambitious and mine is slightly too abstract.

Best combined approach:

- let emerging mode reuse current schedule logic where signals are strong
- use window/range outputs where signals are weak
- especially for early naps versus later naps

In other words, emerging mode should be a constrained adapter around the current schedule engine plus uncertainty logic, not a totally independent world.

### 6. Fix newborn constants now

Do this in parallel with selector diagnostics:

- split `0-3 months` wake windows into finer bands
- widen or raise newborn episode-count expectations appropriately

This is a cheap mitigation and a good falsifiable step.

### 7. Add hysteresis and manual override before broad UI switching

Strategy changes should require:

- enough usable data
- confidence above threshold
- more than one day of evidence

And the UI should allow:

- automatic mode
- manual override in settings for debugging and parent control

### 8. Plan for the full newborn UI as a real product phase

This should be an explicit later step, not an optional maybe.

That later phase can include:

- a fuller newborn-specific dashboard
- a 24-hour visual instead of the current day/night framing
- stronger emphasis on current wake state, next sleep window, total sleep, and longest stretch
- clearer phase-specific explanatory text

The important point is ordering:

- strategy semantics first
- fuller newborn UI after the selector and prediction contract are stable

## Practical Revised Plan

### Phase 0. Instrument and inspect

- add strategy signal computation only
- expose selector diagnostics in dev/test output
- do not change predictions yet

### Phase 1. Tactical newborn fixes

- update newborn constants
- add tests proving current engine is less wrong for `0-8 weeks`

### Phase 2. Prediction contract refactor

- convert app prediction shape to a discriminated union
- route state assembly through a new strategy entry point
- keep routine path behavior unchanged

### Phase 3. Minimal `newborn_guidance` mode

- predict only next sleep window and wake pressure
- add survival-style metrics such as window hit rate
- keep UI changes limited to timer center and prediction card copy

### Phase 4. `emerging_rhythm` mode

- mix schedule outputs and windows based on per-signal confidence
- add hysteresis and manual override

### Phase 5. Full newborn UI and coaching layer

- add the fuller newborn-specific dashboard and visual model
- expand strategy-specific explanation and coaching text
- only after selector stability and usefulness are validated

## Questions Both Reports Should Answer Better

These should be resolved before implementation starts in earnest.

1. What exact data-quality threshold makes the selector abstain instead of switching modes?
2. How many days of evidence are required before a strategy change is allowed?
3. What is the fallback UI when strategy confidence is low?
4. How do we validate selector correctness without circularly scoring it by its own assumptions?
5. How much of the current backtest harness can be reused unchanged, and where do we need genuinely new metrics?
6. Should the newborn engine ignore persisted `nap/night` entirely, or just downweight them?
7. How do we prevent the newborn constants change from misleading us into thinking the larger architecture problem is solved?

## Final Recommendation

If I had to compress both reports into one decision:

- approve the strategy-selector architecture
- approve a union-based prediction contract refactor
- approve immediate newborn constant fixes
- reject feed-dependent design as a phase-1 dependency
- include a full newborn-specific UI as a later planned phase
- do not make that UI a phase-1 dependency
- require selector diagnostics, hysteresis, and data-quality gating before automatic mode switching

That is the version that is both ambitious enough to solve the real problem and constrained enough to survive implementation.
