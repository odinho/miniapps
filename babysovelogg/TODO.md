# TODO

## Playwright Test Refactoring — Best Practices

Goal: Follow [Playwright best practices](https://playwright.dev/docs/best-practices) to make tests faster, more stable, shorter, and easier to maintain.

### Phase 1: Extract shared helpers into a fixture file ✅
- [x] Create `tests/fixtures.ts` with shared helpers and auto-reset DB fixture
- [x] Remove duplicated helper functions from all 10 spec files
- [x] Result: -441 lines of code, all 53 tests pass

### Phase 2: Replace CSS selectors with user-facing locators (partial ✅)
- [x] Replace `page.locator('h1')` → `page.getByRole('heading', { name: ... })`
- [x] Replace `page.locator('button.btn-primary')` → `page.getByRole('button', { name: ... })` in onboarding/wakeup
- [x] Replace `page.locator('text=History')` → `page.getByText('History')`
- [ ] Replace `.stat-label:text("...")` chains with getByText
- [ ] Replace `.diaper-quick-btn`, `.fab`, `.sleep-button` etc. with getByRole or getByTestId
- [ ] Replace `[data-mood="happy"]`, `[data-method="nursing"]` etc. with getByRole or getByText
- Note: SVG internals (`.arc-bubble-completed`, `.arc-track`) intentionally kept as CSS selectors

### Phase 3: Replace deprecated page methods with locator actions ✅
- [x] Replace `page.click('.selector')` → `page.locator(…).click()`
- [x] Replace `page.fill('selector', value)` → `page.locator(…).fill(value)`

### Phase 4: Remove explicit waits ✅
- [x] Remove `page.waitForTimeout(...)` calls (were in SSE tests, removed)

### Phase 5: Use `request` fixture ✅
- [x] Replace `page.evaluate(fetch(...))` → `request.post()`

### Phase 6: Use `test.describe` for grouping
- [ ] Group related tests within each file (optional, low priority)

## Ideas / Future

_Add new tasks here._
