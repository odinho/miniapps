#!/usr/bin/env npx tsx
/**
 * Tiebreaker Experiment
 *
 * Tests whether a third LLM can resolve disagreements between two models.
 * Picks batches with 2-model disagreements, sends ONLY the disputed photos
 * to a tiebreaker model with context ("Model A says keep, Model B says cull"),
 * and measures accuracy against user decisions.
 *
 * Usage:
 *   npx tsx scripts/tiebreaker_experiment.ts [--batches 16] [--server URL]
 *
 * Prerequisites:
 *   - immich-cull server running (default localhost:3737)
 *   - gcloud auth for Vertex AI
 */

import { GoogleGenAI } from "@google/genai";
import Database from "better-sqlite3";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { writeFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const maxBatches = parseInt(getArg("--batches", "16"), 10);
const server = getArg("--server", "http://localhost:3737").replace(/\/$/, "");
const tiebreakerModel = getArg("--model", "gemini-3-flash-preview");
const thinkingLevel = getArg("--thinking", "low");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BatchDetail {
  id: string;
  count: number;
  assets: Array<{ id: string; filename: string }>;
  llmModels: string[];
  photoAgreement: Array<{ assetId: string; consensus: "keep" | "cull" | "disagree" }> | null;
}

interface LlmImage {
  imageId: string;
  briefNote: string;
  suggestedStars: number;
  llmKeepCull: string;
  similaritySubgroupId: string | null;
}

interface ModelResult {
  model: string;
  images: LlmImage[];
}

interface DisputedPhoto {
  assetId: string;
  filename: string;
  index: number; // index within the full batch
  votes: Array<{ model: string; decision: string; note: string; stars: number }>;
}

interface TiebreakerResult {
  batchId: string;
  totalPhotos: number;
  disputed: number;
  resolved: number;
  tiebreakerDecisions: Array<{
    assetId: string;
    filename: string;
    modelVotes: Record<string, string>;
    tiebreakerDecision: string;
    tiebreakerReason: string;
    userDecision: string | null;
    tiebreakerMatchesUser: boolean | null;
    majorityMatchesUser: boolean | null;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchJson(url: string, timeout = 15000): Promise<any> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
  return resp.json();
}

async function getImageBase64(assetId: string, px: number): Promise<string> {
  const resp = await fetch(
    `${server}/api/preview?id=${encodeURIComponent(assetId)}&w=${px}`,
    { signal: AbortSignal.timeout(15000) },
  );
  if (!resp.ok) throw new Error(`Preview fetch failed: ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  return buf.toString("base64");
}

// ---------------------------------------------------------------------------
// Get per-model results for a batch
// ---------------------------------------------------------------------------

async function getModelResults(batchId: string, models: string[]): Promise<ModelResult[]> {
  const results: ModelResult[] = [];
  for (const model of models) {
    const detail = await fetchJson(`${server}/api/batches/${batchId}?model=${encodeURIComponent(model)}`);
    if (detail.llm?.images) {
      results.push({ model, images: detail.llm.images });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Find disputed photos
// ---------------------------------------------------------------------------

function findDisputed(
  batch: BatchDetail,
  modelResults: ModelResult[],
): DisputedPhoto[] {
  const disputed: DisputedPhoto[] = [];

  for (let i = 0; i < batch.assets.length; i++) {
    const asset = batch.assets[i];
    const votes: DisputedPhoto["votes"] = [];

    for (const mr of modelResults) {
      const img = mr.images.find((im) => im.imageId === asset.id);
      if (img) {
        votes.push({
          model: mr.model,
          decision: img.llmKeepCull,
          note: img.briefNote ?? "",
          stars: img.suggestedStars ?? 0,
        });
      }
    }

    const keepVotes = votes.filter((v) => v.decision === "keep").length;
    const cullVotes = votes.filter((v) => v.decision === "cull").length;

    // Only include if there's a genuine split (not unanimous)
    if (keepVotes > 0 && cullVotes > 0) {
      disputed.push({ assetId: asset.id, filename: asset.filename, index: i, votes });
    }
  }

  return disputed;
}

// ---------------------------------------------------------------------------
// Tiebreaker prompt
// ---------------------------------------------------------------------------

const TIEBREAKER_SYSTEM = `You are a photo curation tiebreaker. Two AI models reviewed a batch of personal/family photos and disagreed on some.

You will see ONLY the disputed photos. For each one, you get:
- The image itself
- What each model decided (keep/cull) and their reasoning

Your job: make a final keep/cull decision for each disputed photo.

GUIDELINES:
- These are family memory photos. Faces, expressions, and people matter most.
- When in doubt, KEEP. Losing a good photo is worse than keeping a mediocre one.
- A photo with people (especially children) showing clear expressions should almost always be kept.
- Screenshots, documents, and reference photos have more value than you'd expect.
- Consider: does this photo capture a DISTINCT moment? If yes, keep.

OUTPUT — JSON array, one entry per disputed photo:
[{"idx": 0, "decision": "k"|"c", "reason": "max 10 words"}, ...]

idx = the position in the disputed photos list (0-indexed), NOT the batch index.
Return EXACTLY one entry per disputed photo.`;

async function runTiebreaker(
  disputed: DisputedPhoto[],
  batchSummary: string,
): Promise<Array<{ idx: number; decision: string; reason: string }>> {
  const needsGlobal = /gemini-[3-9]/.test(tiebreakerModel);
  const ai = new GoogleGenAI({
    vertexai: true,
    project: "tagrdevin",
    location: needsGlobal ? "global" : "europe-west1",
  });

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: `${TIEBREAKER_SYSTEM}\n\nBatch context: ${batchSummary}\n\n${disputed.length} disputed photos follow:\n` },
  ];

  for (let i = 0; i < disputed.length; i++) {
    const d = disputed[i];
    const voteLines = d.votes
      .map((v) => `  ${v.model}: ${v.decision} (${v.stars}★, "${v.note}")`)
      .join("\n");
    parts.push({ text: `--- Disputed photo ${i}: ${d.filename} ---\nModel votes:\n${voteLines}` });

    const b64 = await getImageBase64(d.assetId, 1200);
    parts.push({ inlineData: { mimeType: "image/jpeg", data: b64 } });
  }

  parts.push({ text: `\nNow return your JSON decisions for all ${disputed.length} disputed photos.` });

  const config: any = {
    temperature: 0,
    maxOutputTokens: 8000,
    responseMimeType: "application/json",
  };

  if (thinkingLevel && thinkingLevel !== "none") {
    config.thinkingConfig = { thinkingLevel };
  }

  const result = await ai.models.generateContent({
    model: tiebreakerModel,
    contents: [{ role: "user", parts }],
    config,
  });

  const raw = result.text ?? "";
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

// ---------------------------------------------------------------------------
// Batch selection: find batches with 2-model disagreements
// ---------------------------------------------------------------------------

async function selectBatches(
  userDecisions: Map<string, string>,
): Promise<string[]> {
  console.log("Finding batches with multi-model disagreements...\n");
  const resp = await fetchJson(`${server}/api/batches`);
  const allBatches: Array<{
    id: string;
    count: number;
    agreement: { modelCount: number; disagreements: number; tier: string } | null;
    viewStatus: string | null;
  }> = resp.batches;

  // Batches with disagreements
  const withDisagreements = allBatches.filter(
    (b) => b.agreement && b.agreement.disagreements > 0,
  );

  console.log(`  ${allBatches.length} total batches`);
  console.log(`  ${withDisagreements.length} with multi-model disagreements`);

  // Score by: has user decisions (for validation), number of disagreements, batch size diversity
  type Scored = {
    id: string;
    disagreements: number;
    count: number;
    userDecided: number;
    score: number;
  };

  const scored: Scored[] = [];
  // Check top candidates
  for (const b of withDisagreements.slice(0, 100)) {
    const detail: BatchDetail = await fetchJson(`${server}/api/batches/${b.id}`);
    const nDecided = detail.assets.filter((a) => userDecisions.has(a.id)).length;
    // Prefer: more user decisions, moderate disagreement count, varied sizes
    const score = nDecided * 3 + (b.agreement?.disagreements ?? 0) + Math.min(b.count, 20);
    scored.push({
      id: b.id,
      disagreements: b.agreement?.disagreements ?? 0,
      count: b.count,
      userDecided: nDecided,
      score,
    });
  }

  // Sort by score, take top N
  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, maxBatches);

  console.log(`  Selected ${selected.length} batches:`);
  for (const s of selected) {
    console.log(
      `    ${s.id}: ${s.count} photos, ${s.disagreements} disputed, ${s.userDecided} user decisions`,
    );
  }
  console.log();

  return selected.map((s) => s.id);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Tiebreaker Experiment ===");
  console.log(`Model: ${tiebreakerModel}, thinking: ${thinkingLevel}\n`);

  // Load user decisions for comparison
  const db = new Database(join(__dirname, "..", "data", "state.db"), { readonly: true });
  const userDecisions = new Map<string, string>();
  for (const row of db
    .prepare("SELECT asset_id, state FROM photo_decisions WHERE state IS NOT NULL")
    .all() as any[]) {
    userDecisions.set(row.asset_id, row.state);
  }
  db.close();
  console.log(`User decisions loaded: ${userDecisions.size}\n`);

  const batchIds = await selectBatches(userDecisions);
  if (!batchIds.length) {
    console.log("No batches with disagreements found. Run rank:many with a second model first.");
    return;
  }

  const results: TiebreakerResult[] = [];
  let totalDisputed = 0;
  let totalResolved = 0;
  let tiebreakerMatchUser = 0;
  let tiebreakerMismatchUser = 0;
  let noPriorMajority = 0;
  let majorityMatchUser = 0;
  let majorityMismatchUser = 0;

  for (const batchId of batchIds) {
    console.log(`--- ${batchId} ---`);

    const detail: BatchDetail = await fetchJson(`${server}/api/batches/${batchId}`);
    const modelResults = await getModelResults(batchId, detail.llmModels);
    const disputed = findDisputed(detail, modelResults);

    if (!disputed.length) {
      console.log("  No disputes (majority resolved all). Skipping.\n");
      continue;
    }

    console.log(`  ${detail.count} photos, ${disputed.length} disputed, models: ${detail.llmModels.join(", ")}`);
    totalDisputed += disputed.length;

    // Run tiebreaker
    const t0 = Date.now();
    let tbDecisions: Array<{ idx: number; decision: string; reason: string }>;
    try {
      tbDecisions = await runTiebreaker(
        disputed,
        `${detail.count} photos from ${batchId.slice(0, 10)}`,
      );
    } catch (err: any) {
      console.log(`  ERROR: ${(err.message ?? "").slice(0, 200)}`);
      console.log();
      continue;
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    // Map tiebreaker decisions
    const batchResult: TiebreakerResult = {
      batchId,
      totalPhotos: detail.count,
      disputed: disputed.length,
      resolved: 0,
      tiebreakerDecisions: [],
    };

    for (let i = 0; i < disputed.length; i++) {
      const d = disputed[i];
      const tb = tbDecisions.find((t) => t.idx === i);
      const tbDecision = tb
        ? tb.decision === "k"
          ? "keep"
          : tb.decision === "c"
            ? "cull"
            : tb.decision
        : "unknown";
      const tbReason = tb?.reason ?? "";

      const userDec = userDecisions.get(d.assetId) ?? null;
      const modelVotes: Record<string, string> = {};
      for (const v of d.votes) modelVotes[v.model] = v.decision;

      // Check: without tiebreaker, what would the prior majority be?
      const keepVotes = d.votes.filter((v) => v.decision === "keep").length;
      const cullVotes = d.votes.filter((v) => v.decision === "cull").length;
      const priorMajority = keepVotes > cullVotes ? "keep" : cullVotes > keepVotes ? "cull" : null;

      const tiebreakerMatchesUser = userDec ? tbDecision === userDec : null;
      const majorityMatchesUser = userDec && priorMajority ? priorMajority === userDec : null;

      if (tbDecision !== "unknown") batchResult.resolved++;

      if (tiebreakerMatchesUser === true) tiebreakerMatchUser++;
      else if (tiebreakerMatchesUser === false) tiebreakerMismatchUser++;

      if (priorMajority && userDec) {
        if (majorityMatchesUser) majorityMatchUser++;
        else majorityMismatchUser++;
      } else if (userDec) {
        noPriorMajority++;
      }

      batchResult.tiebreakerDecisions.push({
        assetId: d.assetId,
        filename: d.filename,
        modelVotes,
        tiebreakerDecision: tbDecision,
        tiebreakerReason: tbReason,
        userDecision: userDec,
        tiebreakerMatchesUser,
        majorityMatchesUser,
      });
    }

    totalResolved += batchResult.resolved;
    results.push(batchResult);

    // Print per-batch summary
    const withUser = batchResult.tiebreakerDecisions.filter((d) => d.userDecision);
    const tbCorrect = withUser.filter((d) => d.tiebreakerMatchesUser).length;
    const tbWrong = withUser.filter((d) => d.tiebreakerMatchesUser === false).length;
    console.log(
      `  Tiebreaker: ${batchResult.resolved}/${disputed.length} resolved, ${elapsed}s`,
    );
    if (withUser.length) {
      console.log(
        `  vs user: ${tbCorrect}/${withUser.length} correct (${((tbCorrect / withUser.length) * 100).toFixed(0)}%), ${tbWrong} wrong`,
      );
    }

    // Print individual decisions
    for (const d of batchResult.tiebreakerDecisions) {
      const votes = Object.entries(d.modelVotes)
        .map(([m, v]) => `${m.replace("gemini-", "").replace("-preview", "")}: ${v}`)
        .join(", ");
      const userMark = d.userDecision ? (d.tiebreakerMatchesUser ? " ✓" : " ✗") : "";
      console.log(
        `    ${d.filename}: [${votes}] → TB: ${d.tiebreakerDecision}${userMark} (${d.tiebreakerReason})`,
      );
    }
    console.log();
  }

  // ---------------------------------------------------------------------------
  // Aggregate
  // ---------------------------------------------------------------------------

  console.log("=== AGGREGATE RESULTS ===\n");
  console.log(`Batches processed: ${results.length}`);
  console.log(`Total disputed photos: ${totalDisputed}`);
  console.log(`Tiebreaker resolved: ${totalResolved}`);
  console.log();

  const totalWithUser = tiebreakerMatchUser + tiebreakerMismatchUser;
  if (totalWithUser > 0) {
    console.log("Tiebreaker vs user decisions:");
    console.log(`  Correct: ${tiebreakerMatchUser}/${totalWithUser} (${((tiebreakerMatchUser / totalWithUser) * 100).toFixed(1)}%)`);
    console.log(`  Wrong:   ${tiebreakerMismatchUser}/${totalWithUser}`);

    const tbWrongCull = results.flatMap((r) =>
      r.tiebreakerDecisions.filter(
        (d) => d.tiebreakerDecision === "cull" && d.userDecision === "keep",
      ),
    ).length;
    const tbWrongKeep = results.flatMap((r) =>
      r.tiebreakerDecisions.filter(
        (d) => d.tiebreakerDecision === "keep" && d.userDecision === "cull",
      ),
    ).length;
    console.log(`  Wrong culls (dangerous): ${tbWrongCull}`);
    console.log(`  Wrong keeps (safe):      ${tbWrongKeep}`);
  }

  const totalMajUser = majorityMatchUser + majorityMismatchUser;
  if (totalMajUser > 0) {
    console.log("\nPrior majority (without tiebreaker) vs user:");
    console.log(`  Correct: ${majorityMatchUser}/${totalMajUser} (${((majorityMatchUser / totalMajUser) * 100).toFixed(1)}%)`);
    console.log(`  (${noPriorMajority} had no prior majority — true ties)`);
  }

  // Save raw results
  const outPath = `/tmp/tiebreaker-experiment-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(outPath, JSON.stringify({ config: { tiebreakerModel, thinkingLevel, maxBatches }, results }, null, 2));
  console.log(`\nRaw results saved to ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
