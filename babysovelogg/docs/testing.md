# Testing

## Commands

- `pnpm test` runs the Playwright E2E test suite
- `pnpm test:unit` runs Vitest unit tests
- `pnpm typecheck` runs the TypeScript typecheck (tsgo)
- `pnpm check` runs typecheck + oxlint + oxfmt

## Principles

1. Write the test at the right layer for the behavior, not automatically at the lowest layer.
2. Prefer a smaller number of broad, readable tests over a large number of narrow tests that each prove very little.
3. Human readability matters. A developer should be able to scan a test and understand the behavior quickly.
4. Spend effort on harnesses, helpers, fixtures, and DSLs if that makes the real tests obvious.
5. Prefer assertions that show a useful diff when behavior changes.
6. Write tests in AAA (Arrange-Act-Assert)-style, with _only_ double newlines to separate the parts, no AAA-comments.
7. Keep tests short — no unnecessary variables, no duplicated setup. Extract helpers aggressively.

## Bias

This repo should usually lean toward high-leverage integration tests.

A good integration test here can exercise the event-sourced write path, projections, API validation, and UI rendering in one go. That is often better than many small unit tests that each touch only a tiny branch of the same behavior.

Unit tests still matter, but mostly when:

- the logic is genuinely easier to understand in isolation (e.g. schedule prediction, CSV parsing)
- edge cases would make the integration test too noisy
- the helper itself needs direct coverage
- a failure would otherwise be hard to localize

## What good tests look like here

Good tests are usually:

- table-driven
- input -> output oriented
- based on a small but carefully chosen dataset
- written so that failures are obvious at a glance

If a helper or DSL can turn a page of setup into a compact readable table, that is usually worth it.

## Assert on full visible state, not individual fields

The most important testing pattern in this repo: **render the full state into a readable structure, then assert on that whole structure.**

When a test checks `expect(sleepLog).toHaveLength(1)` and `expect(diaperLog).toHaveLength(0)` and `expect(dayStart).not.toBeNull()` — that is a pile of fragments. If someone forgets to add a check for a new projection table, the test silently passes with stale data. The bug hides.

Instead, build a renderer that produces the full visible state as a single string or object. Then the test becomes:

```ts
const babyId = createBaby("Testa");
setWakeUpTime(babyId);
addCompletedSleep(babyId, "2026-03-26T09:00:00Z", "2026-03-26T10:30:00Z", "nap");

expect(renderBabyState(babyId)).toMatchInlineSnapshot(`
  baby: Testa (2025-06-12)
  vekketid: 07:00
  sovelur: 09:00–10:30 (1t 30m)
  bleier: (ingen)
`);

addDiaper(babyId, "2026-03-26T11:00:00Z", "wet", "middels");

expect(renderBabyState(babyId)).toMatchInlineSnapshot(`
  baby: Testa (2025-06-12)
  vekketid: 07:00
  sovelur: 09:00–10:30 (1t 30m)
  bleier: 11:00 våt middels
`);
```

Showing the before-state makes the test self-documenting — you can see what changed without looking at the fixture. This is especially valuable when the state is derived (not the direct input). For a sequence of tests on the same fixture, the first test or a dedicated "initial state" test can show the before-snapshot, and later tests can skip it to avoid repetition.

On first run, leave `toMatchInlineSnapshot()` empty — Vitest writes the value into the file. After intentional changes, run `vitest run --update` and review the git diff.

If someone later adds a new piece of state (say `potty_log`) and forgets to clear it on reset, the renderer will include it and the diff will show it. The bug is impossible to miss.

### Pin important invariants after the snapshot

The inline snapshot is the first line of defense — it shows the full picture and catches things you forgot to check. But snapshots can be blindly updated with `--update`. To protect behavior that really matters, add targeted assertions **after** the snapshot:

```ts
expect(renderBabyState(babyId)).toMatchInlineSnapshot(`
  baby: Testa (2025-06-12)
  vekketid: 07:00
  sovelur: (ingen)
  bleier: (ingen)
