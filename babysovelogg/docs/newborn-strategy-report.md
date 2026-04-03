# Making babysovelogg Work for 0–6 Month Babies

Report authored 2026-04-03. Based on analysis of the current prediction engine,
research in `sleep-science-research.md`, backtest results on 6 babies across
0–29 months, and the Galland/SHINE normative datasets.

---

## The Problem, Quantified

The engine performs well from ~7 months onward (44 min nap MAE on Halldis at
7–9mo, 18–66 min on baby_1 at 8–17mo). Below 6 months, it falls apart:

| Baby | Age range | Nap MAE | Count acc. | Wake MAE | Notes |
|------|-----------|---------|------------|----------|-------|
| baby_1 | 0–3mo | 570 min | ~25% | extreme | Polyphasic, no circadian |
| baby_1 | 4–6mo | 200–300 min | ~35% | extreme | Transitioning to rhythm |
| baby_2 | 0–6mo | 105 min | 40% | 474 min | Short dataset |
| baby_3 | 0–3mo | 244 min | 19% | 471 min | Pure newborn |

The fundamental issue: **the engine assumes a day/night structure with
predictable naps at learned positions.** Before ~4 months, babies don't have
this structure. We're forcing a 2-nap/3-nap prediction framework onto a baby
that sleeps 6–8 times per day in irregular bursts.

---

## Why the Current Engine Fails Early

### 1. The night/day split is wrong for newborns

The Arc UI shows day (06–18) and night (18–06). Classification treats sleep
after 20:00 as "night." For a newborn, there IS no night — just polyphasic
sleep episodes of 1.5–4h separated by feeds. The 2-week-old sleeps roughly
equally across the 24h clock. Forcing "nap" vs "night" labels onto this
creates garbage in the data model.

### 2. Circadian features activate too late — but the gap isn't just features

`habitualNapStart` is gated at ≥5mo, `habitualBedtime` and `habitualWake` have
no age gate but need consistent data that doesn't exist yet. The real issue is
that ALL the engine's learning signals assume a repeating daily structure: 
nap-count learning needs consistent days, positional wake windows need 
consistent positions, bedtime learning needs a consistent bedtime.

### 3. Wake window defaults are too narrow for 0–4 weeks

The current `WAKE_WINDOWS` starts at 60–90 min for 0–3mo. Research says
0–4 week babies have 30–60 min wake windows. A newborn that's been awake 45
minutes is overtired; the engine wouldn't suggest a nap until 75 minutes.

### 4. Nap count is wildly variable and high

`NAP_COUNTS` says 4 naps (range 3–5) for 0–3mo. But newborns commonly have
6–8 sleep episodes per day. The engine caps predictions at the expected count
and calls additional sleeps aberrations.

---

## The Developmental Phases (What the Science Says)

Based on the research summary and SHINE/Galland data, sleep development has
distinct phases with fundamentally different characteristics:

### Phase A: Polyphasic / No Circadian (0–6 weeks)

- **No endogenous melatonin** — sleep distributed evenly across 24 hours
- **50-minute sleep cycles** starting in Active (REM) sleep
- **Sleep episodes**: 1.5–4 hours, separated by 30–60 min wake/feed
- **Total sleep**: ~14.6h/24h (Galland), with enormous variance (9.3–20.0h)
- **Night wakings**: 1.7/night mean (Galland), but "night" itself is artificial
- **What's predictable**: Almost nothing on a per-episode basis. The wake window
  (30–60 min) is the only useful signal. A feed-and-sleep cycle is more
  meaningful than a "nap schedule."

### Phase B: Emerging Circadian (6 weeks – 3 months)

- **Melatonin production begins** at ~6 weeks, day-night rhythm by 9–12 weeks
- **Longest sleep stretch growing**: ~4.75h at 1mo → potentially 5–6h by 3mo
- **Still 4–5 sleep episodes/day**, but night episodes starting to consolidate
- **Bedtime beginning to emerge** (but varies 60+ minutes day to day)
- **What's predictable**: Wake windows are more consistent. An emergent "longest
  stretch" (usually overnight) is the first sign of structure. Can start
  detecting "this baby is starting to develop a pattern" vs "still random."

### Phase C: Consolidating (3–5 months)

- **24h circadian rhythm established** by 3–4 months
- **Sleep architecture shifts** from 2-stage to 4-stage (~4 months)
- **3–4 naps/day**, becoming positional (1st nap = most consistent)
- **Night sleep consolidating** to 6+ hours (longest stretch 5.7h avg at 0–5mo)
- **"4-month regression"**: not a regression, but the shift to lighter sleep
  stages causing more brief awakenings
