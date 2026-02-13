# Napper — Implementation Roadmap

Baby sleep & activity tracker. Event-sourced architecture with SQLite backend, vanilla TS frontend.

**App runs at:** `http://localhost:3200` (PORT=3200)
**Working dir:** `/home/openclaw/.openclaw/workspace/miniapps/napper/`
**Build:** `npm run build` (esbuild → dist/)
**Server:** `PORT=3200 node dist/server.js`
**Architecture:** One deploy per family. All clients share the same SQLite database. No auth needed.

---

## Rules for implementation

1. **Complete each step fully before moving to the next.**
2. **Each step must include Playwright e2e tests** covering the new functionality.
3. **Run ALL existing tests after each step** (`npx playwright test`) — they must all pass.
4. **Commit after each step** with a descriptive message.
5. **Build and verify** (`npm run build`) before committing.
6. Keep the app generic — no personal names, no hardcoded baby info.

---

## Step 0: Test Infrastructure (do this first!)

Set up Playwright for the project:
- Install: `npm i -D @playwright/test` + `npx playwright install chromium`
- Create `playwright.config.ts` — start server on a random port, use chromium only
- Create `tests/` directory
- Write baseline tests for existing functionality:
  - Onboarding: app redirects to settings when no baby exists, can create a baby
  - Dashboard: shows baby name, sleep button, can start/stop a nap
  - History: shows logged sleeps, can edit a sleep entry
  - Manual sleep: can add a past sleep via the "+" FAB button
  - Multi-client: second browser context sees the same baby data
- All tests must pass. Commit: `"Add Playwright test infrastructure + baseline tests"`

---

## Step 1: Dark Theme with Day/Night Mode

The app should have a beautiful dark theme inspired by the original Napper app.

