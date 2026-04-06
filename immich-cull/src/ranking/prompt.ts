/** Build the LLM prompt for a day-batch review */

import { SessionBatch } from "../batching/session-batcher.js";

export function buildPrompt(batch: SessionBatch): string {
  const dateRange = `${batch.dateRange.start.toISOString().slice(0, 16)} to ${batch.dateRange.end.toISOString().slice(0, 16)}`;
  const n = batch.assets.length;

  const imagesMeta = batch.assets.map((a, i) => ({
    i,
    f: a.filename,
    t: a.fileCreatedAt.toISOString().slice(11, 19),
    s: a.rating ?? 0,
    sc: /screenshot/i.test(a.filename) ? 1 : 0,
    sn: /snapchat/i.test(a.filename) ? 1 : 0,
  }));

  // Pre-compute hints for the model
  const scIndices = imagesMeta.filter(m => m.sc).map(m => m.i);
  const snIndices = imagesMeta.filter(m => m.sn).map(m => m.i);
  const hints: string[] = [];
  if (scIndices.length >= 2) hints.push(`Screenshots: indices [${scIndices.join(",")}] — consider grouping.`);
  if (snIndices.length >= 2) hints.push(`Snapchat saves: indices [${snIndices.join(",")}] — consider grouping.`);

  return `Session: ${batch.folderName ?? dateRange}
${n} images, indices 0-${n - 1}. Return EXACTLY ${n} entries in img.
${hints.length ? "\nHints:\n" + hints.join("\n") + "\n" : ""}
Images:
${JSON.stringify(imagesMeta)}

Review the attached ${n} images and return JSON.`;
}

export const SYSTEM_PROMPT = `You review photos from a single session for culling and rating.

TASKS:
1. Assess EVERY photo — star rating + category + brief note.
2. Find similarity groups (3+ similar photos) and rank within each.
3. For each group, recommend keep vs cull.

STARS (0-3, never 4-5):
0 = unremarkable, generic. 1 = good, stands out. 2 = share-worthy. 3 = session highlight.
Give a distribution: not all the same score. Existing 2+ stars are protected (never lower).

SIMILARITY GROUPING — critical:
After assessing all images, scan for clusters:
- Near-identical compositions (same subject, similar framing) → "dup"
- Burst sequences (<5s apart, similar shots) → "burst"
- Same scene from different angles/times → "scene"
- Same subject across the session → "subj"
If multiple images have sn=1 (snapchat), consider grouping them.
If multiple images have sc=1 (screenshot), consider grouping them.
Groups of 10+ similar photos are MORE important to identify than groups of 3.
Err on the side of grouping. Every cluster of similar photos must be a subgroup.

CULLING:
Conservative — only cull when clearly redundant given what's kept.
"Keeping a few extra isn't high cost. Cull what we'll never need."
Within groups, keep extras if they capture different moments/angles/expressions.

DESCRIPTIONS:
Look at each photo individually. Every photo MUST get a UNIQUE description.
Do NOT repeat the same note for multiple photos. Describe what you actually see.

OUTPUT — compact JSON, indices 0..N-1 only. Do NOT invent extra indices.
{
  "sum": "1-sentence summary",
  "img": [[i, stars, "cat", "note 3-5 words", "sgId"|null], ...],
  "sg": [{"id":"g1", "type":"burst|dup|scene|subj", "all":[best,...worst], "keep":[kept], "why":"max 15 words"}, ...]
}
Only add 6th element true to img tuple if protectFromCull.
Category codes: por grp sel lan tra evt pet act doc rec wb ss snap tech veh food meme oth
"all" array: ordered best-first (best photo at index 0, worst last).`;
