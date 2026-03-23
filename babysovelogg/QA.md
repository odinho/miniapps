# Babysovelogg QA & Roadmap

## Recently Shipped

### Round 1–3: Core UX (done)
Sleep classification, pluralization, sync dot, arc interactions, tag sheets,
wake-up sheets, pause handling, diaper nudge, Norwegian strings, 77 Playwright tests.

### Round 4: Data Safety & Polish (done)
- WAL data loss fix → switched to DELETE journal mode
- Auto-save tag/wake-up sheets on any close (no more lost notes)
- Pill text color fix (black→themed)
- Sleep button icon fix (😴 Sov, ☀️ Vakn)
- "Starta HH:MM" opens full edit modal
- Compact bedtime summary in wake-up sheet
- Diaper edit modal save button
- History shows woke_by, wake_notes, formatted fall-asleep time

### Round 5: Features (done)
- Custom nap count setting (0–4 pills in Settings, overrides age default)
- Potty/babypotting mode (toggle in Settings, replaces diaper UI)
- Arc endpoint time labels (wake-up time, estimated bedtime)
- Arc endpoint taps open sleep entries
- Predicted nap interaction (tap to start or dismiss)
- Renamed Napper → Babysovelogg, napper.db → db.sqlite

---

## Known Issues & Polish

### A. Potty Mode Refinements
- [x] **A1. Potty edit modal in history**
  Clicking a potty entry in history opens the old diaper edit modal.
  Should show potty-specific pills (result + diaper status) matching the log modal.

- [x] **A2. Potty stats/count on dashboard**
  Dashboard shows `diaperCount` but doesn't distinguish potty visits. Could show
  "3 dobesøk" vs "3 bleier" depending on mode.

- [x] **A3. Diaper nudge timing for potty mode**
  2-hour window may not be right for potty training (more frequent attempts typical).
  Consider a setting for nudge interval, or default to 1h in potty mode.

### B. Arc & Predictions
- [x] **B1. Night mode arc endpoint times**
  Currently only day mode shows time labels on arc endpoints. Night mode should
  show bedtime and expected wake-up.

- [ ] **B2. Predicted nap shows only when 0 sleeps today**
  `predictedNaps` is only populated when `todaySleeps.length === 0`. After the first
  nap, individual predictions disappear. Should predict remaining naps based on
  completed ones (pass completed count to `predictDayNaps`).

- [ ] **B3. Predicted nap time adjustment**
  The "Forventa lur" sheet shows time but doesn't let you adjust it. Could add
  time inputs to override the prediction (e.g., "she fell asleep earlier in the car").

- [ ] **B4. Arc tap dead zone**
  The gap between arc endpoints has no tap target. Consider making the center
  text tappable as well (e.g., tap countdown → start sleep).

### C. Data & History
- [ ] **C1. History pagination / infinite scroll**
  Currently loads last 50 entries. For long-term use, need lazy loading or
  date-range filtering UI.

- [ ] **C2. Export data**
  Parents often switch apps or want data for pediatrician visits. Export to CSV
  or JSON would be valuable. Simple download button in settings.

- [x] **C3. Undo last action**
  Accidentally ended a nap? Toast with "Angre" button that reverts the last event
  within 10 seconds. Much better than editing after the fact.

### D. Prediction Engine
- [ ] **D1. Learn from actual sleep patterns**
  Currently uses age-based wake windows as fallback, with 7-day rolling average
  when enough data. Could weight recent days more heavily, detect nap transitions
  earlier, and factor in sleep quality (mood/notes).

- [ ] **D2. Bedtime recommendation based on wake-up goal**
  If parent sets desired wake-up time (e.g., 07:00), work backwards to recommend
  bedtime, last-nap-end, etc.

- [ ] **D3. Nap transition detection feedback**
  The `detectNapTransition` function exists but isn't shown to the user. Surface
  it: "Halldis ser ut til å gå frå 2 til 1 lur. Vil du oppdatera?"

### E. Multi-Baby / Multi-Caretaker
- [ ] **E1. Multiple baby support**
  Schema supports it (baby_id on everything), but UI is single-baby. Tab switcher
  or separate dashboards per baby.

- [ ] **E2. Caretaker identification**
  "Kven la ned?" (who put baby down?) — useful when grandparents/daycare log.
  Just a name/label field on sleep events.

### F. Offline & Sync
- [ ] **F1. Offline queue visibility**
  Show pending event count when offline. "2 hendingar ventar på synkronisering."

- [ ] **F2. Conflict resolution**
  Two devices can start sleep simultaneously. Currently last-write-wins. Should
  detect and show conflict: "Søvn starta frå to einingar — behald kva?"

- [ ] **F3. Service worker cache invalidation**
  Cache name changed to babysovelogg-v1 but there's no versioning strategy for
  updates. New deploys should bust the old cache.

### G. Visual & UX Polish
- [x] **G1. Haptic feedback on mobile**
  `navigator.vibrate(10)` on sleep start/end, pill selection. Subtle tactile
  confirmation.

- [ ] **G2. Swipe gestures**
  Swipe between dashboard/history/stats instead of bottom nav taps. More natural
  on mobile.

- [ ] **G3. Long-press on sleep button for manual entry**
  Quick access to "Legg til søvn" (retroactive sleep entry) without navigating.

- [ ] **G4. Night mode transition animation**
  Theme switches abruptly at 18:00/06:00. Smooth cross-fade would be nicer.

- [ ] **G5. Widget / notification support**
  PWA notification for predicted nap time approaching. "Lur om 15 min!"

### H. Sleep Quality Tracking
- [ ] **H1. Night waking log**
  Track number and duration of night wakings (distinct from pauses). Separate
  from the main sleep — these are interruptions during an otherwise continuous
  night sleep.

- [ ] **H2. Sleep environment tags**
  Dark room, white noise, temperature — optional tags that could correlate with
  sleep quality over time.

- [ ] **H3. Feeding correlation**
  Last feed time before sleep. Parents often want to know if feeding affects
  sleep duration. Optional tag on tag sheet.

---

## Adversarial Review Checklist

- [ ] No feature creep: each change does ONE thing
- [ ] DB migrations are additive only (ALTER TABLE ADD COLUMN with try/catch)
- [ ] No unnecessary abstractions or helpers
- [ ] All strings in Norwegian (nynorsk), no English leaking
- [ ] CSS changes are minimal, scoped
- [ ] No breaking changes to existing data
- [ ] DELETE journal mode: all data in single .db file
- [ ] Graceful shutdown on SIGTERM/SIGINT
- [ ] Tag/wake-up sheets auto-save on any close
- [ ] Potty entries reuse diaper_log table (no new tables)
- [ ] Custom nap count stored as NULL for auto, 0–4 for override
