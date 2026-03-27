# Bugs

Incoming bug reports collected from screenshots 2026-03-23 – 2026-03-26.

Legend: ✅ Fixed  ⚠️ Partial  🔧 Fixed this session

---

## B1 – Wakeup dialog shown again after wakeup time is already set ✅
**Screenshot:** 2026-03-24 05:59
**Steps:** Set wakeup time via the wake button → "God morgon!" dialog appears again shortly after.
**Expected:** Dialog only appears once; confirming it dismisses it for the day.
**Also:** Dialog shows 05:59 but user reports having set it to 05:50 — the saved time may also be off.
**Fix:** `sessionStorage` flag + `todayWakeUp` server-side check prevents re-showing (748e0d5).
**Test:** `wakeup.e2e.ts` — "Morning prompt only shows once per day"

---

## B2 – Prediction engine suggests naps at wrong times ✅
**Screenshot:** 2026-03-24 08:43
**Description:** At 08:43 with wake time 06:00, the dashboard suggests "NESTE LUR 46m" (i.e. nap at ~09:29). This is too early for a 9-month-old and seems algorithmically unsound. User has 1 expected nap configured (not auto).
**Suspicion:** Algorithm may not correctly factor in wake time, expected number of naps, or typical wake windows for the age.
**Fix:** Switched from simple wake-window prediction to `predictDayNaps()` which respects custom nap count, positional wake windows, and age-appropriate defaults (230a8e3). For a 9-month-old with 1 custom nap and no recent data, default WW is 180 min → nap at 09:00.
**Test:** `state.unit.ts` — "Respects custom nap count", "Predicted nap schedule uses day schedule"

---

## B3 – "1 dobesøk" counter looks visually off on dashboard ✅
**Screenshot:** 2026-03-24 08:50
**Description:** The diaper/toilet count ("1 dobesøk") on the dashboard has different styling from the nap counter — it looks inconsistent and out of place.
**Fix:** Consistent styling for dobesøk counter alongside nap stats (cd412f9).
**Test:** `dashboard.e2e.ts` — "Dashboard shows diaper count in summary"

---

## B4 – Sleep-info page doesn't show the app's own calculation ✅
**Screenshot:** 2026-03-24 08:51
**Description:** The "Søvninfo" settings section shows generic age-based reference data but does not reveal what the app has calculated for this baby, nor how the prediction logic works.
**Fix:** Settings now shows the app's computed wake windows, learned nap duration, and expected nap count (b5e0ccb).

---

## B5 – Diaper poop result not shown in log list summary ✅
**Screenshot:** 2026-03-24 08:54
**Description:** A diaper entry logged with "Bæsj" (poop) as the result only shows "Do" in the log list. The actual result (poop) is not reflected in the summary line.
**Fix:** History now shows `DIAPER_LABELS[type]` (e.g. "Skitten", "Bæsj på do") in the log meta (748e0d5).
**Test:** `bugs.e2e.ts` — "B5: dirty diaper shows type in history log"; `bugs.test.ts` — "B5: diaper with dirty type preserves type in response"

---

## B6 – Notes on diaper entries not visible in log list ✅
**Screenshot:** 2026-03-24 08:54
**Description:** Notes attached to a diaper log entry are not shown in the log list view at all.
**Fix:** History renders `entry.note` in an italic div when present (748e0d5).
**Test:** `bugs.e2e.ts` — "B6: diaper notes are visible in history log"; `bugs.test.ts` — "B6: diaper note is stored and returned"

---

## B7 – Sleep arc on circle looks visually wrong during paused nap ✅
**Screenshot:** 2026-03-24 12:35
**Description:** While a nap is active and in "Pause" state, the arc drawn on the clock circle appears malformed or positioned incorrectly.
**Fix:** Arc freezes at the pause time instead of growing with current time (63d4465). Dashboard passes `isPaused` and `pauseTime` to the arc renderer.
**Test:** `pause.e2e.ts` — "Can pause and resume", "Timer adjusts for pause duration"

---

