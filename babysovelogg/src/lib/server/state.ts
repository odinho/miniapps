import { db, getFamilyTimezone, getFamilyModeOverride } from "./db.js";
import { isTwinMode, computeFamilyStatus } from "$lib/family.js";
import { assembleState } from "$lib/engine/state.js";
import { getPrefs } from "./notification-prefs.js";
import { getNapBudgetState, setNapBudgetState } from "./nap-budget-state.js";
import { getTrendTargetState, setTrendTargetState } from "./trend-target-state.js";
import type {
  Baby,
  SleepLogRow,
  DayStartRow,
  NightWakingRow,
} from "$lib/types.js";
import { todayInTz } from "$lib/tz.js";
import { classifyActiveSleep, type StaleStatus } from "$lib/stale-sleep.js";
import { collectOvernightFragments } from "$lib/overnight.js";

/** Empty single-baby slice, returned by getFamilyState when no baby exists
 *  (brand-new install / onboarding). Matches the legacy getState() null-baby
 *  shape byte-for-byte so the single-baby UI is unaffected at N=0. */
const EMPTY_BABY_STATE = {
  baby: null,
  activeSleep: null,
  staleActiveSleep: null,
  todaySleeps: [],
  todayNightWakings: [] as NightWakingRow[],
  stats: null,
  dayTotals: null,
  priorOvernightSleep: null,
  prediction: null,
};

/** Assemble the full app-state slice for a single baby. This is the per-baby
 *  half of the family snapshot — the engine stays pure (one BabyContext) and
 *  getFamilyState calls this once per child. Returns null when the baby id
 *  doesn't exist. */
