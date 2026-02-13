# Napper (babysovelogg) — Implementation Roadmap

Baby sleep & activity tracker. Event-sourced architecture with SQLite backend, vanilla TS frontend.

**Working dir:** `/home/openclaw/.openclaw/workspace/miniapps/babysovelogg/`
**Build:** `npm run build` (esbuild → dist/)
**Run:** `PORT=3200 node dist/server.js`
**Test:** `npx playwright test`
**Architecture:** One deploy per family. All clients share the same SQLite database. No auth needed.

---

## Rules for implementation

1. **Complete each step fully before moving to the next.**
2. **Each step MUST include Playwright e2e tests** covering the new functionality.
3. **Run ALL existing tests after each step** (`npx playwright test`) — they must all pass before committing.
4. **Build and verify** (`npm run build`) before committing.
5. **Commit after each step** with the exact commit message specified.
6. **Restart server** after rebuilding: `kill $(lsof -t -i :3200) 2>/dev/null; PORT=3200 node dist/server.js &`
7. **Read existing source files before modifying** — understand the patterns.
8. **Keep the app generic** — no personal names or hardcoded baby info.
9. **Use sub-agents** for each step. Spawn one sub-agent per step so you keep orchestration context. After each sub-agent completes, verify tests pass, then move to the next.
10. **Review after each step.** Spawn a short review sub-agent to check code quality, test coverage, and that nothing broke. Fix issues before proceeding.

---

## Step 0: Test Infrastructure

Set up Playwright baseline tests for all existing functionality.

Playwright is already installed. There's a `playwright.config.ts` and a `tests/` directory with one test file. Extend it:

- Baseline tests for:
  - Onboarding: app redirects to settings when no baby exists, can create a baby
  - Dashboard: shows baby name, sleep button, can start/stop a nap
  - History: shows logged sleeps, can edit a sleep entry
  - Manual sleep: can add a past sleep via the "+" FAB button
  - Multi-client: second browser context sees the same baby data (same server)
- All tests must pass.

Commit: `"Add Playwright baseline tests for existing functionality"`

---

## Step 1: Dark Theme with Day/Night Mode

### Design:
- **Night mode:** Deep dark blue/purple background (#1a1a2e → #16213e gradient), twinkling stars (CSS), subtle glow effects
- **Day mode:** Keep current light pastel theme
- **Auto-switch:** Based on time of day (06:00–18:00 = day, else night)
- CSS custom properties for theming (swap --bg, --card, --text etc.)
- Stars: Small dots with twinkle animation on background
- Neon glow on interactive elements in dark mode

### Tests:
- Theme applies CSS variables correctly
- Both themes render without broken contrast

Commit: `"Add dark/night theme with auto-switching"`

---

## Step 2: 12-Hour Arc Visualization (Dashboard)

Replace the simple dashboard with a 12-hour semicircular arc.

### Design (see original Napper app for reference):
- **SVG semicircular arc** spanning ~12 hours
- **Day arc:** Wake-up → expected bedtime (roughly 06→18)
- **Night arc:** Bedtime → expected wake-up (roughly 18→06)
- **Flip:** Day mode shows day arc, night mode shows night arc
- **Anchor icons:** Sunrise (☀️) at arc start, sunset (🌅) at arc end
- **Sleep periods as pill-shaped bubbles** on the arc:
  - Filled = completed sleep
  - Dotted outline = predicted next sleep
  - Glowing/pulsing = currently sleeping
- **Time labels** on bubbles
- **Center:** Countdown to next nap or elapsed sleep timer
- **Short naps:** Small cloud icons below arc with duration

### Implementation:
- New file: `src/ui/arc.ts` (SVG component)
- Calculate arc positions from time-of-day
- Use existing prediction engine for predicted naps
- Keep sleep toggle button, integrate with arc

### Tests:
- Arc renders with time range
- Completed sleeps appear on arc
- Predicted nap shown differently from completed
- Active sleep has animation

Commit: `"Add 12-hour arc visualization on dashboard"`

---

## Step 3: Diaper/Activity Logging

### Design:
- **Quick-log button** on dashboard (💩 icon)
- **Bottom-sheet:** Type (wet 💧, dirty 💩, both, dry), amount (lite/middels/mykje), note, time
- **Event:** `diaper.logged` — {babyId, time, type, amount?, note?}
- **Server:** New `diaper_log` table, projection for diaper.logged + diaper.deleted
- **API:** `GET /api/diapers`, diaper count in `/api/state`
- **History:** Diaper entries interspersed with sleep entries
- **Dashboard:** "Diapers today: X" stat card

### Tests:
- Can log a diaper change
- Shows in history
- Dashboard count updates
- Can delete entry

Commit: `"Add diaper/activity logging"`

---

## Step 4: Sleep Metadata (Tags)

### Design:
- After stopping sleep: optional bottom-sheet for tags
  - Mood: 😊 happy, 😐 normal, 😢 upset, 😤 fighting sleep
  - Method: in bed, nursing, held/worn, stroller, car, bottle
- Tags optional (dismissable)
- Show as emoji badges in history
- Editable in edit modal

### Implementation:
- Event: `sleep.tagged` — {sleepId, mood?, method?}
- Add mood/method columns to sleep_log + projection
- Bottom-sheet after sleep.ended

### Tests:
- Tag sheet appears after stopping sleep
- Can select and save tags
- Tags shown in history
- Can skip tagging

Commit: `"Add sleep metadata tagging (mood + method)"`

---

## Step 5: Pause/Resume

### Design:
- Pause/resume buttons during active sleep
- Timer subtracts pause duration
- History shows pauses
- Can add retroactive pause in edit modal

### Implementation:
- Events: `sleep.paused`, `sleep.resumed`
- Table: `sleep_pauses`
- Dashboard: pause/resume buttons
- Timer: adjust for pauses

### Tests:
- Can pause and resume
- Timer adjusts correctly
- History shows pause info
- Multiple pauses work

Commit: `"Add pause/resume for sleep sessions"`

---

## Step 6: Statistics Page

### Design:
- Nav tab: 📊 Stats
- Daily summary, week bar chart (CSS-based), average wake window
- Trends over 2-4 weeks
- Age comparison with recommendations
- Diaper stats

### Implementation:
- New: `src/ui/stats.ts`
- New API: `GET /api/stats?days=14`
- Add nav tab in main.ts

### Tests:
- Stats page renders
- Bar chart proportions correct
- Data accurate

Commit: `"Add statistics page with charts and insights"`

---

## Step 7: Real-time Sync (SSE)

### Design:
- SSE stream from server
- All clients receive updates when any client posts
- Sync indicator (green/yellow dot)
- Auto-reconnect

### Implementation:
- Endpoint: `GET /api/stream`
- Server: broadcast to connected clients
- Client: EventSource in sync.ts
- Visual indicator in nav

### Tests:
- Two contexts: one logs, other sees update
- Reconnects after disconnect

Commit: `"Add real-time sync via Server-Sent Events"`

---

## Step 8: Polish & PWA

- Smooth view transitions
- Press animations on buttons
- Haptic feedback (Vibration API)
- App icon + proper manifest
- Service worker cache update
- `/api/health` endpoint

### Tests:
- Manifest valid
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
