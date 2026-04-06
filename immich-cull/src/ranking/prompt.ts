/** Build the LLM prompt for a day-batch review */

import { SessionBatch } from "../batching/session-batcher.js";

export function buildPrompt(batch: SessionBatch): string {
  const dateRange = `${batch.dateRange.start.toISOString().slice(0, 16)} to ${batch.dateRange.end.toISOString().slice(0, 16)}`;
  const n = batch.assets.length;

  // Lean metadata: just index, filename, time. No stars, no flags — model judges independently.
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
1. Assess EVERY photo — star rating + category + unique brief note.
2. Find similarity subgroups and rank within each.
3. For each subgroup, recommend keep vs cull.

STARS (0-3, never 4-5):
0 = unremarkable/generic. 1 = good, stands out. 2 = share-worthy. 3 = session highlight.
Photos with people usually outrank empty scenery from the same day.
Give a real distribution across the batch — not all the same score.

DESCRIPTIONS:
Look at each photo individually. Every photo MUST get a UNIQUE note.
If people are visible, mention them first, not the background.
Do not label a photo as "path" or "grass" when a person is a clear subject.

SIMILARITY GROUPING:
Create subgroups for genuinely similar photos (same moment/pose/framing).
Prefer precise, small groups over broad ones.
Shared outdoor setting alone (same trail, daylight, grass) is NOT enough to group.
Create SEPARATE subgroups for:
- different people combinations
- different actions, poses, or expressions
- clear time gaps (>2 min)
- clearly different framing or location
A subgroup = one moment, not a whole walk.

CULLING:
Conservative — only cull when clearly redundant given what's kept.
Keep extras if they capture different moments, angles, or expressions.

OUTPUT — compact JSON, indices 0..N-1 ONLY. Do NOT invent indices beyond the input.
{
  "sum": "1-sentence summary",
  "img": [[i, stars, "cat", "3-5 word note", "sgId"|null], ...],
  "sg": [{"id":"g1", "type":"burst|dup|scene|subj", "all":[best,...worst], "keep":[kept], "why":"max 15 words"}, ...]
}
Category codes: por grp sel lan tra evt pet act doc rec wb ss snap tech veh food meme oth
"all" array: ordered best-first (best at position 0, worst last).`;