export function getBabyState(babyId: number, now?: number) {
  const baby = db.prepare("SELECT * FROM baby WHERE id = ?").get(babyId) as Baby | undefined;
  if (!baby) return null;

  const openSleep = db
    .prepare(
      "SELECT * FROM sleep_log WHERE baby_id = ? AND end_time IS NULL AND deleted = 0 ORDER BY id DESC LIMIT 1",
    )
    .get(baby.id) as SleepLogRow | undefined;

  // An open sleep that's run over a day is almost certainly a forgotten wake,
  // not a live session (the 466:34:51 report). Treat it as invalid: hide it
  // from the engine (no `activeSleep`, so predictions/onboarding behave as if
  // between sleeps) and surface it separately so the UI can prompt the parent
  // to set the real wake time, discard it, or — at 48h — re-run onboarding.
  const nowForStale = now ?? Date.now();
  const staleStatus: StaleStatus | null = classifyActiveSleep(openSleep, nowForStale);
  const activeSleep = staleStatus ? undefined : openSleep;
  const staleActiveSleep = staleStatus && openSleep
    ? { ...openSleep, staleStatus }
    : null;

  // Timezone is family-level (one household zone — see the `family` table).
  // Overlay it onto the baby object so every downstream reader (engine,
  // client UI, notifications) keeps reading the familiar `baby.timezone`
  // field while the single source of truth lives on the family row.
  const tz = getFamilyTimezone();
  baby.timezone = tz;
  // Compute the date boundary against the same `now` the engine uses so
  // integration tests passing `?now=...` get a deterministic result, and
  // production calls without `now` fall back to the real wall clock.
  const { dateStr: todayDateStr, midnightIso } = todayInTz(tz, now);

  const todaySleeps = db
    .prepare(
      "SELECT * FROM sleep_log WHERE baby_id = ? AND start_time >= ? AND deleted = 0 ORDER BY start_time DESC",
    )
    .all(baby.id, midnightIso) as SleepLogRow[];

  // Derive wakeup: night sleep end_time takes precedence, day_start is the
  // onboarding fallback. The day_start row also carries the off-day flag,
  // so we read it unconditionally and merge it onto whichever wake_time
  // signal won out.
  const dayStartRow = db
    .prepare("SELECT * FROM day_start WHERE baby_id = ? AND date = ?")
    .get(baby.id, todayDateStr) as DayStartRow | undefined;
  // A day_start row created by day.marked_off (with no preceding
  // day.started) carries a placeholder wake_time = `${date}T00:00:00.000Z`.
  // Downstream wake-derivation must ignore that — using midnight as a real
  // wake time would suppress the morning prompt and feed garbage into the
  // schedule planner. Detect by exact placeholder match; an honest
  // day.started wake at exact midnight is vanishingly rare and would
  // re-anchor on the next reconcile from the night entry anyway.
  const placeholderWake = `${todayDateStr}T00:00:00.000Z`;
  const dayStartHasRealWake = !!dayStartRow && dayStartRow.wake_time !== placeholderWake;
  // Fetch the full overnight row (not just end_time): UI surfaces want the
  // duration for the "Søvn i dag" total, and engine assembly attaches its
  // pauses for an accurate pause-adjusted figure.
  const priorOvernightRow = db
    .prepare(
      "SELECT * FROM sleep_log WHERE baby_id = ? AND type = 'night' AND start_time < ? AND end_time >= ? AND deleted = 0 ORDER BY end_time DESC LIMIT 1",
    )
    .get(baby.id, midnightIso, midnightIso) as SleepLogRow | undefined;
  // The overnight can be logged as several `night` sleeps split by wake-ups
  // instead of one sleep + night_wakings. The morning wake is the end of the
  // LAST fragment of that block — not `priorOvernightRow` (the fragment that
  // straddles midnight), which only the first piece does. `priorOvernightRow`
  // stays load-bearing below for the pre-midnight duration the "Søvn i dag"
  // total would otherwise drop.
  const morningWakeTime = collectOvernightFragments(priorOvernightRow, todaySleeps).at(-1)?.end_time
    ?? null;
  let todayWakeUp: DayStartRow | undefined;
  if (morningWakeTime) {
    todayWakeUp = {
      id: dayStartRow?.id ?? 0,
      baby_id: baby.id,
      date: todayDateStr,
      wake_time: morningWakeTime,
      created_at: morningWakeTime,
      created_by_event_id: null,
      off_day: dayStartRow?.off_day ?? 0,
      off_day_reason: dayStartRow?.off_day_reason ?? null,
    };
  } else if (dayStartHasRealWake) {
    todayWakeUp = dayStartRow;
  } else if (dayStartRow) {
    // Marker-only row: keep the off-day flag visible to the UI but expose
    // no wake_time so the morning prompt and engine fallbacks behave as if
    // the day had not started yet.
    todayWakeUp = {
      ...dayStartRow,
      wake_time: null,
    };
  } else {
    todayWakeUp = undefined;
  }

  // Honour the explicit `now` so tests and backtests pin both the fetch
  // window AND the engine clock to the same instant. Falling back to
  // Date.now() lets the prediction time slip past the data window in a
  // way that's hard to reason about.
  const nowMs = now ?? Date.now();
  const weekAgo = new Date(nowMs - 7 * 86400000).toISOString();
  const recentSleeps = db
    .prepare(
      "SELECT * FROM sleep_log WHERE baby_id = ? AND start_time >= ? AND deleted = 0 ORDER BY start_time DESC",
    )
    .all(baby.id, weekAgo) as SleepLogRow[];

  // 30-day lookback covers both the 21-day strategy hysteresis (which only
  // looks at the most recent 6-day replay window) and the napBudget trend
  // computation (which uses 7d/30d daily averages from getWeekStats).
  const thirtyDaysAgo = new Date(nowMs - 30 * 86400000).toISOString();
  const strategySleeps = db
    .prepare(
      "SELECT * FROM sleep_log WHERE baby_id = ? AND start_time >= ? AND deleted = 0 ORDER BY start_time DESC",
    )
    .all(baby.id, thirtyDaysAgo) as SleepLogRow[];
  const trendSleeps = strategySleeps;

  // Very-long-horizon window for the sleep-cycle estimator. The strict
  // self-wake filter needs many samples to beat the age-default prior,
  // and the 30-day trend window is too small for 1-nap babies who
  // self-wake rarely (Halldis has 35 self-wakes in 5 months of data).
  // 180 days is the spec ceiling from the cycle-estimator-v2 followup.
  const oneEightyDaysAgo = new Date(nowMs - 180 * 86400000).toISOString();
  const cycleSleeps = db
    .prepare(
      "SELECT * FROM sleep_log WHERE baby_id = ? AND start_time >= ? AND deleted = 0 ORDER BY start_time DESC",
    )
    .all(baby.id, oneEightyDaysAgo) as SleepLogRow[];

  // Night wakings — fetched in a window wide enough to cover (a) the
  // active night sleep that started yesterday and (b) all of today's
  // sleeps. 30h before midnight is the safe ceiling for a typical
  // night plus a long morning. UI does overlap math against the parent
  // sleep on its own.
  const wakingsWindowIso = new Date(
    new Date(midnightIso).getTime() - 30 * 60 * 60 * 1000,
  ).toISOString();
  const todayNightWakings = db
    .prepare(
      "SELECT * FROM night_waking WHERE baby_id = ? AND start_time >= ? AND deleted = 0 ORDER BY start_time ASC",
    )
    .all(baby.id, wakingsWindowIso) as NightWakingRow[];

  const todayDiapers = db
    .prepare(
      "SELECT COUNT(*) as count FROM diaper_log WHERE baby_id = ? AND time >= ? AND deleted = 0",
    )
    .get(baby.id, midnightIso) as { count: number } | undefined;

  const lastDiaper = db
    .prepare(
      "SELECT time FROM diaper_log WHERE baby_id = ? AND deleted = 0 ORDER BY time DESC LIMIT 1",
    )
    .get(baby.id) as { time: string } | undefined;

  // napBudget reads its opt-in from the same pref the push uses, so the
  // in-app banner respects the toggle parents already see in settings. A
  // dedicated per-baby column (decoupled from notifications) was considered
  // and rejected — see docs/napbudget-codex-review-2026-05-13.md.
  const napBudgetOptedIn = getPrefs(baby.id).nap_budget_cap;
  const priorNapBudgetState = getNapBudgetState(baby.id);
  const priorTrendTargetState = getTrendTargetState(baby.id);

  // Off-days from day_start. Pulled wider than the trend window so the
  // engine can also skip them in any future per-day analysis.
  const offDayRows = db
    .prepare("SELECT date FROM day_start WHERE baby_id = ? AND off_day = 1")
    .all(baby.id) as Array<{ date: string }>;
  const offDays = new Set(offDayRows.map((r) => r.date));

  const result = assembleState({
    baby,
    activeSleep,
    todaySleeps,
    recentSleeps,
    strategySleeps,
    trendSleeps,
    cycleSleeps,
    todayWakeUp,
    priorOvernightSleep: priorOvernightRow,
    todayNightWakings,
    diaperCount: todayDiapers?.count ?? 0,
    lastDiaperTime: lastDiaper?.time ?? null,
    napBudgetOptedIn,
    priorNapBudgetState,
    priorTrendTargetState,
    offDays,
    now,
  });

  // Persist mode transitions. Only writes when the engine actually emitted
  // a napBudget (no point recording state when nothing was computed) and
  // only when the mode changed — keeps the entered_at stable across
  // reconciles in steady state, so it remains a useful "how long has the
  // family been in established mode" signal.
  const emittedMode = result.prediction?.napBudget?.mode;
  if (emittedMode && emittedMode !== priorNapBudgetState?.mode) {
    setNapBudgetState(baby.id, {
      mode: emittedMode,
      enteredAt: new Date(nowMs).toISOString(),
    });
  }

  // Persist the held intervention target after the engine has run.
  // Only writes when the engine actually emitted trendTargets (gated on
  // having enough data) and only when one of the held-state fields
  // actually changed — keeps the updatedAt timestamp stable in steady
  // state so it remains a useful "last meaningful change" signal.
  const nextTrend = result.prediction?.trendTargets?.state ?? null;
  if (nextTrend && !sameTrendTargetState(priorTrendTargetState, nextTrend)) {
    setTrendTargetState(baby.id, nextTrend);
  }

  // Surface the over-a-day open sleep (hidden from the engine above) so the
  // dashboard can render the resolve banner and force re-onboarding at 48h.
  return { ...result, staleActiveSleep };
}

