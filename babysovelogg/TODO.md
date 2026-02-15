# TODO

## Playwright Test Refactoring — Best Practices

Goal: Follow [Playwright best practices](https://playwright.dev/docs/best-practices) to make tests faster, more stable, shorter, and easier to maintain.

### Phase 1: Extract shared helpers into a fixture file
- [ ] Create `tests/fixtures.ts` with shared `getDb`, `resetDb`, `createBaby`, `setWakeUpTime`, `seedBabyWithSleep`, `dismissMorningPrompt`
- [ ] Export a custom `test` with `beforeEach` that auto-resets the DB
- [ ] Remove duplicated helper functions from all 10 spec files

### Phase 2: Replace CSS selectors with user-facing locators
- [ ] Replace `page.locator('.sleep-button')` → `page.getByRole('button', ...)` or `page.getByTestId(...)` where no accessible name exists
- [ ] Replace `page.locator('.baby-name')` → `page.getByRole(...)` / `page.getByText(...)`
- [ ] Replace `page.locator('.modal h2')` → `page.getByRole('heading', { name: ... })`
- [ ] Replace `page.locator('.morning-prompt')` → user-facing alternative
- [ ] Replace `page.locator('.fab')` → `page.getByRole('button', ...)`
- [ ] Replace `page.locator('text=History')` → `page.getByRole('link/tab', { name: 'History' })`
- [ ] Replace all `.locator('.stat-label:text("...")')` chains with getByText/getByRole
- [ ] Replace data attribute selectors like `[data-mood="happy"]`, `[data-method="nursing"]`, `[data-diaper-type="dirty"]` → getByRole or getByText
- [ ] Note: Some CSS selectors (`.arc-bubble-completed`, `.arc-track`, etc.) test SVG rendering internals — keep those or convert to test-ids

### Phase 3: Replace deprecated page methods with locator actions
- [ ] Replace `page.click('.selector')` → `page.locator(…).click()` or better, user-facing locator `.click()`
- [ ] Replace `page.fill('selector', value)` → `page.getByLabel(…).fill(value)` or `page.getByRole(…).fill(value)`

### Phase 4: Remove explicit waits
- [ ] Remove all `page.waitForTimeout(...)` — replace with proper assertions or `waitForResponse`
- [ ] Remove `page.waitForResponse` where possible (assertions auto-wait)

### Phase 5: Use `request` fixture instead of `page.evaluate(fetch(...))`
- [ ] In `onboarding.spec.ts` "Sleep tracking flow after onboarding" test — use `request.post()` instead of `page.evaluate(async () => { await fetch(...) })`

### Phase 6: Use `test.describe` for grouping
- [ ] Group related tests within each file using `test.describe`

### Phase 7: Clean up and verify
- [ ] Run full test suite, fix any breakage
- [ ] Verify test count unchanged
- [ ] Commit and push

## Ideas / Future

_Add new tasks here._
