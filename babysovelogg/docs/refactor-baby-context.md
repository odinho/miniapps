# Refactor: Thread a BabyContext object through the prediction engine

## Problem

The prediction engine functions (`getWakeWindow`, `predictDayNaps`, `recommendBedtime`, `getLearnedNapCount`, `getPositionalWakeWindows`, etc.) have accumulated many parameters that all derive from the same baby:

- `ageMonths` (computed from `birthdate` + now)
- `recentSleeps` (queried for this baby)
- `customNapCount` (baby's setting)
- `tz` (baby's timezone)

These get threaded individually through every function call, making signatures long and error-prone. Some callers forget parameters (e.g. `recommendBedtime` was called without `recentSleeps` in settings-utils.ts, `tz` was missing in several internal functions until recently).

The backtest has the same problem — it passes `birthdate`, `tz`, `customNapCount` separately and computes `ageMonths` per-day.

## Proposed solution

Introduce a `BabyContext` object that bundles everything the prediction engine needs about a baby:

```typescript
interface BabyContext {
  birthdate: string;        // ISO date
  tz: string;               // IANA timezone (e.g. "Europe/Oslo")
  customNapCount?: number | null;  // user override, if set
  recentSleeps: SleepEntry[];      // last 7 days of completed sleeps
}
```

The engine functions would take `BabyContext` instead of individual params:

```typescript
// Before
function predictDayNaps(wakeUpTime: string, ageMonths: number, recentSleeps?: SleepEntry[], customNapCount?: number | null, tz?: string): PredictedNap[]
function recommendBedtime(todaySleeps: SleepEntry[], ageMonths: number, customNapCount?: number | null, recentSleeps?: SleepEntry[], tz?: string): string
function getWakeWindow(ageMonths: number, recentSleeps?: SleepEntry[], tz?: string): number

// After
function predictDayNaps(wakeUpTime: string, ctx: BabyContext): PredictedNap[]
function recommendBedtime(todaySleeps: SleepEntry[], ctx: BabyContext): string
function getWakeWindow(ctx: BabyContext): number
```

`ageMonths` would be computed from `ctx.birthdate` inside the functions (or cached on the context if needed for performance).

## Where to build the context

### Production (server)
In `src/lib/server/state.ts` and `src/lib/engine/state.ts`, the baby record is already loaded. Build the context there:

```typescript
const ctx: BabyContext = {
  birthdate: baby.birthdate,
  tz: baby.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  customNapCount: baby.custom_nap_count ?? null,
  recentSleeps: recentSleeps.map(toSleepEntry),
};
```

The baby's timezone should come from the `baby` table. Currently the app uses `process.env.TZ` (server timezone = baby timezone for single-tenant). The `baby` table should store an IANA timezone string, defaulting to the server's TZ on baby creation (or detected from the client's locale on first setup).

### Backtest
The backtest already has all the pieces. Build context per-day:

```typescript
const ctx: BabyContext = {
  birthdate,
  tz: options.tz,
  customNapCount: options.customNapCount,
  recentSleeps,  // already collected from prior days
};
const predictedNaps = predict(day.wakeTime, ctx);
```

### Tests
Each baby fixture would specify its timezone. The test builds the context:

```typescript
const ctx: BabyContext = {
  birthdate: "2025-06-12",
  tz: "Europe/Oslo",
  customNapCount: null,
  recentSleeps: [...],
};
```

## Migration steps

1. Define `BabyContext` in `src/lib/types.ts`
2. Add `timezone` column to the `baby` table (default: server TZ)
3. Refactor internal engine functions (`getLearnedNapCount`, `getPositionalWakeWindows`, `getAdaptedWakeWindowRange`, `getLearnedBedtimeWakeWindow`, `getAverageWakeWindowFromSleeps`) to take `BabyContext` instead of scattered params
4. Refactor public engine functions (`predictDayNaps`, `recommendBedtime`, `getWakeWindow`, `predictNextNap`) to take `BabyContext`
5. Update callers: `state.ts`, `backtest.ts`, `settings-utils.ts`, `classification.ts`, `cli/baby.ts`
6. Update unit tests — the schedule.unit.ts tests construct individual params, would construct a context instead
7. Update backtest tests — already have birthdate + tz, just bundle them

## What this enables

- No more forgotten parameters — if you have the context, you have everything
- Easy to add new baby-level config later (target bedtime, preferred nap count, sensitivity settings)
- `ageMonths` computed once, consistently, instead of scattered `calculateAgeMonths` calls
- Timezone is always available, never defaulting silently to the wrong value in tests
- Cleaner function signatures throughout the engine

## Files to touch

- `src/lib/types.ts` — add BabyContext interface
- `src/lib/engine/schedule.ts` — refactor all functions (main work)
- `src/lib/engine/state.ts` — build context from baby record
- `src/lib/engine/classification.ts` — uses getExpectedNapCount
- `src/lib/engine/backtest.ts` — build context per-day
- `src/lib/settings-utils.ts` — uses prediction functions
- `src/lib/server/state.ts` — builds the server-side state
- `src/lib/server/db.ts` or migration — add timezone column to baby table
- `cli/baby.ts` — CLI uses prediction functions
- `tests/unit/schedule.unit.ts` — update test helpers
- `tests/unit/backtest.unit.ts` — minor (already has birthdate + tz)
- `tests/unit/backtest-multi.unit.ts` — minor
