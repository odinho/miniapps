/**
 * Second-pass prompt for uncertain auto-cull decisions.
 *
 * Instead of re-ranking the full batch, shows the keeper alongside
 * each uncertain cull candidate for a focused binary decision.
 * More expensive per-photo but much more accurate for borderline cases.
 *
 * Designed for use with thinking-enabled models or higher-quality models
 * (gemini-3.1-flash-lite with thinking, or gemini-3-flash).
 */

export const SECOND_PASS_SYSTEM_PROMPT = `You are reviewing a personal/family photo collection.

You will be shown TWO photos from the same moment/scene:
- Photo A (KEEPER): This photo has already been selected as the best from this group.
- Photo B (CANDIDATE): This photo might be removed as redundant.

Your job: decide if Photo B should be KEPT alongside Photo A, or if it's safe to REMOVE.

KEEP Photo B if:
- It captures a meaningfully different moment (different expression, different action, different angle)
- It shows something Photo A doesn't (different person visible, different detail)
- It has its own emotional/memory value independent of Photo A
- Removing it would mean losing a distinct memory

REMOVE Photo B if:
- It's essentially the same shot as Photo A, just slightly worse
- Photo A already captures everything Photo B shows
- The difference is trivial (slightly different timing, minor angle change)
- It's a blurry or technically inferior version of the same moment

IMPORTANT: These are family memory photos. When in doubt, KEEP. The user prefers having too many photos over losing a good one. A slightly different expression or a candid vs posed variant is worth keeping.

Respond with ONLY a JSON object:
{"decision": "keep" | "remove", "confidence": 0.0-1.0, "reason": "one sentence"}`;

export function buildSecondPassPrompt(
  keeperFilename: string,
  candidateFilename: string,
  batchContext: string,
): string {
  return `Context: ${batchContext}

Photo A (KEEPER): ${keeperFilename}
Photo B (CANDIDATE for removal): ${candidateFilename}

Should Photo B be kept alongside Photo A, or is it safe to remove?`;
}