`);
expect(db.prepare("SELECT COUNT(*) as c FROM sleep_log").get()).toEqual({ c: 0 });
expect(db.prepare("SELECT COUNT(*) as c FROM events").get()).toEqual({ c: 1 }); // only baby.created
```

These pinned assertions force someone to deliberately change them — they can't be auto-updated away. Use judgement: not every test needs them, and not every field is worth pinning. Pin the things that represent important invariants — the event-sourcing guarantees, the projection consistency, the state transitions that would break real users.

Renderers also can't catch everything. They show a summary, not every internal detail. A renderer might show `bleier: 3` but not whether each diaper record has the right `domain_id`. Pinned assertions fill that gap when it matters.

This pattern applies everywhere, not just baby state:

- **Event log:** render the event sequence as a readable summary. Assert on the whole sequence after an API call.
- **Projections:** render the projected state (sleep_log, diaper_log, day_start) after a rebuild. Assert on before/after.
- **API responses:** when the response is small, assert on the whole body with `toStrictEqual`, not individual fields.

The key insight: **if a test doesn't show you the full picture, a missing assertion is a missing bug report.** A structural diff on the whole state catches things you didn't think to check. Pinned assertions after the snapshot protect the things you definitely thought about.

### How to build renderers

A renderer is just a function that takes state and returns a string or plain object. It should:

- include everything a user would see (or everything relevant to the behavior)
- use a compact, readable format — not raw JSON dumps
- be stable (deterministic ordering, no timestamps unless relevant)
- live in test helpers, not in production code

Invest time in renderers. A good renderer makes every test that uses it better, and makes future bugs obvious by default.

## Harness first

It is fine to write a lot of helper code to make a small number of tests read well.

Preferred shapes:

- a table of inputs and expected outputs
- a compact scenario DSL
- a seeded integration harness such as [`tests/fixtures.ts`](../tests/fixtures.ts)
- a renderer that produces the full visible state as a diffable string or object
- snapshot-style assertions when the diff is clearer than a pile of small expects

The goal is not to minimize test helper code. The goal is to make the actual tests legible and high-signal.

### Setup helpers: defaults with overrides

The single biggest source of test bloat is repeating the same setup in every test. Fix this with defaults-with-overrides helpers. A test should only specify what it varies:

```ts
// Bad — repeated boilerplate per test
const babyId = createBaby("Testa", "2025-06-12");
setWakeUpTime(babyId);
addCompletedSleep(babyId, start, end, "nap");
addDiaper(babyId, time, "wet", "middels");

// Good — one helper, tests specify only what matters
function seedDay(overrides: { naps?: number; diapers?: number; wake?: string } = {}) {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  // seed naps and diapers based on overrides...
  return babyId;
}

const babyId = seedDay({ naps: 2, diapers: 3 });
```

The same pattern works for event helpers:

```ts
function seedEvents(events: Array<{ type: string; payload?: Record<string, unknown> }>) {
  const db = getDb();
  for (const e of events) {
    db.prepare(
      "INSERT INTO events (type, payload, client_id, client_event_id) VALUES (?, ?, ?, ?)",
    ).run(e.type, JSON.stringify(e.payload ?? {}), generateId(), generateId());
  }
  db.close();
}
```

When multiple test files need the same seed helpers, put them in the shared test fixtures file rather than duplicating.

### Renderer helpers

Small utilities keep renderers compact:

```ts
// Render a list or show a placeholder
const listOr = <T>(items: T[], fn: (t: T) => string, empty: string) =>
  items.length > 0 ? items.map(fn).join(" | ") : empty;

// Format a sleep entry compactly
const renderSleep = (s: { start_time: string; end_time: string | null; type: string }) =>
  [
    `${s.start_time.slice(11, 16)}–${s.end_time?.slice(11, 16) ?? "pågår"}`,
    s.type,
  ].join(" ");
```

## Layers

### Integration tests

Default to these when they can express the behavior clearly.

Relevant places in this repo:

