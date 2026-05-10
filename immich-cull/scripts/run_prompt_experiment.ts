/**
 * Run a single LLM call with a custom prompt variant on a specific batch.
 * Compares the result against user decisions.
 *
 * Usage:
 *   npx tsx scripts/run_prompt_experiment.ts --batch 2024-02-10-75515d02efc2 --variant v1
 *   npx tsx scripts/run_prompt_experiment.ts --batch 2024-05-10-b4523b5454de --variant v2
 */
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import { readFileSync } from "fs";
import { resolve } from "path";
import { SessionBatch } from "../src/batching/session-batcher.js";
import { StateDb } from "../src/db/state-db.js";
import { expandCompactResponse } from "../src/ranking/llm-client.js";
import { buildPrompt } from "../src/ranking/prompt.js";

const MODEL = "gemini-3.1-flash-lite-preview";
const PREVIEW_PX = 1200;

// ===== PROMPT VARIANTS =====

const VARIANTS: Record<string, string> = {
  v0: `You review a batch of personal/family photos from a single session.

PRIORITY: Family memory photos. Judge people first — faces, expressions, interaction.

TASKS: 1. Assess EVERY photo. 2. Find similarity subgroups and rank within each.

STARS (0-5): 0=filler, 1=good, 2=strong, 3=excellent, 4=exceptional, 5=gallery-worthy.
Be STRICT: most photos 0-1. Rate on own merit.

KEEP vs CULL: Aim ~40-50% keep. Near-identical bursts might keep 1 (10%), diverse moments 80%.

Subgroups — be strict:
- Default: ONLY single best frame per subgroup.
- Second keep only if genuinely different framing or expression.
- Action: keep peak moment only.

Singletons: Keep if distinct moment. Cull if blurry/accidental.
CRITICAL: group thoroughly, very few singletons.

Category codes: por grp sel lan tra evt pet act doc rec wb ss snap tech veh food meme oth

OUTPUT — compact JSON:
{"sum":"summary","img":[[i,stars,"cat","note","sgId"|null,"k"|"c"],...],"sg":[{"id":"g1","type":"burst|dup|scene|subj","all":[best,...worst],"keep":[kept],"why":"reason"}]}`,

  v1: `You review a batch of personal/family photos from a single session.

PRIORITY: Family memory photos. Judge people first — faces, expressions, interaction.

TASKS: 1. Assess EVERY photo. 2. Find similarity subgroups and rank within each.

STARS (0-5): 0=filler, 1=good, 2=strong, 3=excellent, 4=exceptional, 5=gallery-worthy.
Be STRICT: most photos 0-1. Rate on own merit.

KEEP vs CULL: Aim ~50-60% keep. When in doubt, keep — user prefers too many over losing good ones.

Subgroups — balanced:
- Default: keep 1-2 per subgroup. For subgroups of 5+, keep 2-3.
- Keep a second if it shows: different expression, different action stage, different framing, or a distinct moment.
- Action sequences: keep 2-3 frames showing different stages.
- Same-scene landscapes: keep 2-3 variants unless truly identical.

Singletons: Keep if distinct moment. Cull if blurry/accidental.
CRITICAL: group thoroughly, very few singletons.

Category codes: por grp sel lan tra evt pet act doc rec wb ss snap tech veh food meme oth

OUTPUT — compact JSON:
{"sum":"summary","img":[[i,stars,"cat","note","sgId"|null,"k"|"c"],...],"sg":[{"id":"g1","type":"burst|dup|scene|subj","all":[best,...worst],"keep":[kept],"why":"reason"}]}`,

  v2: `You review a batch of personal/family photos from a single session.

PRIORITY: Family memory photos. Judge people first — faces, expressions, interaction.

TASKS: 1. Assess EVERY photo. 2. Find similarity subgroups and rank within each.

STARS (0-5): 0=filler, 1=good, 2=strong, 3=excellent, 4=exceptional, 5=gallery-worthy.
Be STRICT: most photos 0-1. Rate on own merit.

KEEP vs CULL: Aim ~50-60% keep. These are family memories — err on keeping.
IMPORTANT: Different moments within the same scene are worth keeping separately.
A child looking at a cat is a DIFFERENT MEMORY than the child reaching for the cat, even if taken seconds apart. Keep both.

Subgroups — moment-aware:
- Default: keep 1-2 per subgroup. For 5+, keep 2-3.
- A different moment = a keep. Examples:
  * Different expression (smiling vs laughing vs looking away)
  * Different action stage (walking vs reaching vs holding)
  * Different framing that reveals something new
  * Subject interacting differently
- Only cull when truly the same moment with no meaningful difference.
- In large bursts (8+ photos): keep 3-4 showing the range of the moment.

Singletons: Keep if distinct moment. Cull if blurry/accidental.
CRITICAL: group thoroughly, very few singletons.

Category codes: por grp sel lan tra evt pet act doc rec wb ss snap tech veh food meme oth

OUTPUT — compact JSON:
{"sum":"summary","img":[[i,stars,"cat","note","sgId"|null,"k"|"c"],...],"sg":[{"id":"g1","type":"burst|dup|scene|subj","all":[best,...worst],"keep":[kept],"why":"reason"}]}`,
};