## B8 – Dashboard suggests nap instead of switching to bedtime mode near end of day ✅
**Screenshot:** 2026-03-24 16:51
**Description:** At 16:51 with bedtime expected around 18:00, the dashboard shows "NESTE LUR 16m" (next nap in 16 min) instead of entering bedtime mode. A nap at 17:07 doesn't make sense this close to bedtime.
**Fix:** Predicted naps starting within 60 min of bedtime are filtered out. If nextNap is too close to bedtime, shows bedtime instead (230a8e3, state.ts lines 65-89).
**Test:** `state.unit.ts` — "Suppresses naps close to bedtime"

---

## B9 – Adding a diaper entry causes large unexpected jump in bedtime countdown ✅
**Screenshot:** 2026-03-24 17:47
**Description:** Bedtime countdown was showing ~46 minutes overtime. After logging a diaper visit, it jumped to 12 minutes. Logging a diaper entry should not affect sleep prediction or the bedtime countdown.
**Root cause:** Stale state from offline mode. Adding a diaper triggered SSE reconnect + full state refresh, which recalculated bedtime from fresh data. The prediction engine only uses sleep data, not diapers.
**Fix:** SSE reconnect flush ensures state is always fresh (46d2b1d). Prediction is immune to diapers by design.

---

## B10 – Diaper form: "Litt" wetness option and inconsistent time picker ✅
**Screenshot:** 2026-03-25 09:41
**Two issues in the "Logg dobesøk" form:**
- "Litt" (a little) feels like an odd default/prominent selection — the options "Tørr / Litt / Våt / Bæsj" as a linear scale is a bit confusing; consider whether "Full" should also be an option.
- The time picker component in this form looks different from the one used in the wakeup/bedtime dialogs. Should use the same component.
**Fix:** Clearer labels for potty form: Tiss/Bæsj/Ingenting/Berre bleie as results, separate bleie status (Tørr/Litt våt/Våt/Skitten). Consistent form styling (cd412f9).

---

## B11 – Dashboard doesn't indicate overtime when a nap is skipped 🔧
**Screenshot:** 2026-03-25 09:43
**Description:** When the nap window passes without a nap being logged (baby refuses to sleep), the dashboard moves on to showing future bedtime as if nothing happened. It should instead indicate that the baby is X minutes overtime/overtired. The skipped nap is effectively forgotten.
**Root cause:** The `showBedtime` condition included `hoursUntilNap < 0`, making the "Overtid" branch unreachable dead code. When a nap was overdue, the dashboard always jumped straight to bedtime.
**Fix:** Removed `hoursUntilNap < 0` from `showBedtime` condition. Now when a predicted nap is overdue but naps aren't all done and it's not evening, the dashboard shows "Overtid +Xm" indicating the baby is overtired.
**Test:** `bugs.e2e.ts` — "B11: shows overtime when predicted nap time has passed", "B11: shows bedtime when all expected naps are completed"

---

## B12 – Wakeup time not visible as an entry in the log ✅
**Screenshot:** 2026-03-26 06:35
**Description:** After entering wakeup time (06:10) via the "God morgon!" dialog, no corresponding entry appears anywhere in the log. It's unclear where or whether the wakeup event is recorded.
**Fix:** History view fetches wakeup entries from `/api/wakeups` and renders them as ☀️ Vakna rows (81338a0).
**Test:** `bugs.e2e.ts` — "B12: wakeup time appears as entry in history"; `bugs.test.ts` — "B12: GET /api/wakeups returns day_start entries"

---

## B13 – App stuck in offline state; no recovery path for missing yesterday data ✅
**Screenshot:** 2026-03-26 06:38
**Description:** After going offline overnight, the app shows the "God morgon!" dialog but remains stuck in an offline state. There is no evening data from the night before (missed bedtime logging), and no way to go back and fill in yesterday's bedtime. The offline badge is shown but the SSE connection appears broken/unreliable. User does not trust the current state of the data.
**Fix:** SSE reconnect flushes pending events on reconnect. History view adds "+ Legg til søvn" button for retroactive manual entries (46d2b1d).

---

## B14 – Missing `sleep.started` event for evening; no UI to fix it ✅
**Screenshot:** 2026-03-26 06:41
**Description:** The raw event log (Hendingslogg) shows no `sleep.started` event for the previous evening. There is no accessible UI in the main app to add or correct this retroactively. The event log is developer-facing and confusing for end users.
**Fix:** Manual sleep entry modal in history view allows adding past sleeps with start time, end time, and type. Sends `sleep.manual` event (46d2b1d).

