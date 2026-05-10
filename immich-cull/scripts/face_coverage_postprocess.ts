#!/usr/bin/env npx tsx
/**
 * Face-coverage post-processor.
 *
 * Takes v1_prod's cached batch picks and ensures every distinct named person
 * appearing in the batch is covered by at least one keeper. If a person-cluster
 * has zero keepers, greedy set-cover adds the photo that covers the most
 * still-missing people.
 *
 * No new LLM calls — just metadata + deterministic promotion logic.
 *
 * Output: data/experiments/2026-04-20-batch-v1_prod_face_covered.json,
 * in the same shape as other batch experiments so the grader can load it.
 * Variant = `v1_prod_face_covered`. Pick bundles identical to v1_prod inherit
 * the user's existing batch_prod grades automatically.
 *
 * Rationale (from Codex methodology review, 2026-04-21):
 *   v1_prod scores 89.7% acceptable / 0 severity-3 over 145 graded picks.
 *   The main severity-2 failure pattern is "lost a person entirely from the
 *   batch" (see notes in batch_prod-grades.json for breakfast-table case).
 *   Face-coverage post-check targets this specific failure without retraining.
 *   If the delta improves acceptable-rate without blowing up retain-rate,
 *   v1_prod + face-coverage = shippable auto-cull pipeline.
 */

import Database from "better-sqlite3";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync } from "fs";
import { config as loadEnv } from "dotenv";

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMMICH_URL = (process.env.IMMICH_URL ?? "").replace(/\/$/, "");
const IMMICH_KEY = process.env.IMMICH_API_KEY ?? "";
const server = "http://localhost:3737";

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const maxBatches = parseInt(getArg("--batches", "80"), 10);
const minPhotos = parseInt(getArg("--min-photos", "8"), 10);
const userCoverageMin = parseFloat(getArg("--user-coverage", "0.5"));
// Named-only mode: ignore Immich's unnamed face clusters. Hypothesis from user notes —
// Immich over-splits the same person into named + unnamed clusters, so requiring coverage
// for every cluster ID adds spurious photos. Only require coverage for NAMED people.
const namedOnly = args.includes("--named-only");

const outPath = resolve(
  __dirname,
  namedOnly
    ? "../data/experiments/2026-04-21-batch-v1_prod_face_covered_named.json"
    : "../data/experiments/2026-04-20-batch-v1_prod_face_covered.json",
);

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new Error(`${url}: ${resp.status}`);
  return resp.json();
}

