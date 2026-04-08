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

STARS (0-5):
0 = extra/filler — technically fine but adds nothing unique. Most photos in a day are 0-star.
1 = good — stands out from the batch, worth keeping. A typical "nice photo."
2 = strong — noticeably better than average. Good composition, expression, or moment.
3 = excellent — one of the best from this session. Would share with family.
4 = exceptional — rarely given. Portfolio-quality or captures a truly special moment. Max 1-2 per batch.
5 = gallery-worthy — almost never given. Could be printed, sold, or exhibited. Most batches have zero 5-star photos.
Be STRICT: most photos should be 0-1. A batch of 10 typical family photos might have 7× 0-star, 2× 1-star, 1× 2-star.
Within subgroups: rate each photo ON ITS OWN MERIT — as if it were the only photo kept from that moment. Do NOT downgrade because similar photos exist. We post-process to assign stars only to the primary keeper. If the moment deserves 3★, the best photo in the subgroup should get 3★.
Photos with people usually outrank empty scenery from the same day.

KEEP vs CULL:
Aim to keep roughly 40-50% on average, but this varies — a batch of 10 near-identical bursts might keep 1 (10%), a batch of diverse moments might keep 80%.

Subgroups — be strict:
- Default to keeping ONLY the single best frame per subgroup.
- A second keep is justified if it offers genuinely different framing (e.g., one close-up + one wider shot) or a clearly different expression/action peak.
- But if the close-up doesn't add much over the overview (or vice versa), one is enough.
- Action bursts (running, walking, playing): keep the peak moment. Only keep a second if it shows a genuinely different action or angle.

Singletons:
- Keep if it captures a distinct moment, memory, or reference. Cull if blurry, accidental, or truly empty.

CRITICAL — grouping must be thorough:
- There should be very few singletons. If multiple photos are from the same scene, same time period, or same location — GROUP THEM even if they're not exact duplicates.
- Example: 3 photos of people talking at a hospital bed + 4 photos of grandpa holding a child = TWO subgroups, not 7 singletons.
- Only leave a photo as a singleton if it is genuinely unrelated to every other photo in the batch — different time, different place, different subject.
- When in doubt, make the group. The user can adjust keeps within groups using +/−.

Category-specific guidance:
- act (action): Historically over-kept. If 5 photos of the same action, keep 1-2 best. Require sharp face, eye contact, or peak action to justify keeps.
- por/grp (portrait/group): Keep only the best-faces frame. Cull near-matches even if technically fine.
- veh (vehicle): Cull unless it's a meaningful moment (e.g., new car reveal). Generic car detail shots → cull.
- snap (snapchat saves): Keep if it has genuine social/memory value (people, conversation). Cull disposable saves that look like screenshots.
- food: Keep a representative photo of a meal if it looks intentional. Don't keep every angle.
- ss/tech/doc (screenshot/technical/document): Keep if it's useful reference. The user values these more than you'd expect.

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
"all" array: ordered best-first. "keep" array: STRICT SUBSET of "all" — must be SHORTER than "all". Default to keeping only the single best per subgroup. Mark the rest "c" in img.`;
