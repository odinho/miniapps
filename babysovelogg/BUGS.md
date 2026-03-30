# Bugs and issues from smoke testing (2026-03-31)

## Must fix

### B20: Baby timezone is null in production
The `baby.timezone` column is null. All TZ-aware calculations (day boundaries, bedtime clamp, arc positions) fall back to server locale or UTC instead of using the baby's actual timezone. Should be "Europe/Oslo".

**Impact**: Predictions could be off by 1-2 hours near DST transitions. Day boundary calculations may group sleeps to the wrong day.

**Fix**: Set timezone in settings, or auto-detect from server locale on baby creation.

### B21: No DST awareness or warnings
DST transition (March 29 CET→CEST) caused real-world harm — parent put baby down too early both days because the internal clock shifted but the app didn't warn or adjust. The app should:
1. Detect upcoming DST transitions and show a banner/warning
2. Optionally show "yesterday's bedtime was 18:20, today accounting for DST that's 19:20"
3. At minimum, the prediction engine should be aware of DST shifts in the wake window calculation

### B22: E2E tests broken (pre-existing)
`tests/fixtures.ts` imports `bun:sqlite` but Playwright runs under Node.js. All E2E tests fail with `Error: Only URLs with a scheme in: file, data, and node are supported`. This predates our changes (from the bun runtime migration).

## Should fix

### B23: Misclassified 14h "nap" on Friday March 27
History shows `19:18 — 09:21 Lur 14h 3m` — clearly a night sleep that was entered/classified as a nap. The classification engine should flag sleeps >6h starting after 17:00 as likely night sleeps.

### B24: Diaper count doesn't update immediately on dashboard
After saving a diaper entry, the dashboard still showed 0 dobesøk. The SSE push may not be triggering a re-render, or the state fetch has a race condition. Navigating away and back updates correctly.

## Nice to have

### B25: Native time input shows AM/PM
The browser's `<input type="time">` renders in AM/PM format based on system locale. The user wants 24h clock always. May need a custom time picker component instead of native.

### B26: Native date input shows US format (MM/DD/YYYY)
Settings page date input shows month-first format. Norwegian convention is DD.MM.YYYY. Same locale issue as B25.

### B27: Target bedtime UI not yet in settings
The backend plumbing (DB column, event schema, projection) is in place but the settings page doesn't have a field to set `target_bedtime`. Needed to complete the backward planning feature end-to-end.

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