- [`tests/`](../tests/) — API, event-sourcing, validation, dedup, rebuild
- [`tests/fixtures.ts`](../tests/fixtures.ts) — Shared DB helpers and Playwright fixtures

Use them to cover complete behavior chains with real DB state and realistic inputs.

### Unit tests

Use these for pure logic, tricky helpers, or cases where an integration test would hide the actual rule being tested.

Relevant places:

- [`tests/unit/`](../tests/unit/) — CSV parsing, schedule prediction, isolated logic

### E2E tests

Use Playwright for critical browser paths, not as the default way to test everything.

Relevant place:

- [`tests/*.e2e.ts`](../tests/) — Dashboard, sleep logging, diaper tracking, settings, history, stats

## Assertions

Prefer one assertion on the full result over many assertions on pieces.

Good:

- `expect(renderState()).toMatchInlineSnapshot(...)` — renderer + inline snapshot; updating is `vitest run --update` or `npx playwright test --update-snapshots` then review the git diff
- a table row that shows expected output clearly
- one `toStrictEqual` on a meaningful returned object

Less good:

- many tiny assertions that each reveal only a fragment of the behavior (`toHaveLength`, `toBeNull`, `toBe` on five separate fields)
- vague matcher chains that fail without showing the meaningful output change
- assertions that only check what you remembered to check — if a new field appears, nothing catches it

The test for "reset DB clears all projections" should not be five separate `expect` calls. It should be one assertion on the full rendered state, so that adding a sixth projection table automatically gets coverage.

## Existing test helpers

- **`tests/fixtures.ts`**: The shared test harness. Key exports:
  - `test` — Custom Playwright test with `autoResetDb` fixture (resets all tables before each test)
  - `resetDb()` — Clears all tables: events, baby, sleep_log, diaper_log, day_start, sleep_pauses
  - `createBaby(name, birthdate)` — Creates a baby via event + direct insert
  - `setWakeUpTime(babyId, wakeTime)` — Sets wake-up time for the day
  - `addCompletedSleep(babyId, start, end, type, domainId)` — Adds a finished nap/night
  - `addActiveSleep(babyId, start, type, domainId)` — Adds an in-progress sleep
  - `addDiaper(babyId, time, type, amount, domainId)` — Logs a diaper change
  - `addEvent(type, payload)` — Inserts a raw event
  - `forceMorning(page)` / `forceHour(page, hour)` — Override `Date.getHours()` in the browser
  - `dismissSheet(page)` — Closes modal overlays (tag sheet, wake-up prompt)
  - `generateId()`, `generateSleepId()`, `generateDiaperId()` — Domain ID generators

When adding new state (projections, tables, etc.), update `resetDb()` and consider adding a renderer so existing tests automatically catch regressions.

## Repo expectations

- update tests when behavior changes
- do not test framework internals
- keep production behavior generic and keep test fixtures intentional
- if a test is hard to read, improve the harness before adding more assertions

---

## Current state (March 2026)

This section is a point-in-time snapshot of where we are. The patterns above describe where we want to go.

### What exists today

- 27 test files: 20 Playwright E2E, 6 Playwright "integration" (API-only), 1 Vitest unit test
- Shared fixtures in `tests/fixtures.ts` with DB reset, seed helpers, time mocking — solid foundation
- Event-sourced architecture with working rebuild/replay — good testability at the data layer
- Pure functions in `src/engine/` (schedule prediction, stats) — highly testable, but **zero unit tests** for them

### What's wrong

**~35 tests don't need a browser but use Playwright anyway.** Files like `dedup.test.ts`, `rebuild.test.ts`, `domain-ids.test.ts`, `traceability.test.ts`, `import-napper.test.ts`, and `export.e2e.ts` only use `page.request.post()` and DB checks — never `page.goto()` or any DOM interaction. These could be fast Vitest integration tests that hit the server directly via `fetch()` or test the functions in-process, but instead they spin up a browser and go through Playwright. This makes them slow, noisy, and harder to debug.

