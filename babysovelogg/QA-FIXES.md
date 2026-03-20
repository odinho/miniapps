# Babysovelogg UX Fixes & QA Checklist

## Fixes — Round 1 (done)

### A. Critical UX Bugs

- [x] **A1. Wake button shows moon during daytime nap**
  _Fix: icon based on sleep type (☀️ nap, 🌙 night), not always moon._

- [x] **A2. "1 lurar" → "1 lur" pluralization**
  _Fix: MutationObserver on count element toggles singular/plural._

- [x] **A3. Night sleep mis-classified as nap**
  _Fix: smart classifier — after 16:00, if expected naps (by age) are done → night._

- [x] **A4. Settings "green dot" always visible on nav**
  _Fix: sync dot hidden when SSE connected, only shown on reconnecting/offline._

- [x] **A5. Active sleep arc segment too low contrast**
  _Fix: type-matched color (peach nap, moon night) + min opacity 0.85._

### B. Missing Features

- [x] **B1. No click targets on completed nap arc bubbles**
  _Fix: transparent tap target on completed bubbles → opens edit modal._

- [x] **B2. Tag sheet: missing "time to fall asleep" buckets**
  _Fix: 4 buckets (<5, 5–15, 15–30, 30+ min) + DB column fall_asleep_time._

- [x] **B3. Tag sheet: missing notes field for sleep**
  _Fix: optional note input on tag sheet + edit modal._

- [x] **B4. Minutes > 60 should show hours+min in settings**
  _Fix: formatDuration for wake window values ≥ 60 min._

### C. Data Integrity / Logic

- [x] **C1. Pause at end of nap counts as sleep time**
  _Fix: stats subtract pause duration; trailing pauses use end_time as pause end._

- [x] **C2. Offline clicks give no feedback**
  _Fix: sendEvent() helper queues + shows toast "Lagra offline — synkar snart"._

### D. Minor Polish

- [x] **D1. Tag sheet mood label clarified**
  _Fix: "Humør ved legging" (mood at bedtime)._

- [x] **D2. Stats headers translated to Norwegian**
  _Fix: "7 dagar" / "30 dagar"._

## Fixes — Round 2 (done)

- [x] **E1. Tag sheet shown on wake-up instead of sleep-start (duplicate nap feeling)**
  Bedtime details (mood, method, fall-asleep, notes) should be captured when
  STARTING sleep — that's when you remember how bedtime went. Showing it on
  wake-up was confusing and could overwrite previously set data.
  _Fix: tag sheet now appears on sleep START. New "Oppvakning" (wake-up) sheet
  on sleep END — saves end time immediately, then optionally captures woke_by
  (self/woken) and wake notes._

## Fixes — Round 3 (TODO for next session)

- [x] **F1. Existing Playwright tests use old English strings**
  Tests reference "How did it go?", "Happy", "Nursing", "Save", "Skip", "Naps today",
  "Welcome to Napper", etc. All UI is now Norwegian nynorsk (hardcoded, no i18n system).
  Tests will fail. _Fix: update all test assertions to match current Norwegian strings.
  Also updated tag sheet flow (now on sleep START), added `forceMorning` helper for
  time-independent tests, fixed custom confirm dialog handling._

- [x] **F2. Diaper-before-bed nudge (nice-to-have extra)**
  User wants a subtle nudge to log diaper before bedtime so they remember to check
  the potty on wake-up. Not core functionality — should be an optional/discoverable feature.
  _Fix: if no diaper logged in last 2h, bedtime tag sheet shows "🧷 Inga bleie dei siste
  2 timane" with a "Logg bleie" button that opens the diaper modal. Server state now
  includes `lastDiaperTime`._

---

## Playwright Test Plan

All existing tests need updating (English → Norwegian). Additionally, write these scenario tests.
Tests should use the existing fixture pattern (resetDb, createBaby, setWakeUpTime, addCompletedSleep, addActiveSleep).

### PW 1: Onboarding flow (`tests/onboarding.spec.ts`)
- [ ] No baby → redirects to settings, shows "Velkomen til Napper"
- [ ] Enter name + birthdate → "Kom i gang" → navigates to dashboard
- [ ] Dashboard shows baby name and age