async function fetchPeople(assetId: string): Promise<string[]> {
  if (!IMMICH_URL || !IMMICH_KEY) return [];
  try {
    const r = await fetch(`${IMMICH_URL}/api/assets/${assetId}`, {
      headers: { "x-api-key": IMMICH_KEY },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return [];
    const j = (await r.json()) as { people?: Array<{ name?: string; id?: string }> };
    if (namedOnly) {
      return (j.people ?? [])
        .filter((p) => p.name?.trim())
        .map((p) => `name:${p.name!.trim()}`);
    }
    return (j.people ?? [])
      .map((p) => (p.name?.trim() ? `name:${p.name.trim()}` : p.id ? `cluster:${p.id}` : ""))
      .filter((n) => n.length > 0);
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------------------
// Set-cover promotion
// ----------------------------------------------------------------------------

/**
 * Greedy set-cover over still-missing people.
 *
 * Returns the minimal list of photo indices to add to the keep set so that
 * every person in the batch is covered by at least one keeper. Ties broken by:
 *   1. Prefer the photo covering MORE people total (likely the group shot).
 *   2. Fall back to earliest index (chronologically first).
 */
function greedyFaceCover(
  photoPeople: string[][],
  currentKeeps: Set<number>,
): { additions: number[]; missingBefore: string[]; missingAfter: string[] } {
  const allPeople = new Set<string>();
  for (const p of photoPeople) for (const n of p) allPeople.add(n);

  const covered = new Set<string>();
  for (const i of currentKeeps) for (const n of photoPeople[i]) covered.add(n);

  const missingBefore = [...allPeople].filter((n) => !covered.has(n));
  if (!missingBefore.length) {
    return { additions: [], missingBefore: [], missingAfter: [] };
  }

  const additions: number[] = [];
  let missing = new Set(missingBefore);
  const candidatePool = new Set<number>(
    photoPeople.map((_, i) => i).filter((i) => !currentKeeps.has(i)),
  );

  while (missing.size) {
    let best = -1;
    let bestNewCoverage = 0;
    let bestTotalCoverage = 0;
    for (const i of candidatePool) {
      const iNew = photoPeople[i].filter((n) => missing.has(n)).length;
      if (iNew === 0) continue;
      const iTotal = photoPeople[i].length;
      if (
        iNew > bestNewCoverage ||
        (iNew === bestNewCoverage && iTotal > bestTotalCoverage) ||
        (iNew === bestNewCoverage && iTotal === bestTotalCoverage && (best < 0 || i < best))
      ) {
        best = i;
        bestNewCoverage = iNew;
        bestTotalCoverage = iTotal;
      }
    }
    if (best < 0) break; // no candidate can cover remaining — unnamed-only photos
    additions.push(best);
    candidatePool.delete(best);
    for (const n of photoPeople[best]) missing.delete(n);
  }

  return {
    additions,
    missingBefore,
    missingAfter: [...missing],
  };
}

// ----------------------------------------------------------------------------
// Batch selection (match batch_prod shape)
// ----------------------------------------------------------------------------

type BatchPick = {
  batchId: string;
  assetIds: string[];
  filenames: string[];
  userKeepIds: string[];
  userCullIds: string[];
  v1KeepIds: string[];
};

async function selectBatches(userDecisions: Map<string, string>): Promise<BatchPick[]> {
  const resp = await fetchJson(`${server}/api/batches`);
  const all: Array<{ id: string; hasLlmResult: boolean; count: number }> = resp.batches;

  const picks: BatchPick[] = [];
  for (const b of all) {
    if (!b.hasLlmResult) continue;
    if (b.count < minPhotos) continue;
    if (picks.length >= maxBatches) break;

    const detail = await fetchJson(`${server}/api/batches/${b.id}`);
    if (!detail.llm) continue;

    const assetIds: string[] = detail.assets.map((a: any) => a.id);
    const filenames: string[] = detail.assets.map((a: any) => a.filename);

    const userKeep: string[] = [];
    const userCull: string[] = [];
    for (const id of assetIds) {
      const d = userDecisions.get(id);
      if (d === "keep") userKeep.push(id);
      else if (d === "cull") userCull.push(id);
    }
    const coverage = (userKeep.length + userCull.length) / assetIds.length;
    if (coverage < userCoverageMin) continue;

    const v1KeepIds: string[] = [];
    for (const img of detail.llm.images ?? []) {
      if (img.llmKeepCull === "keep") v1KeepIds.push(img.imageId ?? img.id);
    }

    picks.push({
      batchId: b.id,
      assetIds,
      filenames,
      userKeepIds: userKeep,
      userCullIds: userCull,
      v1KeepIds,
    });
  }
  return picks;
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  if (!IMMICH_URL || !IMMICH_KEY) {
    console.error("IMMICH_URL / IMMICH_API_KEY env vars are required");
    process.exit(1);
  }

  console.log("=== Face-coverage post-processor ===");
  console.log(`Output: ${outPath}\n`);

  const db = new Database(resolve(__dirname, "../data/state.db"), { readonly: true });
  const userDecisions = new Map<string, string>();
  for (const row of db
    .prepare(
      "SELECT asset_id, state FROM photo_decisions WHERE source = 'manual' AND state IS NOT NULL",
    )
    .all() as any[]) {
    userDecisions.set(row.asset_id, row.state);
  }
  db.close();
  console.log(`User decisions: ${userDecisions.size}`);

  const batches = await selectBatches(userDecisions);
  console.log(`Selected ${batches.length} batches\n`);

  const results: Array<Record<string, unknown>> = [];
  let deltaBatches = 0;
  let totalAdditions = 0;
  let uncoverableBatches = 0;

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    process.stdout.write(`[${bi + 1}/${batches.length}] ${batch.batchId}: ${batch.assetIds.length}p — fetching people...`);

    const photoPeople: string[][] = [];
    for (const id of batch.assetIds) {
      photoPeople.push(await fetchPeople(id));
    }

    const v1KeepIdx = new Set<number>(
      batch.v1KeepIds.map((id) => batch.assetIds.indexOf(id)).filter((i) => i >= 0),
    );
    const cover = greedyFaceCover(photoPeople, v1KeepIdx);

    const originalPicks = [...v1KeepIdx].toSorted((a, b) => a - b);
    const augmentedPicks = [...v1KeepIdx, ...cover.additions].toSorted((a, b) => a - b);

    const hasDelta = cover.additions.length > 0;
    if (hasDelta) deltaBatches++;
    if (cover.missingAfter.length) uncoverableBatches++;
    totalAdditions += cover.additions.length;

    process.stdout.write(
      ` v1=${originalPicks.length}  ppl_missing=${cover.missingBefore.length}  added=${cover.additions.length}  uncovered=${cover.missingAfter.length}\n`,
    );

    const userKeepSet = new Set(batch.userKeepIds);
    const augmentedAssetIds = augmentedPicks.map((i) => batch.assetIds[i]);
    const userMatches = augmentedAssetIds.some((id) => userKeepSet.has(id));

    const reasonParts: string[] = [`v1_prod kept ${originalPicks.length}/${batch.assetIds.length}`];
    if (hasDelta) {
      reasonParts.push(
        `added ${cover.additions.length} to cover: ${cover.missingBefore.map((p) => p.replace(/^(name|cluster):/, "")).join(", ")}`,
      );
    } else if (cover.missingBefore.length === 0) {
      reasonParts.push("all people already covered");
    } else {
      reasonParts.push(`${cover.missingBefore.length} people uncoverable (only in v1 keeps)`);
    }

    results.push({
      group: {
        batchId: batch.batchId,
        subgroupId: "whole-batch",
        type: "batch",
        assetIds: batch.assetIds,
        filenames: batch.filenames,
        llmKeepIds: batch.v1KeepIds,
        llmRanking: batch.assetIds,
        userKeepIds: batch.userKeepIds,
        userCullIds: batch.userCullIds,
      },
      variants: [
        {
          variant: "v1_prod",
          bestPicks: originalPicks,
          ranking: [],
          reason: `v1 production LLM (cached): ${originalPicks.length} keeps`,
          elapsed: 0,
          matchesUser: batch.userKeepIds.length > 0 ? originalPicks.some((i) => userKeepSet.has(batch.assetIds[i])) : null,
          matchesLlm: true,
          tokensIn: 0,
          tokensOut: 0,
          _facesPerPhoto: photoPeople,
        },
        {
          variant: namedOnly ? "v1_prod_face_covered_named" : "v1_prod_face_covered",
          bestPicks: augmentedPicks,
          ranking: [],
          reason: reasonParts.join("; "),
          elapsed: 0,
          matchesUser: batch.userKeepIds.length > 0 ? userMatches : null,
          matchesLlm: true,
          tokensIn: 0,
          tokensOut: 0,
          _facesAdded: cover.additions,
          _peopleCovered: cover.missingBefore,
          _peopleUncovered: cover.missingAfter,
        },
      ],
    });

    // Snapshot every 5 batches in case we're interrupted
    if ((bi + 1) % 5 === 0 || bi === batches.length - 1) {
      writeFileSync(
        outPath,
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            experimentType: "batch",
            completedBatches: results.length,
            targetBatches: batches.length,
            variants: ["v1_prod", namedOnly ? "v1_prod_face_covered_named" : "v1_prod_face_covered"],
            promptKind: namedOnly ? "v1_prod_face_covered_named" : "v1_prod_face_covered",
            prompt: `[post-processor] greedy face-coverage over v1_prod cached picks${namedOnly ? " (NAMED people only)" : ""}`,
            stats: {
              totalBatches: results.length,
              batchesWithDelta: deltaBatches,
              totalAdditions,
              uncoverableBatches,
            },
            results,
          },
          null,
          2,
        ),
      );
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Batches processed: ${batches.length}`);
  console.log(`Batches with a face-coverage delta: ${deltaBatches}`);
  console.log(`Total photos added (across all batches): ${totalAdditions}`);
  console.log(`Batches with uncoverable people (unnamed + only-in-culls): ${uncoverableBatches}`);
  console.log(`Output: ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
