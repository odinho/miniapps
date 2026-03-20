# Babysovelogg UX Fixes & QA Checklist

## Fixes

### A. Critical UX Bugs (blocking normal use)

- [x] **A1. Wake button shows moon during daytime nap**
  The main sleep button always shows 🌙 when sleeping, even during a daytime nap.
  Should show ☀️ (sun/"Vakn") during day, 🌙 only at night.
  _Fix: use time-of-day or sleep type to pick icon._

- [x] **A2. "1 lurar" → "1 lur" pluralization**
  Summary row always says "lurar" even when count is 1. Should be "1 lur", "2 lurar".
  _Fix: conditional plural in summary row._

- [x] **A3. Night sleep mis-classified as nap**
  At ~17:30–17:59, sleep is classified as nap because cutoff is `hour >= 18`. A 9mo baby
  going to bed at 17:45 after a full day should be classified as night.
  _Fix: smarter heuristic — if it's after ~16:00 and the last nap was hours ago (or expected
  naps are done), treat it as night sleep._

- [x] **A4. Settings "green dot" always visible on nav**
  The sync-dot is positioned absolute top-right in the nav, appearing on/near the settings
  icon. Users think settings has a notification badge.
  _Fix: move sync dot away from settings icon, or hide when connected (only show when
  reconnecting/offline)._

- [x] **A5. Active sleep arc segment too low contrast**
  The current-sleep arc bubble pulses between opacity 0.7–1.0 using moon-glow color.
  Hard to see against the track, especially in day mode.
  _Fix: use a more distinct color/stroke, higher minimum opacity, or a subtle fill/outline._

### B. Missing Features (expected in normal use)

- [x] **B1. No click targets on completed nap arc bubbles**
  Completed sleep bubbles on the arc have no tap handler. User can't tap to view/edit a nap
  from the dashboard.
  _Fix: add transparent tap targets on completed bubbles that open the edit modal._

- [x] **B2. Tag sheet: missing "time to fall asleep" buckets**
  After ending a sleep, the tag sheet asks mood/method but not how long it took to put baby
  down. Buckets: <5 min, 5–15 min, 15–30 min, 30+ min.
  _Fix: add "Innsovning" (falling asleep) section to tag sheet + store in DB._

- [x] **B3. Tag sheet: missing notes field for sleep**
  Diaper log has a notes field, sleep does not. Parents want to add context.
  _Fix: add optional note input to tag sheet + edit modal, store in sleep_log.notes._

- [x] **B4. Minutes > 60 should show hours+min in settings**
  Wake window "210–300 min" is shown in the settings sleep info panel. Hard to parse.
  Should show "3h 30m – 5h" when ≥ 60 min.
  _Fix: use formatDuration or similar in settings panel for wake window values._

### C. Data Integrity / Logic Issues

- [x] **C1. Pause at end of nap counts as sleep time in some places**
  If a nap ends while paused, the time during the trailing pause should not be sleep.
  History view subtracts pauses correctly, but stats (engine/stats.ts) does not account
  for pauses at all — it uses raw start_time/end_time.
  _Fix: ensure stats calculation subtracts pause time. Also: if sleep ends paused, the
  effective wake time is the last pause_time, not end_time._

- [x] **C2. Offline clicks give no feedback**
  When offline, button clicks try postEvents, fail silently or hang. Need optimistic UI:
  queue event, update UI immediately, show subtle dirty-state indicator.
  _Fix: wrap action handlers with optimistic path — queue event + update local state + show
  indicator._

### D. Minor Polish

- [x] **D1. Tag sheet mood labels: clarify going-to-bed vs wakeup**
  Current "Humør" is ambiguous — is it how baby was when going to sleep or waking up?
  _Fix: relabel to "Humør ved legging" (Mood at bedtime) to make clear it's about going to
  bed._

- [x] **D2. Stats trend table headers say "7 days" / "30 days" in English**
  Should be "7 dagar" / "30 dagar" in Norwegian.
  _Fix: translate headers._

---

## QA Test Walkthroughs

### Walk 1: First-time setup (evening)
- [ ] Open app with no baby → redirects to settings/onboarding
- [ ] Enter name + birthdate → click "Kom i gang" → navigates to dashboard
- [ ] At night: should NOT show morning prompt, should show reasonable night dashboard
- [ ] App does not hang or get stuck

### Walk 2: Morning start
- [ ] Morning (5–11): shows morning prompt with "God morgon!" and wake time input
- [ ] Enter wake time → dashboard loads with arc, predictions, stats
- [ ] "Hopp over" sets default 06:00 wake time and shows dashboard

### Walk 3: Log a nap (happy path)
- [ ] Click "😴 Lur" button → sleep starts, timer shows, arc updates
- [ ] Wake button shows ☀️ sun icon (not moon) during daytime
- [ ] Click wake button → sleep ends, tag sheet appears
- [ ] Tag sheet has: mood, method, time-to-fall-asleep, notes
- [ ] Fill in tags → save → back to dashboard, nap appears on arc
- [ ] Nap bubble on arc is tappable → opens edit modal

### Walk 4: Log night sleep at 17:45
- [ ] At 17:45 with no pending naps, clicking sleep → type = "night" (not nap)
- [ ] Arc/dashboard reflects night sleep correctly

### Walk 5: Pause during nap
- [ ] Start nap → click Pause → timer freezes, shows "⏸️ Pause"
- [ ] Resume → timer continues from where it left off
- [ ] End sleep → duration in history subtracts pause time
- [ ] Stats also subtract pause time from totals

### Walk 6: Pause at end of nap (baby wakes during re-settle)
- [ ] Start nap → pause → end sleep (while paused)
- [ ] Effective wake time = pause start, not sleep end
- [ ] Duration does not include trailing pause

### Walk 7: Pluralization
- [ ] 0 naps: "0 lurar"
- [ ] 1 nap: "1 lur"
- [ ] 2+ naps: "2 lurar"

### Walk 8: Settings & sync dot
- [ ] Settings icon has NO notification badge
- [ ] Sync dot only visible when reconnecting or offline (not when connected)

### Walk 9: Offline use
- [ ] Disconnect network → tap "😴 Lur" → immediate feedback, timer starts
- [ ] Toast/indicator shows offline/pending state
- [ ] Reconnect → events flush, state syncs

### Walk 10: Minutes display in settings
- [ ] Wake window shows "3h 30m – 5h" format (not "210–300 min") for older babies

---

## Adversarial Review Checklist

- [ ] No feature creep: each fix does ONE thing
- [ ] No new DB migrations unless absolutely needed (B2 needs sleep_log.fall_asleep_time column)
- [ ] No unnecessary abstractions or helpers
- [ ] All strings in Norwegian (nynorsk), no English leaking
- [ ] CSS changes are minimal, scoped
- [ ] No breaking changes to existing data
- [ ] Pause edge cases tested (trailing pause, multiple pauses, no pauses)
- [ ] Offline path tested (queue, flush, no data loss)
