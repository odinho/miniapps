/** Build the LLM prompt for a day-batch review */

import { SessionBatch } from "../batching/session-batcher.js";
import { Asset } from "../shared/types.js";

export function buildPrompt(batch: SessionBatch): string {
  const dateRange = `${batch.dateRange.start.toISOString().slice(0, 16)} to ${batch.dateRange.end.toISOString().slice(0, 16)}`;

  // Use short integer indices as image IDs to save output tokens
  const imagesMeta = batch.assets.map((a, i) => ({
    i, // short index as ID — LLM uses this in output
    f: a.filename,
    t: a.fileCreatedAt.toISOString().slice(11, 19), // just HH:MM:SS
    s: a.rating ?? 0, // existing stars
    sc: /screenshot/i.test(a.filename) ? 1 : 0,
    sn: /snapchat/i.test(a.filename) ? 1 : 0,
  }));

  return `Session metadata:
{
  "batchId": "${batch.id}",
  "batchSize": ${batch.assets.length},
  "dateRange": "${dateRange}",
  "folderName": ${batch.folderName ? `"${batch.folderName}"` : "null"}
}

Images in chronological order:
${JSON.stringify(imagesMeta, null, 2)}

Now review the attached images and return JSON matching the schema.`;
}

export const SYSTEM_PROMPT = `You are reviewing a batch of photos from a single photography session (one day, trip, or outing).

Your job is to:
1. Assess EVERY photo individually — suggest a star rating and category.
2. Identify groups of similar or near-duplicate photos within the batch.
3. For each similarity group, rank the photos and recommend which to keep vs cull.

Star rating scale (0-3, you never assign 4 or 5):
- 0: Processed, unremarkable. Generic, redundant, or purely functional.
- 1: Good photo. Would pick this one out when scrolling. Nice moment, light, composition, or useful reference.
- 2: Share-worthy. Genuinely good, would show to someone.
- 3: Session highlight. Best photo(s) of this batch. Would feature in a trip recap.

Important rules:
- Assess EVERY image. Do not skip any.
- For star ratings, judge relative to this session/batch. Every batch should have a distribution — not all 0, not all 2.
- Existing star ratings of 2+ are protected: never suggest lower than the existing rating.
- Technical/documentation images, receipts, screenshots: judge by usefulness, not beauty.
- Snapchat saves or partner-shared personal content: protect if meaningful, even if quality is low.
- When identifying similarity subgroups, be inclusive: if 3+ photos look like the same scene/moment/subject, group them.
- Within similarity subgroups, rank by: sharpness, expression, composition, timing, uniqueness of moment.
- Recommend keeping extras when photos capture genuinely different moments or angles.
- The user's philosophy: "Keeping a few extra isn't high cost. This is mostly about culling what we never will need anyway." Be conservative — only recommend culling when the image is clearly redundant given what's being kept.
- Return valid JSON only, matching the provided schema exactly.

COMPACT JSON — use integer index (i) from input as image ID. Be terse.
{
  "sum": "1-sentence summary",
  "img": [[i, stars, "cat", "note max 5 words", "sgId"|null], ...],
  "sg": [{"id":"g1", "type":"burst|dup|scene|subj", "all":[best,...worst], "keep":[kept], "why":"max 15 words"}, ...]
}
img is array-of-arrays: [index, 0-3 stars, "category", "brief note", subgroupId or null].
Only include "p" key on img entry if protectFromCull: [[i, s, "cat", "note", "sg", true]].
Category codes: por grp sel lan tra evt pet act doc rec wb ss snap tech veh food meme oth`;
