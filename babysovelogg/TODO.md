# TODO

## Playwright Test Refactoring — Best Practices

Goal: Follow [Playwright best practices](https://playwright.dev/docs/best-practices) to make tests faster, more stable, shorter, and easier to maintain.

### Phase 1: Extract shared helpers into a fixture file ✅
- [x] Create `tests/fixtures.ts` with shared helpers and auto-reset DB fixture
- [x] Remove duplicated helper functions from all 10 spec files
- [x] Result: -441 lines of code, all 53 tests pass

### Phase 2: Replace CSS selectors with user-facing locators ✅
- [x] Replace `page.locator('h1')` → `page.getByRole('heading', { name: ... })`
- [x] Replace `page.locator('button.btn-primary')` → `page.getByRole('button', { name: ... })` in onboarding/wakeup
- [x] Replace `page.locator('text=History')` → `page.getByText('History')`
- [x] Replace `.stat-label:text("...")` chains with getByText
- [x] Replace `.diaper-quick-btn`, `.fab`, `.sleep-button` etc. with getByTestId
- [x] Replace `[data-mood="happy"]`, `[data-method="nursing"]` etc. with getByRole('button', { name: ... })
- [x] Replace `.modal .btn-primary` / `.btn-danger` / `.btn-ghost` → getByRole('button', { name: 'Save'/'Delete'/'Skip' })
- [x] Replace `.modal-overlay` → getByTestId('modal-overlay')
- [x] Replace `.morning-prompt` → getByTestId('morning-prompt')
- [x] Replace `.dashboard` → getByTestId('dashboard')
- [x] Replace `.baby-name` / `.baby-age` → getByTestId
- [x] Replace `.nav-tab:nth-child(2)` → getByRole('button', { name: 'History' })
- [x] Replace `.history-empty` → getByText('No entries yet')
- [x] Replace `.tag-sheet` checks → getByRole('heading', { name: 'How did it go?' })
- Note: SVG internals (`.arc-bubble-*`, `.arc-track`, `.arc-center-*`, `.arc-active-pulse`) intentionally kept as CSS selectors
- Note: History list items (`.sleep-log-item`, `.diaper-log-item`, `.log-meta`, `.tag-badge`) kept as CSS — structural elements without unique text

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