### PW 2: Morning prompt (`tests/wakeup.spec.ts`)
- [ ] Morning hours + no wake time → shows "God morgon!" prompt
- [ ] Enter wake time → dashboard loads with predictions
- [ ] "Hopp over" → dashboard loads with default wake time
- [ ] Night hours → does NOT show morning prompt

### PW 3: Start nap + bedtime tag sheet (`tests/nap-flow.spec.ts`)
- [ ] Click "😴 Lur" → sleep starts, timer visible, button shows ☀️ + "Vakn"
- [ ] Bedtime tag sheet "Korleis gjekk legginga?" appears
- [ ] Can select mood, method, fall-asleep bucket, enter note → save
- [ ] Tags persist — visible in Logg view on that sleep entry
- [ ] Skip tag sheet → sleep still running, no tags set

### PW 4: End nap + wake-up sheet (`tests/nap-flow.spec.ts`)
- [ ] While sleeping, click "Vakn" → sleep ends immediately
- [ ] Wake-up sheet "Oppvakning" appears with "Vakna sjølv" / "Vekt av oss"
- [ ] Can enter wake-up note → save
- [ ] Skip → sleep ended, dashboard shows awake state
- [ ] Previously set bedtime tags are NOT overwritten by wake-up sheet

### PW 5: Night sleep classification at 17:xx (`tests/classification.spec.ts`)
- [ ] Baby with 2 expected naps, 2 completed naps → new sleep at 17:45 → type = "night"
- [ ] Baby with 2 expected naps, 0 completed naps → new sleep at 17:00 → type = "nap"
- [ ] Any time after 20:00 → always "night"
- [ ] Any time before 16:00 → always "nap"

### PW 6: Pause flow (`tests/pause.spec.ts`)
- [ ] Start nap → pause → timer label shows "⏸️ Pause"
- [ ] Resume → timer continues
- [ ] End nap → history shows duration minus pause time
- [ ] End nap while paused → duration excludes trailing pause

### PW 7: Arc interactions (`tests/arc.spec.ts`)
- [ ] Completed nap bubble on arc is clickable → opens edit modal
- [ ] Active sleep bubble visible with pulsing animation
- [ ] Arc center text shows timer when sleeping, countdown when awake

### PW 8: Pluralization (`tests/dashboard.spec.ts`)
- [ ] 0 completed naps: "0 lurar"
- [ ] 1 completed nap: "1 lur"
- [ ] 2 completed naps: "2 lurar"

### PW 9: Settings display (`tests/settings.spec.ts`)
- [ ] Wake window shows "Xh Ym" format for values ≥ 60 min
- [ ] "1 lur" / "2 lurar" pluralization in sleep info panel
- [ ] Sync dot not visible when connected

### PW 10: History edit (`tests/history.spec.ts`)
- [ ] Click sleep entry → edit modal with type, times, mood, method, fall-asleep, notes
- [ ] Change type nap → night → save → reflected in list
- [ ] Delete entry → confirm → entry removed
- [ ] Notes and fall-asleep-time visible in history list

### PW 11: Stats (`tests/stats.spec.ts`)
- [ ] Headers say "7 dagar" / "30 dagar" (not English)
- [ ] Stats subtract pause time from sleep durations
- [ ] Bar chart renders with nap + night bars

---

## Adversarial Review Checklist

- [ ] No feature creep: each fix does ONE thing
- [ ] DB migrations are additive only (ALTER TABLE ADD COLUMN with try/catch)
- [ ] No unnecessary abstractions or helpers
- [ ] All strings in Norwegian (nynorsk), no English leaking
- [ ] CSS changes are minimal, scoped
- [ ] No breaking changes to existing data
- [ ] Pause edge cases tested (trailing pause, multiple pauses, no pauses)
- [ ] Offline path tested (queue, flush, no data loss)
- [ ] Tag sheet on start doesn't block timer from running
- [ ] Wake-up sheet saves end_time before showing modal (no data loss if dismissed)
- [ ] Existing bedtime tags preserved when wake-up sheet is used