**Assertions are fragment piles.** Almost every test checks individual fields:

```ts
// From tags.e2e.ts — 4 separate assertions, easy to forget a 5th
const sleep = db.prepare("SELECT * FROM sleep_log ORDER BY id DESC LIMIT 1").get();
expect(sleep.mood).toBe("happy");
expect(sleep.method).toBe("nursing");
expect(sleep.woke_by).toBe("self");
```

No renderers exist. No `toMatchInlineSnapshot()` anywhere. If someone adds a new field, nothing catches a missing assertion.

**Setup boilerplate is repeated everywhere.** `forceMorning(page)` appears in `beforeEach` in 14 files. `postEvent()` and `makeEvent()` helpers are duplicated across 3+ files instead of living in fixtures. Manual sleep+pause insertion code (open DB, insert, close) is repeated in `pause.e2e.ts` 3 times.

**Pure business logic has no tests.** `calculateAgeMonths()`, `predictNextNap()`, `recommendBedtime()`, `predictDayNaps()`, `getTodayStats()`, `getWeekStats()` are all pure functions with no side effects — perfect for table-driven unit tests. None of them have any.

**Business logic is tangled with UI code.** `classifySleepType()` and `classifySleepTypeByHour()` live in `src/ui/dashboard.ts` (a 1700+ line file), making them impossible to test without importing the entire UI. Same for `calcPauseMs()`.

**`getState()` in `server/api.ts` is untestable.** It's a 120-line function that does 6 DB queries, date math, stats computation, and prediction assembly — all inline with no parameters. You can't call it without a fully populated database.

---

## Refactoring plan

Each item is independent — do them in any order, one at a time.

### R1. Extract pure logic from `dashboard.ts`

**Problem:** `classifySleepType()`, `classifySleepTypeByHour()`, and `calcPauseMs()` are pure functions buried in a 1700-line UI file. They can't be imported without pulling in DOM code.

**Move to:** `src/engine/classification.ts`

**Code change:** Extract the three functions, keep the same signatures. Import them back into `dashboard.ts`. No behavior change.

**Test:** Add `tests/unit/classification.unit.ts` — table-driven tests for the ambiguous zone logic (16:00–19:59), clear night, clear day, and nap-count-based classification. These are the kind of edge cases that are hard to get right in E2E and easy to nail in a table:

```ts
const cases = [
  { hour: 3, expected: "night" },
  { hour: 10, expected: "nap" },
  { hour: 17, completedNaps: 2, expectedNaps: 2, expected: "night" },
  { hour: 17, completedNaps: 1, expectedNaps: 2, expected: "nap" },
  { hour: 21, expected: "night" },
];
```

### R2. Unit tests for `src/engine/schedule.ts` and `stats.ts`

**Problem:** These are pure functions — no DB, no side effects — yet they have zero tests. They contain the core domain logic (wake windows, nap predictions, bedtime recommendations).

**Test:** Add `tests/unit/schedule.unit.ts` and `tests/unit/stats.unit.ts`.

Table-driven, focused on edge cases: newborn vs 12-month wake windows, zero sleeps, single nap transition, overnight sleep with pauses. Use `toMatchInlineSnapshot()` for the full prediction output so regressions are obvious.

No production code change needed.

### R3. Move API-only tests from Playwright to Vitest

**Problem:** `dedup.test.ts`, `rebuild.test.ts`, `domain-ids.test.ts`, `traceability.test.ts`, `import-napper.test.ts` use Playwright only for `page.request`. They need a running server but not a browser.

**Approach:** Create a lightweight Vitest integration harness that starts the server once (or uses the same `fetch()` against a test server), and provides helpers like `postEvents()` and `getDb()`. Move these 5 files to use it.

