# Phase 3 stats: multi-child charting refactor + twin overlay (design)

Decision (Odin, 2026-06-14): **P3-1 = B (full twin overlay)**, but **refactor
the charting first** so multi-series is easy, then implement overlay as step 2.
Open-ended Codex design below drove this. Twins → overlay (two color-coded
series in one chart); mixed-age siblings → two-up/stacked. Unblocks P3-2
(overlap viz) + P3-3 (comparison stats).

## Codex design (open-ended, 2026-06-14)

### 1. Current code assessment
- **Good:** self-contained single-baby path — fetch sleeps/diapers →
  `computeAllStats(...)` → render `activeStats` (30-day or full) at
  `src/routes/stats/+page.svelte:68-121`. Style prefs already encoded: no
  point markers, translucent fills, stark lines, click-to-fullscreen
  (`+page.svelte:262-278, 293-311, 326-346, 357-372, 383-399, 609-620`).
- **Painful:** `stats-view-utils.ts` mixes everything — computes stats, fetches
  API data, builds SVG paths, axes, gantt rects, heatmap cells, labels
  (`:32-72, 115-188, 209-263, 528-636, 772-808, 946-1065`). The SVG frame
  (grid, y ticks, x labels, wrapper, fullscreen, legend) is hand-duplicated per
  chart (`+page.svelte:256-399, 528-579`); gantt/heatmap repeat axes inline
  (`:459-523`).
