/**
 * Age-appropriate guidance text for newborn/emerging phases.
 * Factual, not prescriptive. All text in Nynorsk.
 */

export interface GuidanceText {
  /** Phase description — what's happening developmentally */
  phaseDescription: string;
  /** What's normal for this age */
  normalText: string;
  /** What to look for (positive development signals) */
  lookFor: string;
}

/** Get age-appropriate guidance text. */
export function getGuidanceText(ageWeeks: number): GuidanceText {
  if (ageWeeks < 6) {
    return {
      phaseDescription: "I denne fasen er søvnen ofte ujamn gjennom døgnet. Det er heilt normalt.",
      normalText: "Nyfødte søv 14–18 timar i døgnet, fordelt på mange korte økter. " +
        "Vakevinduet er kort — ofte berre 30–60 minutt.",
      lookFor: "Det lengste søvnstrekkjet veks gradvis. " +
        "Det er det fyrste teiknet på at døgnrytmen utviklar seg.",
    };
  }
  if (ageWeeks < 12) {
    return {
      phaseDescription: "Døgnrytmen byrjar å ta form. Nattesøvnen vert gradvis lengre.",
      normalText: "Babyen søv gjerne 14–17 timar i døgnet. " +
        "Det lengste strekkjet er vanlegvis om natta og veks mot 5–6 timar.",
      lookFor: "Ei meir tydeleg kveldssøvn og eit lengre nattstrekkje. " +
        "Fyrste lur på dagtid vert ofte den mest faste.",
    };
  }
  if (ageWeeks < 20) {
    return {
      phaseDescription: "Døgnrytmen er etablert. Søvnmønsteret vert meir føreseieleg.",
      normalText: "Babyen søv gjerne 13–16 timar i døgnet med 3–4 lurar. " +
        "Nattesøvnen er vanlegvis 6+ timar samanhengande.",
      lookFor: "Meir faste lurtider, særleg om morgonen. " +
        "Lurane vert kortare og færre framover.",
    };
  }
  return {
    phaseDescription: "Babyen har ein etablert døgnrytme med faste lurar og leggetid.",
    normalText: "Babyen søv gjerne 12–15 timar i døgnet med 2–3 lurar.",
    lookFor: "Stabile lurtider og leggetid gjev gode prediksjonar.",
  };
}

/**
 * Build a "is this normal?" assessment from current data vs norms.
 * Returns a short Nynorsk string.
 */
export function assessNormality(
  totalSleep24hMin: number,
  longestStretchMin: number,
  ageWeeks: number,
): string {
  const sleepHours = totalSleep24hMin / 60;

  // Age-based expected ranges
  let expectedSleepRange: [number, number];
  let expectedLongestRange: [number, number]; // minutes
  if (ageWeeks < 6) {
    expectedSleepRange = [14, 18];
    expectedLongestRange = [90, 240];
  } else if (ageWeeks < 12) {
    expectedSleepRange = [13, 17];
    expectedLongestRange = [180, 360];
  } else if (ageWeeks < 20) {
    expectedSleepRange = [13, 16];
    expectedLongestRange = [300, 480];
  } else {
    expectedSleepRange = [12, 15];
    expectedLongestRange = [360, 600];
  }

  const sleepInRange = sleepHours >= expectedSleepRange[0] && sleepHours <= expectedSleepRange[1];
  const stretchInRange = longestStretchMin >= expectedLongestRange[0] && longestStretchMin <= expectedLongestRange[1];

  if (sleepInRange && stretchInRange) {
    return "Søvnen er heilt typisk for denne alderen.";
  }
  if (sleepInRange && longestStretchMin > expectedLongestRange[1]) {
    return "Totalsøvnen er typisk. Det lengste strekkjet er over gjennomsnittet — flott!";
  }
  if (sleepInRange && longestStretchMin < expectedLongestRange[0]) {
    return "Totalsøvnen er typisk. Det lengste strekkjet er litt kortare enn vanleg, men variasjon er normalt.";
  }
  if (sleepHours < expectedSleepRange[0]) {
    return "Totalsøvnen er litt under gjennomsnittet. Stor variasjon er vanleg i denne alderen.";
  }
  if (sleepHours > expectedSleepRange[1]) {
    return "Totalsøvnen er over gjennomsnittet. Det er vanleg og heilt greitt.";
  }
  return "Søvnen varierer mykje i denne alderen. Det er heilt normalt.";
}
