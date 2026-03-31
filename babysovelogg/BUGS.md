# Bugs and issues from smoke testing (2026-03-31)

## Must fix

### ~~B20: Baby timezone is null in production~~ — fixed (1727dba)
Auto-backfills from server locale on first state fetch. Production will set "Europe/Oslo" on next app load.

### B21: No DST awareness or warnings
DST transition (March 29 CET→CEST) caused real-world harm — parent put baby down too early both days because the internal clock shifted but the app didn't warn or adjust. The app should:
1. Detect upcoming DST transitions and show a banner/warning
2. Optionally show "yesterday's bedtime was 18:20, today accounting for DST that's 19:20"
3. At minimum, the prediction engine should be aware of DST shifts in the wake window calculation

### B22: E2E tests broken (pre-existing)
`tests/fixtures.ts` imports `bun:sqlite` but Playwright runs under Node.js. All E2E tests fail with `Error: Only URLs with a scheme in: file, data, and node are supported`. This predates our changes (from the bun runtime migration).

## Should fix

### ~~B23: Misclassified 14h "nap" on Friday March 27~~ — fixed
Auto-reclassifies sleeps >6h starting after 17:00 as night in projections (sleep.ended + sleep.manual). Existing data fixed on next rebuild.

### ~~B24: Diaper count doesn't update immediately on dashboard~~ — fixed
Root cause: DiaperForm and WakeUpSheet used `toISOString().slice(0,10)` (UTC date) but local time, causing wrong-day timestamps late at night. Fixed to use local date formatting.

## Nice to have

### ~~B25: Native time input shows AM/PM~~ — fixed
Replaced all native `<input type="time">` with custom `TimeInput` component (always 24h HH:MM).

### ~~B26: Native date input shows US format (MM/DD/YYYY)~~ — fixed
Replaced all native `<input type="date">` with custom `DateInput` component (always DD.MM.YYYY).

### ~~B27: Target bedtime UI not yet in settings~~ — fixed
Added Auto/Fast tid toggle with TimeInput to settings. Saves as `targetBedtime` in baby.updated event.

## Observations (not bugs)

- Deep night mode (0-5 AM) correctly shows "GOD NATT" with no predictions
- Arc visualization works well in both day and night modes
- Tag sheet (mood, method, fall-asleep time, notes) is comprehensive and feels good
- Potty reminder during sleep start ("Ikkje vore på do dei siste 2 timane") is a nice touch
- Sleep pause/resume flow works correctly
- History page is rich and well-organized with good detail
- Stats page shows useful info (sleep trends, wake windows, potty success rate)
- All 460 unit tests pass, 0 type errors
- Confidence and calibration data flows through the API correctly