### Design:
- **Night mode (default for now):** Deep dark blue/purple background (#1a1a2e → #16213e gradient), stars twinkling (CSS), subtle glow effects
- **Day mode:** Keep current light pastel theme
- **Auto-switch:** Based on time of day (06:00–18:00 = day, else night), or based on baby's current state (sleeping = night theme)
- CSS custom properties for theming (swap `--bg`, `--card`, `--text` etc.)
- Stars: Small dots with twinkle animation scattered on background
- Neon glow on interactive elements (buttons, cards) in dark mode

### Tests:
- Theme switches based on time/state
- Both themes render correctly (no invisible text, contrast OK)

Commit: `"Add dark/night theme with auto-switching"`

---

## Step 2: 12-Hour Arc Visualization (Dashboard)

Replace the current simple dashboard with a 12-hour semicircular arc showing the day/night cycle.

### Design (based on original Napper app):
- **SVG-based semicircular arc** spanning 12 hours
- **Day arc:** From wake-up time to expected bedtime (e.g. 06:00→18:00)
- **Night arc:** From bedtime to expected wake-up (e.g. 18:00→06:00)
- **Flip between day/night:** Day mode shows day arc, night mode shows night arc
- **Anchor icons:** Sunrise (☀️) at start of day arc, sunset (🌅) at end
- **Sleep periods as pill-shaped bubbles** positioned along the arc:
  - Filled/solid = completed sleep
  - Dotted outline = predicted next sleep
  - Glowing/pulsing = currently sleeping
- **Start/end times** shown as labels on the arc bubbles
- **Center content:** Countdown to next nap ("Second nap in 3h 13m"), or elapsed time if sleeping
- **Short naps** shown as small cloud icons below the arc with duration

### Implementation:
- SVG component in `src/ui/arc.ts`
- Calculate positions on arc based on time-of-day
- Use existing prediction engine for predicted naps
- Keep the sleep toggle button (tap to sleep/wake) — integrate it with the arc or below it

### Tests:
- Arc renders with correct time range
- Completed sleeps appear on arc
- Predicted nap shown with dotted style
- Active sleep shown with animation
- Day/night flip works

Commit: `"Add 12-hour arc visualization on dashboard"`

---

## Step 3: Diaper/Activity Logging

Add the ability to log diaper changes (the main non-sleep activity to track).

### Design:
- **Quick-log button** on dashboard (💩 icon or similar) — one tap opens a bottom-sheet
- **Bottom-sheet modal** with:
  - Type: wet 💧, dirty 💩, both 💧💩, dry (pills like nap/night)
  - Amount: lite / middels / mykje (optional, pills)
  - Note: free text (optional)
  - Time: defaults to now, editable (datetime-local)
- **New event type:** `diaper.logged` — {babyId, time, type, amount?, note?}
- **Server projection:** New `diaper_log` table (id, baby_id, time, type, amount, note, deleted)
- **History view:** Show diaper entries interspersed with sleep entries, with appropriate icons
- **Dashboard stat:** "Diapers today: X" card

### Implementation:
- Add `diaper.logged` + `diaper.deleted` event handling in `server/projections.ts`
- Add `diaper_log` table in `server/db.ts`
- New API endpoint: `GET /api/diapers?from=&to=&limit=`
- Include diaper count in `/api/state` response
- Dashboard: quick-log button + today count
- History: merged timeline of sleeps + diapers

### Tests:
- Can log a diaper change
- Diaper appears in history
- Dashboard shows diaper count
- Can delete a diaper entry
- Different types (wet/dirty/both) render correctly

Commit: `"Add diaper/activity logging"`

---

## Step 4: Sleep Metadata (Tags)

Add optional tags when starting or stopping sleep.

### Design:
- **After stopping sleep (or after starting):** Brief bottom-sheet to tag:
  - Mood at start: 😊 happy, 😐 normal, 😢 upset, 😤 fighting sleep
  - How they fell asleep: in bed, nursing, held/worn, stroller, car, bottle
- **Tags are optional** — can dismiss the sheet
- **Show tags in history** as small badges on sleep entries
- **Editable later** via the edit modal

### Implementation:
- New event: `sleep.tagged` — {sleepId, mood?, method?}
- Add `mood` and `method` columns to `sleep_log` table + projection
- Bottom-sheet auto-shows after sleep.ended (with skip option)
- Tags shown as emoji badges in history items

### Tests:
- Tag sheet appears after stopping sleep
- Can select mood and method
- Tags shown in history
- Can edit tags later
- Can skip tagging

Commit: `"Add sleep metadata tagging (mood + method)"`

---

## Step 5: Pause/Resume

Allow pausing and resuming sleep (for brief wake-ups during a nap).

### Design:
- **Pause button** appears on dashboard during active sleep (next to or below timer)
- **Resume button** replaces pause when paused
- **Timer** shows total sleep minus pause duration
- **History** shows pauses within a sleep entry (e.g. "1h 20m (10m pause)")
- **Retroactive:** Can add a pause to a past sleep in edit modal

### Implementation:
- New events: `sleep.paused` {sleepId, pauseTime}, `sleep.resumed` {sleepId, resumeTime}
- New table: `sleep_pauses` (id, sleep_id, pause_time, resume_time)
- Server projection: handle pause/resume events
- Dashboard: pause/resume buttons during active sleep
- Timer: subtract pause duration from elapsed time
- History: show pause info
- `/api/state`: include pause info in activeSleep

### Tests:
- Can pause and resume active sleep
- Timer adjusts for pause duration
- History shows pause duration
- Can add retroactive pause in edit modal
- Multiple pauses work correctly

Commit: `"Add pause/resume for sleep sessions"`

---

## Step 6: Statistics Page

Add a dedicated stats page with charts and insights.

### Design:
- **New nav tab:** 📊 Stats (between History and Settings)
- **Daily summary:** Total sleep, nap count, longest nap, total awake time
- **Week view:** Simple bar chart (CSS-based, no chart library) showing sleep per day
- **Average wake window** from last 7 days
- **Trends:** Sleep per day trend over 2-4 weeks
- **Age comparison:** Compare with age-appropriate recommendations (data already in constants.ts)
- **Diaper stats:** Daily count, trend

### Implementation:
- New file: `src/ui/stats.ts`
- Use existing stats engine (`src/engine/stats.ts`)
- CSS bar charts (div widths proportional to values)
- New API endpoint: `GET /api/stats?days=14` returning pre-calculated stats
- Add nav tab in `main.ts`

### Tests:
- Stats page renders with data
- Bar chart shows correct proportions
- Week summary is accurate
- Diaper stats included

Commit: `"Add statistics page with charts and insights"`

---

## Step 7: Real-time Sync (SSE)

Enable live updates so both parents see changes instantly.

### Design:
- **Server-Sent Events** stream from server
- When any client posts an event, all connected clients receive the update
- **Sync indicator** in UI: green dot = connected, yellow = reconnecting
- Auto-reconnect on disconnect

### Implementation:
- New endpoint: `GET /api/stream` — SSE stream
- Server: maintain list of connected clients, broadcast on new events
- Client: EventSource in `src/sync.ts`, auto-refresh state on message
- Visual indicator: small dot in nav bar or header
- Debounce rapid updates

### Tests:
- Two browser contexts: one logs sleep, other sees it appear
- Sync indicator shows correct state
- Reconnects after disconnect
- Works alongside offline queue

Commit: `"Add real-time sync via Server-Sent Events"`

---

## Step 8: Polish & PWA

Final polish pass.

### 8.1 Animations
- Smooth transitions between views
- Sleep button: satisfying press animation
- Arc: animated nap bubbles appearing
- Haptic feedback (Vibration API) on start/stop

### 8.2 PWA improvements
- App icon (generate a simple moon/baby icon)
- Proper manifest.json with theme colors
- Splash screen
- Fix service worker caching for new assets

### 8.3 Technical cleanup
- Healthcheck endpoint (`/api/health`)
- Error handling improvements
- TypeScript strict where easy

### Tests:
- PWA installable (manifest valid)
- Service worker caches assets
- Health endpoint returns 200

Commit: `"Polish: animations, PWA improvements, cleanup"`

---

## Done ✅
- [x] Event-sourced backend med SQLite
- [x] Start/stopp søvn (nap/night auto-detect)
- [x] Sanntids-timer under pågåande søvn
- [x] Neste-lur-prediksjon basert på wake windows
- [x] Historikk med redigering og sletting
- [x] Offline-køing (localStorage)
- [x] PWA med service worker
- [x] Onboarding (legg til baby)
- [x] Manuell registrering (+FAB, sleep.manual event, edit start time)
- [x] Tidssonefiks (lokal datogruppering i historikk)