- **What's predictable**: 1st nap timing becomes clock-anchored. Wake window
  learning is meaningful. But nap count and duration still highly variable.
  This is the transition zone where the current engine should start working,
  but it enters cold with garbage learned data from phases A/B.

### Phase D: Established (5–6+ months)

- **The current engine's sweet spot**. 2–3 naps, habitual times, learnable.
- **Transition to 2 naps** (6.5–9mo) is the main challenge here — already
  partially handled by the nap-count transition detector.

---

## Proposal: Strategy Selector + Phase-Appropriate Engines

The core idea: rather than one prediction engine that awkwardly handles all
ages, introduce a **strategy layer** that selects the appropriate prediction
approach based on what the data actually looks like. Not a hard age cutoff —
a data-driven classifier, similar to the existing chaotic-vs-habitual blending
but at a higher level.

### The Strategy Selector

```
┌─────────────────┐
│ Strategy Selector│
│                  │
│ Inputs:          │
│  - age           │
│  - recent data   │
│  - data quality  │
│  - variance      │
└────────┬─────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌────────────┐
│Survival│ │ Schedule   │
│(Phase  │ │ (Phase D,  │
│ A/B)   │ │  current)  │
└────────┘ └────────────┘
    ▲         ▲
    │         │
    └────┬────┘
         │
    ┌────┴────┐
    │Emerging │
    │(Phase C,│
    │ blend)  │
    └─────────┘
```

Three prediction strategies, with smooth transitions between them:

#### 1. Survival Strategy (Phase A: ~0–6 weeks)

**Not a schedule predictor — a "what comes next" advisor.**

Core model: **feed–sleep cycle**. A newborn's life is eat → brief wake → sleep
→ eat → repeat. The relevant prediction is: "your baby has been awake X
minutes; based on age and recent pattern, the next sleep window is in Y
minutes."

What it does:
- **Single next-sleep prediction** from wake window only (no full-day schedule)
- Wake window from age defaults (30–60 min), narrowing with data
- **No nap count prediction** — counts are meaningless when episodes are
  irregular
