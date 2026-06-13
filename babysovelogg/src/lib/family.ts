// Twin-vs-sibling mode (max 2 children per family). Twin-optimised
// affordances — "Sove/Vakne begge", schedule sync, overlaid stats — only make
// sense for two same-age babies. Mixed-age siblings get the plainer app.

/** Birthdates closer than this read as twins when the family hasn't overridden. */
const TWIN_AGE_GAP_DAYS = 21;

/** `null` = auto (infer from age gap); otherwise the family forced the mode. */
export type FamilyModeOverride = "twin" | "sibling" | null;

/**
 * Whether twin-optimised affordances should be shown. Inferred from birthdate
 * proximity for two children, unless the family explicitly set a mode. Fewer
 * than two children is never twin-mode.
 */
export function isTwinMode(birthdates: string[], override: FamilyModeOverride): boolean {
  if (birthdates.length < 2) return false;
  if (override === "twin") return true;
  if (override === "sibling") return false;
  const ms = birthdates.map((b) => new Date(b).getTime()).filter((n) => Number.isFinite(n));
  if (ms.length < 2) return false;
  const gapDays = (Math.max(...ms) - Math.min(...ms)) / 86_400_000;
  return gapDays <= TWIN_AGE_GAP_DAYS;
}

// --- Family at-a-glance status (powers the combined status line) ----------

/** The minimum a baby slice must expose for the family status reduction.
 *  Structural so this module stays free of an app-store/engine import cycle;
 *  `BabyState` satisfies it. */
export interface FamilySleepView {
  baby: { id: number; name: string } | null;
  // Optional/nullable so a `BabyState` slice (whose activeSleep is
  // `SleepLogRow | undefined`) structurally satisfies this without a cast.
  activeSleep?: { type: string; end_time: string | null } | null;
  /** A forgotten (>24h) open sleep the server has hidden from activeSleep. */
  staleActiveSleep?: unknown | null;
  prediction?: {
    expectedNapEnd: string | null;
    expectedNightEnd: string | null;
    napBudget?: { wakeBy: string } | null;
    rescueNap?: { recommendedWakeTime: string } | null;
  } | null;
}

export interface FirstWake {
  babyId: number;
  name: string;
  /** Expected wake instant (ISO). */
  at: string;
}

const isAsleep = (b: FamilySleepView): boolean => !!(b.activeSleep && !b.activeSleep.end_time);

/**
 * When an asleep baby is expected to wake. A nap honours an active cap/rescue
 * before its natural end — same precedence as the single-baby Timer's nap
 * branch (`getTimerMode`). A night uses the predicted night-end: unlike the
 * Timer's `sleeping` branch (which returns null for night and defers to its
 * `deep-night` display), the family roll-up DOES want a night-sleeping baby to
 * contribute a wake time, so "første venta vakning" is the morning. Null when
 * not asleep, no prediction, or an unrecognised sleep type.
 * (Unifying the nap precedence into one shared helper: followup X-8.)
 */
export function expectedWakeFor(b: FamilySleepView): string | null {
  if (!isAsleep(b)) return null;
  const p = b.prediction;
  if (!p) return null;
  if (b.activeSleep!.type === "nap") {
    return p.napBudget?.wakeBy ?? p.rescueNap?.recommendedWakeTime ?? p.expectedNapEnd ?? null;
  }
  if (b.activeSleep!.type === "night") return p.expectedNightEnd ?? null;
  return null;
}

/**
 * Household sleep status: are both children asleep, and who is expected to
 * wake first. `bothAsleep` needs two children (max per family) both down.
 * `firstWake` is the soonest expected wake among the asleep children.
 */
export function computeFamilyStatus(babies: FamilySleepView[]): {
  bothAsleep: boolean;
  firstWake: FirstWake | null;
} {
  const present = babies.filter((b) => b.baby);
  const bothAsleep = present.length >= 2 && present.every(isAsleep);

  let firstWake: FirstWake | null = null;
  for (const b of present) {
    const at = expectedWakeFor(b);
    if (!at) continue;
    if (!firstWake || new Date(at).getTime() < new Date(firstWake.at).getTime()) {
      firstWake = { babyId: b.baby!.id, name: b.baby!.name, at };
    }
  }
  return { bothAsleep, firstWake };
}

/** Structured combined family status — the component renders the copy + formats
 *  the countdown, so this stays formatting/i18n-free and unit-testable. Null
 *  for fewer than two children (the combined line is a two-up affordance). */
export type CombinedStatus =
  | { kind: "both-asleep"; firstWake: { name: string; inMs: number } | null }
  | { kind: "both-awake" }
  | { kind: "mixed"; asleepName: string; awakeName: string };

export function getCombinedStatus(
  babies: FamilySleepView[],
  firstWake: FirstWake | null,
  now: number,
): CombinedStatus | null {
  const present = babies.filter((b) => b.baby);
  // The combined line is a strictly two-up affordance (family cap is 2).
  if (present.length !== 2) return null;
  // A forgotten/stale sleep is the priority signal and the server hides it from
  // activeSleep — so we'd otherwise call that child "vaken" while its lane says
  // "Sjekk vaknetid". Suppress the headline and let the stale lane carry it.
  if (present.some((b) => b.staleActiveSleep)) return null;
  const asleep = present.filter(isAsleep);

  if (asleep.length === present.length) {
    return {
      kind: "both-asleep",
      firstWake: firstWake ? { name: firstWake.name, inMs: new Date(firstWake.at).getTime() - now } : null,
    };
  }
  if (asleep.length === 0) return { kind: "both-awake" };

  const awakeBaby = present.find((b) => !isAsleep(b))!;
  return { kind: "mixed", asleepName: asleep[0].baby!.name, awakeName: awakeBaby.baby!.name };
}