async function main() {
  const args = process.argv.slice(2);
  const batchId = args.find(a => a.startsWith("--batch="))?.split("=")[1]
    ?? args[args.indexOf("--batch") + 1];
  const variantId = args.find(a => a.startsWith("--variant="))?.split("=")[1]
    ?? args[args.indexOf("--variant") + 1]
    ?? "v1";

  if (!batchId) {
    console.log("Usage: npx tsx scripts/run_prompt_experiment.ts --batch BATCH_ID --variant v0|v1|v2");
    process.exit(1);
  }

  const systemPrompt = VARIANTS[variantId];
  if (!systemPrompt) {
    console.log(`Unknown variant: ${variantId}. Available: ${Object.keys(VARIANTS).join(", ")}`);
    process.exit(1);
  }

  console.log(`Variant: ${variantId}`);
  console.log(`Batch: ${batchId}`);
  console.log(`Model: ${MODEL}`);
  console.log();

  // Fetch batch detail from server
  const resp = await fetch(`http://localhost:3737/api/batches/${batchId}`);
  const batchDetail = await resp.json() as any;
  if (!batchDetail.assets) {
    console.log("ERROR: batch not found");
    process.exit(1);
  }

  const assets = batchDetail.assets;
  console.log(`Photos: ${assets.length}`);

  // Build user prompt
  const imagesMeta = assets.map((a: any, i: number) => ({
    i, f: a.filename, t: new Date(a.date).toISOString().slice(11, 19),
  }));
  const userPrompt = `Session: ${batchDetail.folderName ?? `${batchDetail.dateRange.start} to ${batchDetail.dateRange.end}`}
${assets.length} images, indices 0-${assets.length - 1}. Return EXACTLY ${assets.length} entries in img.

Images:
${JSON.stringify(imagesMeta)}

Review the attached ${assets.length} images and return JSON.`;

  // Prepare images
  const parts: any[] = [{ text: systemPrompt + "\n\n" + userPrompt }];

  for (let i = 0; i < assets.length; i++) {
    const a = assets[i];
    // Get image from server preview API
    const imgResp = await fetch(`http://localhost:3737/api/preview?id=${encodeURIComponent(a.id)}`);
    const imgBuf = Buffer.from(await imgResp.arrayBuffer());
    parts.push({ text: `--- Image ${i}: ${a.filename} ---` });
    parts.push({
      inlineData: { mimeType: "image/jpeg", data: imgBuf.toString("base64") },
    });
  }

  parts.push({ text: "Now return your JSON assessment for all images above." });

  // Call Vertex AI
  console.log("Calling Vertex AI...");
  const ai = new GoogleGenAI({ vertexai: true, project: "tagrdevin", location: "global" });
  const result = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts }],
    config: { temperature: 0.2, maxOutputTokens: 65000, responseMimeType: "application/json" },
  });

  const rawJson = result.text ?? "";
  const inputTokens = result.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = result.usageMetadata?.candidatesTokenCount ?? 0;
  console.log(`Tokens: ${inputTokens} in / ${outputTokens} out`);

  // Parse response
  let raw: any;
  try {
    raw = JSON.parse(rawJson);
  } catch {
    console.log("ERROR: could not parse response JSON");
    console.log(rawJson.slice(0, 500));
    process.exit(1);
  }

  // Load user decisions
  const stateDb = new StateDb("data/state.db");
  const assetIds = assets.map((a: any) => a.id);
  const userDecisions = stateDb.getPhotoDecisions(assetIds);
  stateDb.close();

  // Compare
  const imgs = raw.img ?? [];
  const sgs = raw.sg ?? [];

  let agree = 0, wrongCull = 0, wrongKeep = 0, total = 0;
  const disagreements: string[] = [];

  for (const img of imgs) {
    if (!Array.isArray(img) || img.length < 6) continue;
    const [idx, stars, cat, note, sgId, kc] = img;
    if (typeof idx !== "number" || idx < 0 || idx >= assets.length) continue;

    const assetId = assets[idx].id;
    const llmDecision = kc === "k" ? "keep" : "cull";
    const userState = userDecisions[assetId]?.state;
    if (!userState) continue;

    total++;
    if (llmDecision === userState) {
      agree++;
    } else if (llmDecision === "cull" && userState === "keep") {
      wrongCull++;
      disagreements.push(`  idx=${idx} llm=CULL user=KEEP stars=${stars} [${cat}] "${note}"`);
    } else {
      wrongKeep++;
      disagreements.push(`  idx=${idx} llm=KEEP user=CULL stars=${stars} [${cat}] "${note}"`);
    }
  }

  // Report
  console.log();
  console.log(`=== RESULTS: ${variantId} on ${batchId} ===`);
  console.log(`  Total comparable: ${total}`);
  console.log(`  Agreement: ${agree}/${total} (${(agree/total*100).toFixed(1)}%)`);
  console.log(`  Wrong culls: ${wrongCull} (LLM culled, user kept)`);
  console.log(`  Wrong keeps: ${wrongKeep} (LLM kept, user culled)`);
  console.log(`  Keep count: LLM ${imgs.filter((i: any) => i[5] === "k").length}, user ${Object.values(userDecisions).filter((d: any) => d.state === "keep").length}`);
  console.log(`  Subgroups: ${sgs.length}`);

  if (disagreements.length) {
    console.log(`  Disagreements:`);
    for (const d of disagreements) console.log(d);
  }

  // Show subgroup structure
  console.log();
  console.log("Subgroup keeps:");
  for (const sg of sgs) {
    const all = sg.all ?? sg.imageIds ?? [];
    const keep = sg.keep ?? sg.recommendedKeepIds ?? [];
    console.log(`  ${sg.id}: ${all.length} photos, keep ${keep.length} — ${sg.why ?? sg.rationale ?? ""}`);
  }
}

main().catch(console.error);
