/** Build the LLM prompt for a day-batch review */

import { SessionBatch } from "../batching/session-batcher.js";

export function buildPrompt(batch: SessionBatch): string {
  const dateRange = `${batch.dateRange.start.toISOString().slice(0, 16)} to ${batch.dateRange.end.toISOString().slice(0, 16)}`;
  const n = batch.assets.length;

  const imagesMeta = batch.assets.map((a, i) => ({
    i,
    f: a.filename,
    t: a.fileCreatedAt.toISOString().slice(11, 19),
  }));

  return `Session: ${batch.folderName ?? dateRange}
${n} images, indices 0-${n - 1}. Return EXACTLY ${n} entries in img.

Images:
${JSON.stringify(imagesMeta)}

Review the attached ${n} images and return JSON.`;
}

export const SYSTEM_PROMPT = `You review a batch of personal/family photos from a single session.

PRIORITY:
These are family memory photos. Judge people first — faces, expressions, interaction, children.
Background scenery (grass, trail, trees, sky) is secondary unless no people are visible.
If people are visible, note them first. Do not reduce a family photo to "path with grass."

TASKS:
1. Assess EVERY photo — star rating + category + brief note + keep/cull recommendation.
2. Find similarity subgroups (variations of same moment) and rank within each.

STARS (0-3, never 4-5):
0 = unremarkable/generic. 1 = good, stands out. 2 = share-worthy. 3 = session highlight.
Photos with people usually outrank empty scenery from the same day.

KEEP vs CULL — decide for EVERY photo, not just grouped ones:
- keep: worth having in the library. Distinct moment, good quality, or useful reference.
- cull: redundant, blurry, accidental, or adds nothing the kept photos don't already cover.
Within subgroups: keep 30-50%, cull the rest. Keep sharpest/best expression.
Singletons: cull if genuinely low-value (blurry, accidental, empty). Keep if it captures a moment.
Lean toward keep when in doubt — but DO recommend culling weak photos.

DESCRIPTIONS:
Every photo MUST get a UNIQUE note. If people visible, mention them first.

SIMILARITY GROUPING:
Group photos that are variations of the same moment — same subject, similar framing, <2 min apart.
Separate subgroups for different people/actions/locations/time gaps.
Photos not in any subgroup are singletons — they still need a keep/cull recommendation.

OUTPUT — compact JSON, indices 0..N-1 ONLY. Do NOT invent extra indices.
{
  "sum": "1-sentence summary",
  "img": [[i, stars, "cat", "3-5 word note", "sgId"|null, "k"|"c"], ...],
  "sg": [{"id":"g1", "type":"burst|dup|scene|subj", "all":[best,...worst], "keep":[kept], "why":"max 15 words"}, ...]
}
img tuple: [index, stars, "category", "note", subgroupId or null, "k" for keep or "c" for cull].
Category codes: por grp sel lan tra evt pet act doc rec wb ss snap tech veh food meme oth
"all" array: ordered best-first.`;
