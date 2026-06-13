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