- **Blocks multi-series:** every chart datatype is single-baby — `StackedAreaData`
  one `nightPath`/`napPath`/`rollingAvgPath` (`stats-view-utils.ts:193-207`);
  `SleepVsNormData` one `actualPath`+band (`:83-99`); `NightStretch/Bedtime/
  NapCount` singular `linePath`/`areaPath`/`dots` (`:268-284, 350-358, 422-430`);
  `GanttBlock` has `type` but no `babyId` (`:508-520`). Scales are computed per
  single-series builder from only that child's data (`:136-148, 218-224,
  293-303, 367-383, 440-459`) — overlay needs SHARED x/y scales or identical
  days/durations won't line up.
- **Already exists:** `AppState.babies` per-child slices + primary alias
  (`app.svelte.ts:229-280, 296-360`); `family.isTwinMode` (`family.ts:11-23`);
  `/api/sleeps?baby=` + `/api/diapers?baby=` scoping (`api/sleeps/+server.ts:7-28`,
  `api/diapers/+server.ts:6-21`, `db.ts:416-428`).

### 2. Proposed architecture (small chart system, NOT a chart library)
Stop making `stats-view-utils.ts` the place SVG path strings are born. Shape
semantic chart data first (dates, values, blocks, child metadata, intent), then
produce pixel geometry once the page knows single vs twin-overlay vs sibling
two-up.
- `src/lib/stats/stats-series.ts` — pure data shaping. In: `{baby, sleeps,
  diapers, tz, birthdate}[]`. Out: `ChildStatsSeries[]` (id/name/color token,
  daily totals, nap/night totals, bedtime points, night stretches, nap counts,
  gantt blocks, norm metadata). No SVG.
- `src/lib/charts/scales.ts` — shared scale helpers (time/index x, linear y,
  bedtime-hour y, 24h gantt x, ticks). Where "shared scale across children" lives.
- `src/lib/charts/paths.ts` — path generation only (line, area, stacked, rolling,
  norm band); accepts arrays of series + shared scales.
- `src/lib/components/charts/ChartFrame.svelte` — wrapper/card/fullscreen
  trigger; owns `.stats-chart-wrap`, title/legend slots. Move the
  `outerHTML`-clone fullscreen (`+page.svelte:81-95, 609-620`) in here.
- `ChartFullscreen.svelte` — reusable overlay (behavior from `+page.svelte:624-688`).
- `TimeSeriesChart.svelte` — generic axes/grid/labels/bands/areas/lines; props
  are render-ready series descriptors, supports N line/area series + reference
  bands; no dots by default.
- `SleepTimelineChart.svelte` — gantt; props rows-by-date + blocks `{childId,
  type, x, width, lane, color}`. Twin overlay = same date rows + thin per-child
  lanes (preferred) or translucent overlap; siblings = two instances.
- `ChartLegend.svelte` — distinguish CHILD color first, sleep type second
  (`.stats-legend`/`.stats-dot` exist `app.css:1309-1329`).
- **Mode decision lives in the route** (`+page.svelte` or a route-local
  view-model): `statsMode = single | twinOverlay | siblingTwoUp` from
  `appState.babies.length` + `family.isTwinMode`. Charts only render the mode
  given. Siblings two-up because age norms differ — overlaying norm bands across
  ages falsely implies head-to-head.

### 3. Dependency: add d3 MODULES, not a framework
Add `d3-scale`, `d3-shape`, `d3-array` (small functional utils, plain SVG path
output, Svelte keeps markup control). The repo has no chart dep today (only
valibot, web-push — `package.json:23-26`) and already hand-reimplements scales/
areas/rolling/stacked/gantt/ticks (`stats-view-utils.ts:43-72, 145-157, 226-239,
299-310, 539-545, 610-616`). Avoid LayerCake/Recharts-style abstractions.

### 4. Highest risks
- **Single-baby daily-glance regression** — Step 1 MUST keep `/stats` visually +
  behaviorally identical at N=1 (route reads primary alias `+page.svelte:20-24,
  109-121`; alias preserved `app.svelte.ts:273-280`).
- **Scale regressions** — builders exclude today's incomplete data
  (`:1002-1007`) and filter zero-data days (`:119-123, 212-216, 435-438`); naive
  day alignment can reintroduce false zero drops / mismatched x.
- **Gantt** — duplicates cross-midnight sleeps onto both start+end rows with
  per-row clipping (`:546-617`); overlay must preserve EXACTLY before adding
  child offsets/colors.
- **Fullscreen** — copies SVG `outerHTML` + `{@html}` (`+page.svelte:81-95,
  618-620`); componentizing can break it if overlay depends on wrapper DOM/scoped
  styles.
- **Latent bug/opportunity:** `computeAllStats` maps sleeps to only
  start/end/type (`:977-981`) while `netDurationMin` can subtract pauses
  (`engine/stats.ts:19-39`). If pauses should affect charts, fix as a SEPARATE
  intentional behavior change (not in Step 1).

### 5. Staged plan
**Step 1 (refactor, single-baby unchanged):**
- `src/lib/charts/types.ts` (dims, margins, ticks, legend items, bands, series,
  gantt rows/blocks).
- `src/lib/charts/scales.ts` (move `TS_CHART`, `GANTT`, `tsX`, y-scales, ticks
  from `stats-view-utils.ts:32-72, 499-506`).
- `src/lib/charts/paths.ts` (port `:115-188, 209-263, 286-339, 360-417, 432-494`).
- chart components `ChartFrame/ChartFullscreen/ChartLegend/TimeSeriesChart/
  SleepTimelineChart`.
- `stats-view-utils.ts` builders return generic render models / call path
  helpers, keep `ComputedStats` shape initially → migrate one chart at a time.
- `+page.svelte` replace inline SVG per chart (start: one time-series + gantt),
  same conditions/titles/colors/opacity/dims/legends/fullscreen.
- `app.css` only move local fullscreen/chart rules to reusable classes if needed;
  preserve `.stats-chart-wrap`/`.stats-legend`/`.stats-dot` (`:1302-1329`).

**Step 2 (twin overlay + sibling two-up):**
- `src/lib/stats/multi-child-stats.ts`: `computeStatsForChildren(children, opts)`
  — fetch/accept per-child sleeps+diapers, reuse single-baby computations for
  summary tables, build shared-domain chart inputs.
- fetch helpers request `/api/sleeps?baby=` + `/api/diapers?baby=` per child.
- `+page.svelte`: `children = appState.babies`, `mode` from `isTwinMode`; identical
  output when `children.length <= 1`.
- `TimeSeriesChart` accepts `series[]` (total sleep, bedtime, night stretch, nap
  count + optional norm bands); twins overlay shared x/y; siblings two-up panels.
- `SleepTimelineChart` blocks carry child identity; twin = thin per-child lanes
  per date row (preferred — preserves alignment without hiding overlaps).
- `StatsChildHeader.svelte` / route-local labels for sibling two-up.

### 6. Tests
- Unit: expand beyond `stats-view-utils.unit.ts` presence checks — full-state
  renderers + pinned invariants (docs/testing.md:71-100). Pin: single-baby chart
  model matches old dims/ticks/path presence; today excluded; zero-data days
  not false drops; two children share x domain; overlay y includes both; gantt
  cross-midnight on both rows; twin gantt stable per-child lanes; sibling mode
  doesn't share age-norm bands unless configured.
- Playwright: replace weak "a chart/rect exists" (`stats.e2e.ts:29-55`) with
  visual snapshots — single, twin overlay, sibling two-up, fullscreen
  time-series, fullscreen gantt (external snapshots; Playwright has no inline).
  Keep Nynorsk-label + empty-state smoke (`:11-27, 87-112`); add 2-child fixtures
  that intentionally align/misalign so overlay is meaningful.

### 7. Verdict: agree with "refactor first, overlay second"
Hacking in `child2NightPath` etc. doubles down on the exact blocker (singular
chart models + route-owned SVG). Step 1 must separate semantic data / shared
scales / paths / reusable SVG / legend / fullscreen — then Step 2 is "provide two
series, choose overlay vs two-up," which is the architecture twins need now and N
later.

## Progress (2026-06-14, branch feat/p3-stats-charts → main)

- **DONE — determinism + golden safety net:** `computeAllStats` now takes an
  optional `now` (default Date.now(); prod unchanged), threaded into
  `buildGanttChart` + `getBestWorst`. A golden characterization snapshot
  (`tests/unit/stats-golden.unit.ts`, ~3.4k lines) pins the full single-baby
  chart geometry for a fixed fixture + pinned now. **This is the regression net
  for the whole refactor** — keep it byte-identical through Step 1; any change is
  a deliberate `--update-snapshots` with review.
- **DONE — primitives extracted:** `src/lib/charts/scales.ts` holds TS_CHART,
  tsX/tsPlotW/H, rollingAvg/rollingAvgPath, GANTT, getLocalHourFrac (pure move;
  golden green). The shared-scale home for overlay.
- **NEXT (task 8, Step 1 remainder):** `charts/paths.ts` (port the inline path
  builders), then the chart components (ChartFrame/ChartFullscreen/ChartLegend/
  TimeSeriesChart/SleepTimelineChart), then migrate `/stats` inline SVG to them
  one chart at a time — golden snapshot + stats e2e green throughout. Add d3
  modules HERE (they change float output deliberately → regen golden with review).
- **THEN (task 9, Step 2):** `stats/multi-child-stats.ts` + per-child fetch +
  route mode (single|twinOverlay|siblingTwoUp) + N-series overlay + gantt
  child-lanes + P3-2 overlap viz + P3-3 comparison stats + visual snapshots.

## Execution loop + unit queue (for the autonomous /loop)

Follow the generic loop spec in [`multi-child-support.md`](./multi-child-support.md)
"## Execution loop" EXACTLY (branch off main → test-first per docs/testing.md →
validate unit/integration/lint/typecheck + build/e2e for UI → **Codex oracle
review** for non-trivial units → update followups → commit why-focused →
`git checkout main` → `git merge --ff-only` → `git push` → **NO deploy**).

HARD INVARIANTS for every unit here:
- **Keep `tests/unit/stats-golden.unit.ts` byte-identical** through all of Step 1.
  A geometry change is only allowed when a unit deliberately changes output
  (e.g. adopting d3 in S1-5/S1-6) — then regenerate with `--update-snapshots`
  and eyeball the diff + note it in the commit. Never let it drift silently.
- **Single-baby /stats stays visually + behaviourally identical** until Step 2
  intentionally adds the multi-child modes (and even then N=1 is unchanged).
- Genuine product/UX choices → park in `local/loop-questions.md` (don't guess).
- Subagents: tell them to be thorough and to READ `docs/testing.md` first.

### Unit queue
Step 1 — behaviour-preserving refactor (single-baby unchanged):
- [x] S1-0  Determinism (`now` param) + golden characterization snapshot
- [x] S1-1  Extract pure primitives → `charts/scales.ts` (TS_CHART, tsX, rolling*, GANTT, getLocalHourFrac)
- [x] S1-2  `charts/paths.ts`: pure `polyline`/`areaUnder`/`band`/`stepPath` generators taking pre-formatted point strings; the 5 builders (sleepVsNorm, stackedArea, nightStretch, bedtime, napCount) now call them. Golden byte-identical (mechanical extraction; no Codex needed). rollingAvgPath already lived in scales.ts.
- [x] S1-3  `charts/types.ts`: generic chart model — ChartDims, AxisTick, ChartSeries (id+colorVar+style+path, N-series ready), ReferenceBand, TimeSeriesModel, LegendItem, TimelineBlock/Row/Model (block carries optional childId/colorVar for twin lanes). Additive types only, no consumer yet → golden trivially green; components (S1-6/S1-7) + data-shapers (S2-1) will consume them.
- [x] S1-4  `components/charts/ChartFrame.svelte` (slot wrapper, captures svg.outerHTML → onExpand) + `ChartFullscreen.svelte` (single overlay, {@html}, ✕/backdrop/Escape close). All 8 charts migrated; `expand()` sets one overlay state; `.stats-chart-wrap` + `.chart-fullscreen-*` styles moved into the components. Golden byte-identical, stats e2e green + NEW fullscreen open/close e2e. Codex: no must-fix (CSS-var fills resolve globally, scroll/rotate/close preserved).
- [x] S1-5  `components/charts/ChartLegend.svelte`: takes `LegendItem[]` (label + colorVar), renders the global `.stats-legend` markup. The 3 inline legends (Søvntrend, Total søvn, Døgnrytme) now use it. DOM-identical → golden unaffected, stats e2e (incl. legend assertions) green. Mechanical, no Codex.
- [x] S1-6  `components/charts/TimeSeriesChart.svelte`: generic N-series SVG frame (gridLines/yTicks/xLabels) + `TsSeries[]` (path + fill/stroke/width/dasharray/linecap/linejoin/opacity, line `fill` defaults 'none') + `TsBand[]` + underlay/overlay snippets. Migrated the 4 path-only charts (Søvntrend, Total søvn vs. tilrådd, Lengste nattestrekk, Lurar per dag). NO d3 — component binds the existing precomputed paths so output is VISUALLY identical by construction (golden data unchanged). Codex verified all 4 pixel-faithful vs HEAD~1. Leggetid + Vakevindu (custom avg-line / band-rect + circle dots) → S1-6b.
- [x] S1-6b  Migrated Leggetid (bedtime avg line+label via `underlay`, line as series) + Vakevindu (wakeScatter band-rect via `underlay`, circle dots via `overlay`, empty series/xLabels) to `TimeSeriesChart`. All 6 time-series charts now use it. Codex verified both visually/order faithful vs HEAD~1. Golden unchanged, stats e2e green.
- [ ] S1-7  `SleepTimelineChart.svelte`: gantt component (rows-by-date + blocks). Migrate the gantt; preserve cross-midnight duplication EXACTLY.
- [ ] S1-QA  Adversarial + visual review of Step 1 (single-baby unchanged); fix findings.

Step 2 — twin overlay + sibling two-up (P3-1 = B), then P3-2/P3-3:
- [ ] S2-1  `stats/multi-child-stats.ts` + per-child `/api/sleeps?baby=`/`/api/diapers?baby=` fetch + route `mode = single|twinOverlay|siblingTwoUp` from `appState.babies` + `family.isTwinMode`. N=1 output identical.
- [ ] S2-2  TimeSeriesChart N-series overlay for twins (shared x/y domain across children); sibling two-up panels (no shared age-norm band across ages).
- [ ] S2-3  SleepTimelineChart twin child-lanes per date row; two instances for siblings.
- [ ] S2-4 (P3-2)  Overlap visualisation: both-asleep windows = parent downtime.
- [ ] S2-5 (P3-3)  Comparison stats: total sleep, nap count, longest stretch, divergence.
- [ ] S2-QA (P3-QA)  Adversarial + QA + UX + visual review of twin/sibling views; fix findings.

When every unit is `[x]` or parked `[~]`: stop, push-notify a one-line summary.

## Execution notes
- This is a large multi-commit refactor; ship Step 1 (behavior-preserving) and
  Step 2 (overlay) as separate units, each: test-first, single-baby snapshot
  pinned unchanged, Codex review, commit → ff-merge main → push. NO deploy.
- d3 modules are new deps — small, functional, web-aligned (fits the repo's
  dependency stance). Confirm bundle impact is modest.
