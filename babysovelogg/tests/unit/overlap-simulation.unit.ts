import { describe, expect, it } from "bun:test";
import { assembleState, type DayData } from "$lib/engine/state.js";
import { computeOverlapSuggestion, type OverlapBabyInput } from "$lib/family-overlap.js";
import type { Baby, SleepLogRow, DayStartRow } from "$lib/types.js";

// Phase 4 / P4-QA. Two complementary things are pinned here:
//
//  1. PRODUCTION-PATH synced exclusion. A parent-accepted overlap nudge tags the
//     sleep `synced` (guardrail 5: parent policy, not the baby's natural rhythm).
//     tests/unit/synced-learning.unit.ts proves the schedule helpers skip a synced
//     SleepEntry — but it hand-builds SleepEntry literals, so it could NOT catch
//     `toSleepEntry` (state.ts) silently dropping the flag on the way from the DB
//     row into the engine. That exact bug shipped: the whole exclusion was dead in
//     prod. These tests drive the REAL path (SleepLogRow → assembleState) so the
//     flag has to survive the mapper.
//
//  2. The multi-day overlap loop is FAITHFUL: assemble → suggest → accept → append
//     the (tagged) sleep → advance. Accepting nudges must raise simultaneous-sleep
//     (parent downtime) without shrinking either baby's own sleep, and the accepted
//     synced days must NOT drift the movable twin's learned rhythm over the run.

const TODAY = "2026-05-15"; // CEST (UTC+2)
const TZ = "Europe/Oslo";
const WAKE = "07:00";
const AGE = 12;
const NIGHT_MIN = 690; // habitual 19:30 → 07:00

const pad = (n: number) => String(n).padStart(2, "0");
const ms = (iso: string) => new Date(iso).getTime();