**Code change:** A small `tests/integration/harness.ts` that:
- Starts the server on a random port (or reuses the Playwright config's port)
- Exports `post(path, body)` and `get(path)` wrappers around `fetch()`
- Reuses the existing `resetDb()`, `createBaby()`, etc. from fixtures

The test files barely change — swap `page.request.post(...)` for `post(...)` and drop the Playwright imports.

**Benefit:** These tests run in ~1s instead of ~10s. No browser process. Better error messages (no Playwright stack traces for what is really a data assertion).

### R4. Split `export.e2e.ts` and `events-ui.e2e.ts`

**Problem:** `export.e2e.ts` has 4 tests — 3 are API-only, 1 checks that export buttons are visible. `events-ui.e2e.ts` has 7 tests — the first 5 are API-only (type filter, domainId filter, pagination), the last 2 test DOM rendering.

**Approach:** Move the API-only tests to the Vitest integration harness from R3. Keep only the DOM tests in Playwright.

### R5. Build a state renderer for integration tests

**Problem:** Tests assert on individual fields. Missing assertions are missing bug reports.

**Approach:** Create `tests/helpers/render-state.ts`:

```ts
export function renderDayState(db: Database, babyId: number): string {
  const baby = db.prepare("SELECT * FROM baby WHERE id = ?").get(babyId);
  const sleeps = db.prepare(
    "SELECT * FROM sleep_log WHERE baby_id = ? AND deleted = 0 ORDER BY start_time"
  ).all(babyId);
  const diapers = db.prepare(
    "SELECT * FROM diaper_log WHERE baby_id = ? AND deleted = 0 ORDER BY time"
  ).all(babyId);
  // ... format into readable string
}
```

Output looks like:

```
baby: Testa (2025-06-12)
sovelur: 09:00–10:30 lur | 13:00–14:00 lur
bleier: 08:30 våt middels | 11:00 avføring stor
vekketid: 07:00
```

Use in existing tests alongside (not instead of) current assertions. Adopt in all new tests.

### R6. Extract `getState()` into a testable assembler

**Problem:** `server/api.ts:getState()` is 120 lines of mixed DB queries and business logic. Untestable without HTTP.

**Approach:** Don't do DI. Instead, split it into two parts:

1. **Data fetching** — stays in `api.ts`, does the queries, returns raw data:
   ```ts
   function fetchDayData(db, babyId, todayStart, weekAgo) {
     return { baby, activeSleep, todaySleeps, recentSleeps, todayWakeUp, ... };
   }
   ```

2. **State assembly** — pure function in `src/engine/state.ts`, takes data, returns the API response shape:
   ```ts
   export function assembleState(data: DayData): AppState {
     const stats = getTodayStats(data.todaySleeps);
     const prediction = buildPrediction(data);
     return { baby: data.baby, stats, prediction, ... };
   }
   ```

The assembly function is pure and unit-testable. The data fetching stays thin and close to the DB. No interfaces, no DI, just "fetch data, then compute."

### R7. Consolidate test helpers

**Problem:** `postEvent()` and `makeEvent()` are duplicated in `dedup.test.ts`, `traceability.test.ts`, and `domain-ids.test.ts`. Sleep+pause DB insertion code is repeated in `pause.e2e.ts`.

**Approach:** Move shared helpers into `tests/fixtures.ts` (or a new `tests/helpers/` directory if fixtures gets too large):
- `postEvents(fetch, events)` — sends event batch to API
- `makeEvent(type, payload)` — creates event envelope with generated IDs
- `addSleepWithPauses(babyId, { start, end, pauses: [...] })` — seed sleep + pauses in one call

### R8. Reduce `forceMorning` boilerplate

**Problem:** 14 E2E files have identical `test.beforeEach(async ({ page }) => { await forceMorning(page); })`.

**Approach:** Make it a Playwright fixture in `tests/fixtures.ts`:

```ts
export const test = base.extend<{ autoResetDb: void; morningPage: Page }>({
  autoResetDb: [async ({}, use) => { resetDb(); await use(); }, { auto: true }],
  morningPage: async ({ page }, use) => {
    await forceMorning(page);
    await use(page);
  },
});
```

Tests that need morning mode use `{ morningPage }` instead of `{ page }` + beforeEach. Tests that need a different hour still use `forceHour()` directly.
