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