function osloIso(date: string, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const utcH = h - 2;
  if (utcH >= 0) return `${date}T${pad(utcH)}:${pad(m)}:00.000Z`;
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.toISOString().slice(0, 10)}T${pad(24 + utcH)}:${pad(m)}:00.000Z`;
}
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function addMin(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const t = h * 60 + m + minutes;
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}
function osloHHMM(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

let nextId = 1;
function sleepRow(o: { babyId: number; startIso: string; endIso: string; type: "nap" | "night"; synced?: boolean }): SleepLogRow {
  return {
    id: nextId++, baby_id: o.babyId, start_time: o.startIso, end_time: o.endIso,
    type: o.type, notes: null, mood: null, method: null, fall_asleep_time: null, onset_note: null,
    woke_by: "self", wake_notes: null, wake_mood: null,
    deleted: 0, domain_id: `slp_${nextId}`, created_by_event_id: null, updated_by_event_id: null,
    ...(o.synced ? { synced: 1 } : {}),
  };
}
function nap(babyId: number, date: string, start: string, end: string, synced = false): SleepLogRow {
  return sleepRow({ babyId, startIso: osloIso(date, start), endIso: osloIso(date, end), type: "nap", synced });
}
function night(babyId: number, date: string, start = "19:30", end = "07:00"): SleepLogRow {
  return sleepRow({ babyId, startIso: osloIso(date, start), endIso: osloIso(addDays(date, 1), end), type: "night" });
}
function baby(id: number): Baby {
  return {
    id, name: id === 1 ? "Ada" : "Bo", birthdate: addDays(TODAY, -365), created_at: `${TODAY}T00:00:00.000Z`,
    custom_nap_count: 1, potty_mode: 0, track_diaper: 0, timezone: TZ, target_bedtime: null,
    created_by_event_id: null, updated_by_event_id: null,
  };
}
function wakeRow(babyId: number, date: string): DayStartRow {
  return { id: 1, baby_id: babyId, date, wake_time: osloIso(date, WAKE), created_at: osloIso(date, WAKE), created_by_event_id: null };
}

function assemble(babyId: number, history: SleepLogRow[], day: string) {
  const t0 = ms(`${day}T00:00:00.000Z`);
  const data: DayData = {
    baby: baby(babyId), activeSleep: undefined, todaySleeps: [],
    recentSleeps: history.filter((s) => ms(s.start_time) >= t0 - 7 * 24 * 3_600_000),
    strategySleeps: history.filter((s) => ms(s.start_time) >= t0 - 21 * 24 * 3_600_000),
    todayWakeUp: wakeRow(babyId, day), diaperCount: 0, lastDiaperTime: null,
    now: ms(osloIso(day, WAKE)),
  };
  return assembleState(data).prediction!;
}

const overlapMin = (aS: string, aE: string, bS: string, bE: string) =>
  Math.max(0, Math.min(ms(aE), ms(bE)) - Math.max(ms(aS), ms(bS))) / 60_000;

const hhmmToMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

// ─────────────────────────────────────────────────────────────────────────────

describe("synced nudges are excluded from learning through the production path", () => {
  // 7-day routine 1-nap history: 3 natural naps at 12:00, then 4 nap-accepted
  // nudges at 10:00. If the synced flag survives toSleepEntry, the learner ignores
  // the 4 nudge naps and still predicts ~12:00. If it's dropped, the prediction
  // is dragged toward 10:00 — which is exactly the bug that shipped.
  const history = (syncedNudges: boolean): SleepLogRow[] => {
    const out: SleepLogRow[] = [];
    for (let i = 0; i < 7; i++) {
      const day = addDays(TODAY, -7 + i);
      const isNudge = i >= 3;
      out.push(isNudge ? nap(2, day, "10:00", "11:50", syncedNudges) : nap(2, day, "12:00", "13:50"));
      out.push(night(2, day));
    }
    return out;
  };

  it("a routine baby's learned nap holds at its natural time when the nudges are tagged synced", () => {
    const tagged = osloHHMM(assemble(2, history(true), TODAY).predictedNaps![0].startTime);
    const untagged = osloHHMM(assemble(2, history(false), TODAY).predictedNaps![0].startTime);

    expect({ tagged, untagged }).toMatchInlineSnapshot(`
      {
        "tagged": "12:00",
        "untagged": "10:40",
      }
    `);

    expect(hhmmToMin(tagged), "synced naps must be ignored → prediction stays at the natural 12:00").toBeGreaterThanOrEqual(11 * 60 + 45);
    expect(hhmmToMin(untagged), "untagged nudge naps DO contaminate (proves the tag is load-bearing)").toBeLessThanOrEqual(11 * 60);
    expect(hhmmToMin(tagged) - hhmmToMin(untagged), "the tag must change the learned nap materially").toBeGreaterThanOrEqual(45);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

// Twin fixture: Ada naps tight at 11:00; Bo naps later (~12:10) with realistic
// day-to-day variance, so a ≥30-min overlap nudge for Bo's nap is both available
// and inside Bo's ±1σ window (SD stays ~30-39 → "medium" confidence, not blocked).
const JITTER = [-48, -24, 0, 24, 48, -36, 36, -12, 12];
const FIXED_NAP = "11:00";
const MOVABLE_NAP = "12:10";

function seed(babyId: number, movable: boolean): SleepLogRow[] {
  const out: SleepLogRow[] = [];
  for (let d = 21; d >= 1; d--) {
    const day = addDays(TODAY, -d);
    if (movable) {
      const j = JITTER[d % JITTER.length];
      out.push(nap(babyId, day, addMin(MOVABLE_NAP, j), addMin(MOVABLE_NAP, j + 110)));
    } else {
      out.push(nap(babyId, day, FIXED_NAP, addMin(FIXED_NAP, 110)));
    }
    out.push(night(babyId, day));
  }
  return out;
}

interface SimDay {
  dayN: number;
  /** Bo's natural (un-nudged) predicted nap start. */
  movableNatural: string;
  suggested: number | null; // signed nudge minutes, null = no suggestion
  accepted: boolean;
  baseOverlap: number; // both babies on their own plans
  realOverlap: number; // after accepting (or natural, if not accepted)
  adaNapMin: number;
  boNapMin: number;
}

/** Run the faithful feedback loop. `tagSynced` controls whether accepted naps are
 *  logged synced (clean) or as ordinary naps (contaminated counterfactual). */
function runSim(tagSynced: boolean): { days: SimDay[]; finalMovableNatural: string; cumBase: number; cumReal: number } {
  const fixedH = seed(1, false);
  const movableH = seed(2, true);
  const days: SimDay[] = [];
  let cumBase = 0;
  let cumReal = 0;
  let finalMovableNatural = "";

  for (let dayN = 0; dayN < 10; dayN++) {
    const day = addDays(TODAY, dayN);
    const now = ms(osloIso(day, WAKE));
    const pf = assemble(1, fixedH, day);
    const pm = assemble(2, movableH, day);
    const fNap = pf.predictedNaps![0];
    const mNap = pm.predictedNaps![0];
    finalMovableNatural = osloHHMM(mNap.startTime);

    const baseOverlap = overlapMin(fNap.startTime, fNap.endTime, mNap.startTime, mNap.endTime);
    const input = (id: number, p: typeof pf): OverlapBabyInput => ({
      baby: baby(id), prediction: p, activeSleep: null, staleActiveSleep: null, offDays: [], ageMonths: AGE,
    });
    const sug = computeOverlapSuggestion([input(1, pf), input(2, pm)], now);

    // A realistic parent accepts on alternating days only — keeping natural nap
    // evidence flowing on the off days, as a 100%-acceptance parent never would.
    const accept = dayN % 2 === 0 && !!(sug && sug.babyId === 2);
    const mDurMs = ms(mNap.endTime) - ms(mNap.startTime);
    // Bo's intrinsic variance on a natural day (doesn't nap at the exact minute).
    const natural = new Date(ms(mNap.startTime) + JITTER[dayN % JITTER.length] * 60_000).toISOString();
    const realStart = accept ? sug!.to : natural;
    const realEnd = new Date(ms(realStart) + mDurMs).toISOString();
    const realOverlap = overlapMin(fNap.startTime, fNap.endTime, realStart, realEnd);
    cumBase += baseOverlap;
    cumReal += realOverlap;

    days.push({
      dayN, movableNatural: osloHHMM(mNap.startTime), suggested: sug && sug.babyId === 2 ? sug.deltaMin : null,
      accepted: accept, baseOverlap: Math.round(baseOverlap), realOverlap: Math.round(realOverlap),
      adaNapMin: Math.round((ms(fNap.endTime) - ms(fNap.startTime)) / 60_000), boNapMin: Math.round(mDurMs / 60_000),
    });

    fixedH.push(nap(1, day, osloHHMM(fNap.startTime), osloHHMM(fNap.endTime)));
    fixedH.push(sleepRow({ babyId: 1, startIso: pf.bedtime!, endIso: new Date(ms(pf.bedtime!) + NIGHT_MIN * 60_000).toISOString(), type: "night" }));
    movableH.push(sleepRow({ babyId: 2, startIso: realStart, endIso: realEnd, type: "nap", synced: accept && tagSynced }));
    movableH.push(sleepRow({ babyId: 2, startIso: pm.bedtime!, endIso: new Date(ms(pm.bedtime!) + NIGHT_MIN * 60_000).toISOString(), type: "night" }));
  }
  return { days, finalMovableNatural, cumBase, cumReal };
}

const renderSim = (days: SimDay[]) =>
  days.map((d) =>
    `day ${d.dayN}: Bo-nat=${d.movableNatural} ` +
    `sug=${d.suggested == null ? "—" : `${d.suggested}m`} accept=${d.accepted ? "Y" : "·"} ` +
    `overlap base=${d.baseOverlap} real=${d.realOverlap} | nap Ada=${d.adaNapMin}m Bo=${d.boNapMin}m`,
  ).join("\n");

describe("multi-day twin overlap simulation (assemble → suggest → accept → append → advance)", () => {
  it("accepting nudges raises parent-overlap on accept days without shrinking either baby's sleep", () => {
    const { days, cumBase, cumReal } = runSim(true);

    expect(renderSim(days)).toMatchInlineSnapshot(`
      "day 0: Bo-nat=12:05 sug=-34m accept=Y overlap base=44 real=78 | nap Ada=110m Bo=110m
      day 1: Bo-nat=12:05 sug=-35m accept=· overlap base=44 real=68 | nap Ada=110m Bo=110m
      day 2: Bo-nat=11:51 sug=-33m accept=Y overlap base=58 real=91 | nap Ada=110m Bo=110m
      day 3: Bo-nat=11:54 sug=— accept=· overlap base=55 real=31 | nap Ada=110m Bo=110m
      day 4: Bo-nat=12:04 sug=— accept=· overlap base=45 real=0 | nap Ada=110m Bo=110m
      day 5: Bo-nat=12:08 sug=-36m accept=· overlap base=42 real=78 | nap Ada=110m Bo=110m
      day 6: Bo-nat=11:54 sug=-38m accept=Y overlap base=55 real=93 | nap Ada=110m Bo=110m
      day 7: Bo-nat=12:04 sug=— accept=· overlap base=46 real=58 | nap Ada=110m Bo=110m
      day 8: Bo-nat=11:56 sug=— accept=· overlap base=54 real=42 | nap Ada=110m Bo=110m
      day 9: Bo-nat=12:03 sug=-38m accept=· overlap base=46 real=94 | nap Ada=110m Bo=110m"
    `);

    const acceptDays = days.filter((d) => d.accepted);
    expect(acceptDays.length, "the suggestion must actually fire and be accepted on multiple days").toBeGreaterThanOrEqual(3);

    // Overlap UP: every accepted nudge delivers ≥30 min more simultaneous sleep
    // than not nudging (the suggestOverlap gain threshold, end-to-end through the
    // real overlap recomputation), and the run accumulates strictly more downtime.
    for (const d of acceptDays) {
      expect(d.realOverlap - d.baseOverlap, `day ${d.dayN}: accepted nudge must add ≥30 min overlap`).toBeGreaterThanOrEqual(30);
    }
    expect(cumReal, "accepting nudges yields more total parent-downtime over the run").toBeGreaterThan(cumBase);

    // No degradation: a start-time nudge never shortens a nap — both babies keep
    // their full predicted nap duration on every day.
    for (const d of days) {
      expect(d.adaNapMin, `day ${d.dayN}: Ada's nap not shortened`).toBe(110);
      expect(d.boNapMin, `day ${d.dayN}: Bo's nap not shortened`).toBe(110);
    }
  });

  it("the accepted (synced) nudges do NOT drift the movable twin's natural rhythm over the run", () => {
    // Same loop, same intrinsic variance, differing ONLY in whether accepted naps
    // are tagged synced. Tagged → the learner ignores them and Bo's natural nap
    // stays late; untagged → the nudges teach the learner and pull it earlier.
    const clean = runSim(true);
    const dirty = runSim(false);

    expect({ clean: clean.finalMovableNatural, dirty: dirty.finalMovableNatural }).toMatchInlineSnapshot(`
      {
        "clean": "12:03",
        "dirty": "11:26",
      }
    `);
    expect(
      hhmmToMin(clean.finalMovableNatural) - hhmmToMin(dirty.finalMovableNatural),
      "tagging accepted naps synced keeps the natural rhythm later than letting them contaminate the learner",
    ).toBeGreaterThan(0);
  });
});