export type BabyState = NonNullable<ReturnType<typeof getBabyState>>;

/** Assemble one coherent family snapshot: every baby's slice plus legacy
 *  top-level aliases for the single-baby UI. SSE and offline sync consume
 *  this single object per event rather than calling getBabyState twice.
 *
 *  The top-level alias mirrors the *newest* baby — matching the historical
 *  `ORDER BY id DESC LIMIT 1` selection — so a single-baby family sees a
 *  byte-for-byte identical payload (just with an extra `babies` array that
 *  the legacy client ignores). `babies` is ordered by creation (id ASC) so
 *  the home lanes have a stable order. `now` is family-wide: both babies
 *  share the clock for deterministic tests/screenshots. */
export function getFamilyState(now?: number) {
  const ids = db.prepare("SELECT id FROM baby ORDER BY id ASC").all() as { id: number }[];
  const babies = ids
    .map((r) => getBabyState(r.id, now))
    .filter((b): b is BabyState => b !== null);
  const primary = babies.length ? babies[babies.length - 1] : EMPTY_BABY_STATE;
  const modeOverride = getFamilyModeOverride();
  const family = {
    isTwinMode: isTwinMode(
      babies.map((b) => b.baby?.birthdate).filter((d): d is string => !!d),
      modeOverride,
    ),
    modeOverride,
    ...computeFamilyStatus(babies),
  };
  return { ...primary, babies, family };
}

/** Legacy single-baby entry point. Now an alias for the family snapshot so
 *  every existing caller (SSE broadcast, /api/state) carries `babies`. */
export function getState(now?: number) {
  return getFamilyState(now);
}

function sameTrendTargetState(
  a:
    | {
        targetMin: number;
        baselineMin: number;
        source: string;
        confidence: string;
        naturalSupportStreak: number;
        evidenceFingerprint?: string;
      }
    | null,
  b: {
    targetMin: number;
    baselineMin: number;
    source: string;
    confidence: string;
    naturalSupportStreak: number;
    evidenceFingerprint?: string;
  },
): boolean {
  if (!a) return false;
  return (
    a.targetMin === b.targetMin &&
    a.baselineMin === b.baselineMin &&
    a.source === b.source &&
    a.confidence === b.confidence &&
    a.naturalSupportStreak === b.naturalSupportStreak &&
    (a.evidenceFingerprint ?? null) === (b.evidenceFingerprint ?? null)
  );
}