- **No night/day distinction in predictions** — show a continuous 24h view
- **Expected duration from recent average**, but presented as a range ("usually
  sleeps 1–3 hours at this age")
- **Track "longest stretch"** and show when it's growing — this is the parent's
  most actionable insight ("your longest stretch has grown from 2.5h to 3.5h
  this week")
- **Feed-interval tracking** (if we add it) as a secondary signal — newborns
  who just fed have higher sleep pressure

What it does NOT do:
- Predict specific nap times for the day
- Recommend a bedtime
- Show positional predictions (1st nap, 2nd nap)
- Use habitual/circadian blending

UI implications:
- Replace the day/night Arc split with a **continuous 24h circle** (or linear
  timeline)
- Show "next sleep window" as a single highlighted zone, not a full day plan
- Show recent sleep episodes as a scrolling log
- Prominent display of **total sleep in last 24h** vs age-appropriate range
- "Longest stretch" trend indicator
- Softer language: "your baby might be ready to sleep soon" not "nap at 10:30"

#### 2. Emerging Strategy (Phase C: ~2–4 months)

**The transition bridge.** Starts introducing structure as the data supports it.

This is where the classifier matters most. The strategy selector looks at:
- **Longest-stretch consistency**: If the baby's longest sleep is consistently
  overnight (starting between 18:00–22:00), circadian signals are emerging
- **1st-nap-of-day consistency**: If there's a recognizable "morning nap"
  within SD < 45 min, positional learning starts to be meaningful
- **Night/day ratio**: If >60% of sleep is happening between 18:00–08:00,
  the day/night model starts working

What it does:
- **Gradually introduces structure**: Start predicting "morning nap" once it's
  consistent, but keep the survival model for later naps
- **Soft nap count**: "your baby is starting to settle into about 4 naps/day"
  rather than hard predictions for each one
- **Bedtime emergence**: Once a consistent longest-stretch start time emerges,
  show it as a "developing bedtime" — still with wide confidence intervals
- **Blend survival + schedule**: First nap → habitual/schedule. Subsequent
  naps → wake-window-only (survival mode).
- **The key insight**: Different nap positions mature at different rates. The
  1st nap of the day typically becomes consistent first (strongest circadian
  signal from morning light). The last nap before "bed" is the most variable
  and often the last to stabilize.

UI implications:
- Transitional UI: start showing the day/night Arc but with a "developing
  rhythm" indicator
- 1st nap prediction shown with some confidence; later naps shown as ranges
- "Pattern forming" badges when the engine detects consistent structure
- Wide confidence intervals, shrinking as patterns emerge

#### 3. Schedule Strategy (Phase D: 5+ months = current engine)

This is the existing engine, largely unchanged. It already handles this phase
well. The main change is that it now receives **clean input data** — the
survival and emerging strategies have been properly tracking data for months
without forcing it into the schedule model's assumptions, so when the schedule
engine takes over, its learned data is actually meaningful.

### How the Selector Decides (Not Just Age)

The selector shouldn't just check `ageMonths`. It should be data-driven:

```typescript
interface StrategySignals {
  ageMonths: number;
  
  // Data-quality signals
  daysOfData: number;
  completeDays: number;              // days with recognizable night/day
  
  // Structure-emergence signals  
  longestStretchConsistency: number;  // SD of longest sleep start time
  nightDayRatio: number;             // % of sleep in 18:00–08:00 window
  firstNapConsistency: number;       // SD of first morning nap start
  napCountSD: number;                // how variable is the daily nap count
  
  // Wake window signals
  wakeWindowSD: number;              // SD of observed wake windows
}

function selectStrategy(s: StrategySignals): "survival" | "emerging" | "schedule" {
  // Hard floor: no circadian system yet → survival
  if (s.ageMonths < 1.5) return "survival";
  
  // Hard ceiling: circadian mature, enough data → schedule
  if (s.ageMonths >= 5 && s.completeDays >= 7 && s.nightDayRatio > 0.55) 
    return "schedule";
  
  // Data-driven: look for structure emergence
  const structureScore = computeStructureScore(s);
  if (structureScore < 0.3) return "survival";
  if (structureScore < 0.7) return "emerging";
  return "schedule";
}
```

This means a 3-month-old with rock-solid patterns could get schedule-mode
predictions, while a 5-month-old with chaotic sleep stays in emerging mode.
**Age is a prior, not a gate.**

### The Structure Score (A Natural Extension of Existing Blending)

The existing engine already computes exactly these kinds of signals:
- `getHabitualBedtimeWeight()` checks bedtime SD → consistency
- `getHabitualVsDurationWeight()` compares clock vs pressure signals
- `computeHabitualNapWeights()` checks per-position nap start SD

The structure score is a higher-level composition of these same signals,
answering "does this baby HAVE a schedule at all?" rather than "how much should
we trust the schedule we found?"

```typescript
function computeStructureScore(s: StrategySignals): number {
  let score = 0;
  
  // Night/day differentiation (0–0.3)
  // nightDayRatio: 0.5 = no structure, 0.7+ = clear nights
  score += clamp((s.nightDayRatio - 0.5) / 0.2, 0, 0.3);
  
  // First nap consistency (0–0.3)
  // firstNapConsistency SD: <30 min = good, >60 min = none
  score += clamp((60 - s.firstNapConsistency) / 100, 0, 0.3);
  
  // Nap count stability (0–0.2)
  // napCountSD: <0.5 = stable, >1.5 = chaotic
  score += clamp((1.5 - s.napCountSD) / 5, 0, 0.2);
  
  // Wake window regularity (0–0.2)
  score += clamp((30 - s.wakeWindowSD) / 100, 0, 0.2);
  
  return score;
}
```

---

## What Changes in Each Layer

### Data Model

The sleep log data model doesn't need to change. Naps and nights are still
logged the same way. What changes is **how we interpret and classify them**:

**Classification (classification.ts):**
- In survival mode, classification doesn't matter for predictions (it only
  matters for the log display). A survival-mode baby can still log sleeps as
  "nap" or "night" for parent understanding, but predictions ignore the label.
- Add a `classifySleepForSurvival()` that's more lenient — any sleep >4h
  starting after 17:00 could be flagged as "possible overnight stretch" without
  needing a firm night/nap split.

**Constants (constants.ts):**
- Expand `WAKE_WINDOWS` to cover 0–4 weeks: `{ minMonths: 0, maxMonths: 1, minMinutes: 30, maxMinutes: 60 }`
- Split the current 0–3mo bracket into 0–1, 1–2, 2–3mo for finer control
- Expand `NAP_COUNTS` for 0–2mo: `{ minMonths: 0, maxMonths: 2, naps: 6, range: [4, 8] }`
- Add a `FEED_SLEEP_CYCLES` table for survival mode reference values

### Engine (schedule.ts)

**New file: `survival.ts`** — The survival strategy prediction functions:

```typescript
export interface SurvivalPrediction {
  nextSleepWindow: { earliest: string; latest: string };
  expectedDuration: { min: number; typical: number; max: number }; // minutes
  longestStretchTrend: { current: number; weekAgo: number; growing: boolean };
  totalSleepLast24h: number;  // minutes
  ageAppropriateRange: { min: number; max: number }; // minutes
  sleepEpisodesToday: number;
}

export function predictSurvival(
  lastWakeTime: string, 
  ctx: BabyContext
): SurvivalPrediction { ... }
```

**New file: `emerging.ts`** — The emerging strategy that blends survival
predictions for uncertain positions with schedule predictions for consistent
ones.

**Modified: `schedule.ts`** — Largely unchanged, but the top-level prediction
entry point routes through the strategy selector first.

### Backtest

The backtest needs to understand strategies. For survival-mode days, the
metric isn't "did we predict nap 2 correctly at 10:30?" — it's "when the baby
actually fell asleep, were we within the predicted sleep window?"

New metrics for survival mode:
- **Sleep window hit rate**: % of actual sleeps that fell within the predicted
  `earliest–latest` window
- **Total sleep prediction error**: predicted vs actual 24h total
- **Longest stretch prediction error**: predicted vs actual

These can coexist with the schedule-mode metrics. The backtest just needs to
know which strategy was active for each day.

### UI

This is probably the highest-impact area. The UI communicates **what the app
is for** at each stage.

**Survival mode UI (0–6 weeks):**
- 24h continuous timeline (not day/night split)
- "Ready for sleep in ~X minutes" countdown
- Recent sleep episodes as a scrolling list
- Stats: total sleep / longest stretch / episodes today
- Weekly trend: "longest stretch growing!" with a simple chart
- Guidance text: age-appropriate context about what's normal
- No "schedule" language — no "nap 1 at 09:30"

**Emerging mode UI (6 weeks – 4 months):**
- Start transitioning to day/night view as rhythm emerges
- "Developing schedule" section showing consistent elements
- "Morning nap" highlighted when consistently detected
- "Bedtime forming around 19:30 ± 45 min" style predictions
- Still showing sleep-window predictions for inconsistent parts
- Celebration of milestones: "First time sleeping 5+ hours!" 

**Schedule mode UI (5+ months):**
- Current UI, enhanced with confidence indicators
- "Pattern strength" indicator (how habitual vs chaotic today looks)

---

## What We Already Have That Helps

The following existing infrastructure maps directly onto this project:

| Existing | Use in newborn project |
|----------|----------------------|
| `PredictionFeatures` toggle system | Add strategy-level feature: `strategy: "survival" \| "emerging" \| "schedule" \| "auto"` |
| Weighted recency (0.85 decay) | Same decay for survival-mode sleep duration learning |
| `getHabitualBedtimeWeight` (SD-based) | Template for `computeStructureScore` |
| Backtest harness + multi-baby | Validate survival strategy on baby_1 (0–6mo), baby_2, baby_3 |
| Galland normative data | Defaults for survival mode (total sleep, longest stretch) |
| SHINE actigraphy data | Validation benchmarks for each age band |
| `shouldReclassifyAsNight` | Extend for emergence detection (consistent long evening stretches) |

---

## Implementation Phases

### Phase 0: Better Newborn Constants (Small, Immediate)

Split 0–3mo brackets into finer age bands. Fix wake windows for 0–4 weeks.
Update nap count ranges for 0–2mo. This alone would help the current engine
perform less badly on young babies.

Effort: half a day. Measurable via existing multi-baby backtest.

### Phase 1: Survival Strategy Engine

Build `survival.ts` with the feed-sleep-cycle predictor. Add strategy selector
(initially age-gated: <6 weeks → survival, >5 months → schedule, between →
emerging/TBD). Extend backtest with survival-mode metrics. Test against baby_1
(0–3mo), baby_3, and baby_5.

Effort: 2–3 days of engine work.

### Phase 2: Structure Score + Emerging Strategy

Build the data-driven strategy selector. Implement the emerging strategy that
blends survival (for uncertain naps) with schedule (for consistent ones).
Validate that the selector transitions at appropriate times by running on
baby_1's full 0–29mo trajectory and checking transition points.

Effort: 2–3 days.

### Phase 3: Survival Mode UI

Design and build the continuous-timeline UI for survival mode. This is the
biggest user-facing change — a different app experience for newborn parents.

Effort: 3–5 days.

### Phase 4: Emerging Mode UI + Transitions

Build the transitional UI elements. "Pattern forming" indicators, gradual
introduction of schedule elements, milestone celebrations.

Effort: 2–3 days.

### Phase 5: Parent Guidance Layer

Context-appropriate guidance text for each phase. "At this age, it's normal
for sleep to be unpredictable. Here's what to look for as patterns emerge."
This turns the app from a passive tracker into an active advisor during the
most confusing phase of parenthood.

Effort: 1–2 days (content + integration).

---

## What This Unlocks Beyond Newborns

The strategy selector pattern has value beyond the 0–6mo case:

1. **Illness/regression detection**: When a 9-month-old's structure score
   drops suddenly, the engine could temporarily widen confidence intervals or
   shift toward pressure-based predictions, then re-engage habitual learning
   as patterns return.

2. **Per-baby feature adaptation**: The "dynamic feature selection" idea from
   the prediction refactor plan becomes a natural extension — the structure
   score is effectively a multi-dimensional feature selector.

3. **Travel/timezone disruption**: When a family travels, the circadian anchor
   is temporarily invalid. The strategy selector could detect this and shift
   toward pressure-based predictions until the new rhythm establishes.

4. **The routine-building use case**: This is the big one. As patterns emerge
   in the emerging-mode phase, the app can actively help parents **establish**
   a routine: "Your baby's morning nap has been consistent at ~09:15. Try to
   protect this window." → "Your baby is starting to show a 2-nap pattern.
   Here's what that could look like." This is where the app transitions from
   tracking to coaching.

---

## Risks and Tradeoffs

**Risk: Over-engineering for tiny N.** We have ~120 days of 0–3mo data across
3 Kaggle babies of uncertain quality. Building sophisticated models on this is
dangerous. Mitigation: survival mode is deliberately simple (just wake windows
+ recent averages). The complexity is in the selector, not the predictor.

**Risk: UI complexity.** Three different app modes = three UIs to build and
maintain. Mitigation: The transitions are gradual, not hard switches. The
underlying data model is the same. The Arc component can be adapted rather
than replaced — a 24h mode vs 12h mode parameter.

**Risk: Regression on 5+ month babies.** Changing the entry point to route
through a strategy selector could break existing predictions. Mitigation:
strategy="schedule" for ≥5mo is the EXACT current code path. The selector only
adds the survival and emerging paths. Backtest regression guards protect.

**Risk: Data quality assumptions.** Survival mode relies on accurate timestamps
for each sleep episode. Newborn parents are exhausted and may log imprecisely.
Mitigation: wide prediction windows, forgiving metrics, gentle prompts.

---

## Key Decisions To Make

1. **Do we track feeds?** Feed timing is the strongest predictor of newborn
   sleep. Adding a feed log would make survival-mode predictions significantly
   better. But it's a major feature addition (UI, data model, sync). Could
   start with an optional "last fed" timestamp on the sleep entry.

2. **How do we handle the existing Arc UI?** Options: (a) parameterize it
   for 24h vs 12h mode, (b) build a separate timeline component for survival
   mode, (c) just use the existing day Arc with a note that the split is
   artificial. I'd recommend (a) — the Arc is well-built and a 24h mode is a
   natural extension.

3. **When does the UI transition?** Do we show the transition when the
   structure score crosses a threshold, when the parent manually switches, or
   at a fixed age? I'd recommend threshold-based with a manual override — let
   the data drive it, but let parents opt in to schedule mode early if they
   want.

4. **How much newborn-specific guidance text?** The app could become a
   mini-sleep-consultant for the 0–4mo phase. This is high-value but also
   high-effort content work, and we need to be careful not to give medical
   advice. Start with factual descriptions of what's normal at each age.

---

## Summary

The current engine is a good schedule predictor that's been applied to an age
range where schedules don't exist. The fix isn't to make the schedule engine
work for newborns — it's to recognize that newborns need a fundamentally
different kind of prediction (feed-sleep cycle tracking) and to build a smart
selector that transitions between strategies as the baby's patterns emerge.

The biggest wins:
- **For parents**: An app that's actually helpful in the first 4 months instead
  of being confusing/wrong
- **For predictions**: Clean training data for the schedule engine (no garbage
  from forcing polyphasic sleep into a nap-position model)
- **For the product**: A differentiated experience that adapts to the baby,
  not the other way around
- **For the routine-building use case**: The emerging strategy is specifically
  designed to detect and reinforce pattern formation, turning tracking into
  coaching
