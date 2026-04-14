#!/usr/bin/env tsx
/**
 * Submit a Vertex AI batch prediction job for N pending batches.
 *
 * Usage:
 *   npm run rank:batch:submit -- --bucket gs://tagrdevin-immich-cull-batch [--count 500]
 *
 * What it does:
 *   1. Hits the running server to list pending batches
 *   2. For each, GETs /api/batches/:id/llm-request to get the ready Gemini request body
 *   3. Writes all requests to a local JSONL file
 *   4. Uploads JSONL to GCS (via `gcloud storage cp`)
 *   5. Creates a Vertex AI batch prediction job
 *   6. Writes a sidecar JSON file with job metadata → used by rank-batch-status
 *
 * See docs/batch-mode.md for the full workflow.
 */
import { execSync } from "child_process";
import { createWriteStream, writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GoogleGenAI } from "@google/genai";
import { mapWithConcurrency } from "./concurrency.js";
import { DEFAULT_LLM_CONFIG } from "../ranking/llm-client.js";

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
function requireArg(flag: string): string {
  const v = getArg(flag, "");
  if (!v) {
    console.error(`Missing required arg: ${flag}`);
    process.exit(1);
  }
  return v;
}

const bucket = requireArg("--bucket").replace(/\/$/, "");
const count = Number.parseInt(getArg("--count", "500"), 10);
const concurrent = Number.parseInt(getArg("--concurrent", "8"), 10);
const server = getArg("--server", "http://localhost:3737").replace(/\/$/, "");
const model = getArg("--model", DEFAULT_LLM_CONFIG.model.replace("google/", ""));
const project = getArg("--project", "tagrdevin");
// Batch prediction is regional (not global) even for Gemini 3.x
const location = getArg("--location", "us-central1");

interface BatchSummary {
  id: string;
  hasLlmResult: boolean;
}

async function main() {
  console.log(`Fetching pending batches from ${server}...`);
  const listResp = await fetch(`${server}/api/batches`);
  if (!listResp.ok) throw new Error(`HTTP ${listResp.status}`);
  const { batches } = (await listResp.json()) as { batches: BatchSummary[] };
  const pending = batches.filter((b) => !b.hasLlmResult).slice(0, count);
  console.log(`Found ${pending.length} pending batches (preparing requests...)`);

  // Stream JSONL to disk as each request is prepared — avoids keeping all
  // ~1-2MB request bodies in memory (a full-library run is ~7 GB).
  // Write order is the order of completion; sidecar records the matching
  // batchId sequence so result ingestion can map output lines → batch IDs.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const tmpDir = mkdtempSync(join(tmpdir(), "immich-cull-batch-"));
  const localJsonl = join(tmpDir, `input-${timestamp}.jsonl`);
  const stream = createWriteStream(localJsonl);
  const orderedBatchIds: string[] = [];
  let prepped = 0;
  let failedPrep = 0;

  await mapWithConcurrency(pending, concurrent, async (batch) => {
    try {
      const resp = await fetch(`${server}/api/batches/${batch.id}/llm-request`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const { contents, generationConfig } = (await resp.json()) as {
        contents: unknown[];
        generationConfig: unknown;
      };
      const line = JSON.stringify({ request: { contents, generationConfig } }) + "\n";
      // stream.write is serialized by the event loop — pushing to orderedBatchIds
      // immediately before the write call keeps them in lockstep.
      orderedBatchIds.push(batch.id);
      await new Promise<void>((resolve, reject) => {
        stream.write(line, (err) => (err ? reject(err) : resolve()));
      });
      prepped++;
    } catch (err) {
      failedPrep++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`\n  prep failed for ${batch.id}: ${msg}`);
    }
    process.stdout.write(`\r  prepped ${prepped}/${pending.length} (fail=${failedPrep})`);
  });
  process.stdout.write("\n");
  await new Promise<void>((resolve) => stream.end(() => resolve()));

  const stats = execSync(`wc -c < ${localJsonl}`).toString().trim();
  console.log(`Wrote ${localJsonl} (${(Number(stats) / 1e6).toFixed(1)} MB)`);

  // Upload to GCS
  const gcsInput = `${bucket}/input-${timestamp}.jsonl`;
  const gcsOutputPrefix = `${bucket}/output-${timestamp}/`;
  console.log(`Uploading to ${gcsInput}...`);
  execSync(`gcloud storage cp ${localJsonl} ${gcsInput}`, { stdio: "inherit" });

  // Submit batch job
  console.log(`Creating batch prediction job (model=${model}, location=${location})...`);
  const ai = new GoogleGenAI({ vertexai: true, project, location });
  const job = await ai.batches.create({
    model,
    src: gcsInput,
    config: {
      dest: gcsOutputPrefix,
      displayName: `immich-cull-${timestamp}`,
    },
  });

  // Write sidecar
  const sidecarPath = `/tmp/batch-job-${timestamp}.json`;
  const sidecar = {
    jobName: job.name,
    model,
    project,
    location,
    gcsInput,
    gcsOutputPrefix,
    batchIds: orderedBatchIds,
    submittedAt: new Date().toISOString(),
    lineCount: orderedBatchIds.length,
  };
  writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));

  console.log("");
  console.log(`=== Job Submitted ===`);
  console.log(`Job name: ${job.name}`);
  console.log(`State:    ${job.state}`);
  console.log(`Sidecar:  ${sidecarPath}`);
  console.log("");
  console.log(`Check status and ingest results when done:`);
  console.log(`  npm run rank:batch:status -- --sidecar ${sidecarPath}`);
}

await main();