---

## B15 – Editing a nap to become a night sleep deletes the entry ✅
**Screenshot:** 2026-03-26 06:46
**Description:** A nap is added successfully, but when it is edited and changed to "søvn" (night sleep) type, the entry disappears from the log entirely — and no night sleep entry appears in its place. The data is lost.
**Fix:** The `sleep.updated` projection correctly updates the `type` field via SQL UPDATE. The original bug was likely caused by a client-side rendering issue (stale filter). Server-side confirmed working (748e0d5).
**Test:** `bugs.e2e.ts` — "B15: changing sleep type from nap to night preserves the entry"; `bugs.test.ts` — "B15: sleep.updated changing type from nap to night preserves the entry"

---

## B16 – Suggested nap shown in countdown but not visible on the arc ✅
**Screenshot:** 2026-03-26 14:00
**Description:** Dashboard shows "NESTE LUR 17m" with no corresponding visual representation on the clock arc. An invisible/unregistered predicted nap is apparently driving the countdown without being shown to the user.
**Fix:** Arc now renders predicted naps as semi-transparent bubbles when `prediction.predictedNaps` is populated (63d4465). Dashboard filters predictions and passes them to arc renderer.
**Test:** `wakeup.e2e.ts` — "Shows predicted nap bubbles when no sleeps yet"

---

## B17 – Clicking the moon at 18:01 shows the morning wakeup dialog 🔧
**Screenshot:** 2026-03-26 18:01
**Description:** Shortly after bedtime (18:00), tapping the moon icon on the dashboard triggers the "God morgon! Når vakna babyen i dag?" dialog — which is completely wrong in a post-bedtime context. The tap target/dialog mapping doesn't account for the post-bedtime state. The dialog even pre-fills 18:01 as the wake time.
**Root cause:** The "☀️ Morgon" action button and the arc's end-icon click both showed the wake panel unconditionally in night mode, even right after bedtime (18-24h) when morning makes no sense.
**Fix:** Morning button and arc end-click wake panel are now only available when `currentHour < 12` (midnight to noon), not in the evening hours (18-24). Night waking button (🌙) remains always available.
**Test:** `bugs.e2e.ts` — "B17: morning button not shown in early night hours", "B17: morning button IS shown in late night hours"

---

## B18 – Morning prompt reappears after ending night sleep 🔧
**Screenshot:** 2026-03-27 06:13, 06:22
**Description:** After ending a night sleep at ~05:50 (the baby woke up), the morning prompt "God morgon! Når vakna babyen?" appears AGAIN. This creates a spurious duplicate wakeup entry in the log. The ending of a night sleep IS the morning — there's no need for a separate wakeup dialog.
**Root cause:** `todaySleeps` only includes sleeps with `start_time >= today 00:00`. A night sleep that started yesterday isn't in `todaySleeps`, so the morning prompt condition `!todayWakeUp && todaySleeps.length === 0 && !activeSleep` passes.
**Fix:** When ending a night sleep, automatically send a `day.started` event with the end time as the wakeup time. The wake-up sheet also updates the wakeup if the user adjusts the end time.
**Test:** `bugs.e2e.ts` — "B18: ending night sleep auto-sets wakeup, no morning prompt"

---

## B19 – Settings prediction: only shows next nap, not reactive 🔧
**Screenshot:** 2026-03-27 06:17, 06:18
**Description:** The "Appen reknar med" section in settings only shows "Neste lur" (next nap), not all predicted naps for the day. When the user changes the nap count (e.g., from Auto/2 to 1), the prediction doesn't update until after saving and reloading.
**Fix:** Settings now shows all predicted nap times ("Lur 1", "Lur 2", etc.) with start–end ranges. Prediction recomputes client-side when the nap count pill is tapped, using `predictDayNaps()` and `recommendBedtime()` directly.
**Test:** `bugs.e2e.ts` — "B19: settings shows all predicted nap times", "B19: settings prediction updates reactively when changing nap count"
