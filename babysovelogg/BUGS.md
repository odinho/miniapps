# Bugs and issues from smoke testing (2026-03-31)

## Must fix

### B30: Napper import creates overlapping/open sleeps — doesn't respect existing data
**Symptom:** After Napper import on 2026-04-05, sleep_log `id=245` (domain_id `slp_import_613`) started 2026-03-22T17:38Z with no `end_time` → 347 hours(!). UI's "end sleep" dropdown picked this bogus event instead of the real current night.
**Root cause (deeper):** The Napper import doesn't check for existing babysovelogg data in the same time range. The open night from 2026-03-22 likely already had data logged directly in babysovelogg — the import should have detected the overlap and skipped/deferred to the existing native data. Native data should ALWAYS be preferred over imported data.
**Fix (manual):** Marked `sleep_log` entry as `deleted = 1` in DB.
**Permanent fix needed (red-green TDD approach):**
1. Create a comprehensive import test suite with a table-driven or helper-based approach
2. Test many corner cases: overlapping data, open nights, cross-midnight sleeps, partial overlaps, merge conflicts
3. Import must detect existing native data and prefer it over imported entries
4. Cap open sleeps to reasonable max (e.g. 24h) and flag anomalies
5. Test the full interaction between import and app state (not just import in isolation)

### B31: End sleep lacks date picker for cross-midnight sessions
**Symptom:** When trying to end last night's sleep (started Apr 5, ended Apr 6), the UI only allows entering the time (HH:MM), not the date. This makes it impossible to correctly end a sleep that crosses midnight — the default date logic may use the wrong day.
**Root cause:** The end-sleep form uses `TimeInput` component (always-local HH:MM) but no date override. It infers date from context, which can be wrong for multi-day sleeps.
**Fix needed:** Add an optional date picker to the end-sleep form, or infer date from the previous wake time / sleep start more robustly.

## Must fix

### ~~B20: Baby timezone is null in production~~ — fixed (1727dba)
Auto-backfills from server locale on first state fetch. Production will set "Europe/Oslo" on next app load.

### ~~B21: No DST awareness or warnings~~ — fixed
Added DST transition detection (`dst-utils.ts`) that shows a banner on the dashboard within 3 days of any DST change. Shows Nynorsk guidance: "Sommartid startar [dato] — legg babyen 60 min seinare" or similar for fall-back.

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
