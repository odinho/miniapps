#!/usr/bin/env tsx
/**
 * Rank many batches via the running immich-cull server, with bounded concurrency.
 *
 * Usage: npx tsx src/cli/rank-many.ts [--count N] [--concurrent N] [--server URL]
 *
 * Defaults: 256 batches, 5 concurrent, http://localhost:3737
 *
 * The server handles image fetching, LLM calls, and caching — this tool just
 * POSTs to /api/batches/:id/rank with concurrency control, progress, and
 * one-shot retry on empty Gemini responses.
 */
import { mapWithConcurrency } from "./concurrency.js";

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const count = Number.parseInt(getArg("--count", "256"), 10);
const concurrent = Number.parseInt(getArg("--concurrent", "5"), 10);
const server = getArg("--server", "http://localhost:3737").replace(/\/$/, "");

interface BatchSummary {
  id: string;
  hasLlmResult: boolean;
}

interface RankResponse {
  cached?: boolean;
  error?: string;
  response?: { images?: unknown[] };
}

async function rankOne(batchId: string): Promise<RankResponse> {
  const resp = await fetch(`${server}/api/batches/${batchId}/rank`, { method: "POST" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as RankResponse;
}

async function rankWithRetry(batchId: string): Promise<RankResponse> {
  const first = await rankOne(batchId);
  // Retry once on empty response (transient Gemini issue)
  const imagesLen = first.response?.images?.length ?? 0;
  if (!first.error && imagesLen === 0) {
    await new Promise((r) => setTimeout(r, 1000));
    return rankOne(batchId);
  }
  return first;
}

async function main() {
  console.log(`Fetching batches from ${server}...`);
  const resp = await fetch(`${server}/api/batches`);
  if (!resp.ok) {
    console.error(`Failed to fetch batches: HTTP ${resp.status}`);
    process.exit(1);
  }
  const data = (await resp.json()) as { batches: BatchSummary[] };
  const pending = data.batches.filter((b) => !b.hasLlmResult).slice(0, count);
  console.log(
    `Found ${data.batches.length} total batches, ${data.batches.filter((b) => !b.hasLlmResult).length} without LLM results`,
  );
  console.log(`Running LLM on ${pending.length} batches (concurrent=${concurrent})...`);

  let done = 0;
  let ok = 0;
  let fail = 0;
  const start = Date.now();

  const results = await mapWithConcurrency(pending, concurrent, async (batch) => {
    try {
      const r = await rankWithRetry(batch.id);
      if (r.error) throw new Error(r.error);
      const imagesLen = r.response?.images?.length ?? 0;
      if (imagesLen === 0) throw new Error("empty LLM response");
      ok++;
      return r;
    } catch (err) {
      fail++;
      throw err;
    } finally {
      done++;
      const elapsed = (Date.now() - start) / 1000;
      const avg = elapsed / done;
      process.stdout.write(
        `\r[${done}/${pending.length}] ok=${ok} fail=${fail} avg=${avg.toFixed(1)}s/batch`,
      );
    }
  });

  const elapsed = (Date.now() - start) / 1000;
  process.stdout.write("\n");
  console.log("");
  console.log(`=== Complete ===`);
  console.log(`Total: ${pending.length}, Succeeded: ${ok}, Failed: ${fail}`);
  console.log(
    `Wall time: ${elapsed.toFixed(0)}s, Avg: ${(elapsed / pending.length).toFixed(1)}s/batch`,
  );

  if (fail > 0) {
    console.log("\nFailures:");
    for (const [i, r] of results.entries()) {
      if (!r.ok) {
        const msg = r.error instanceof Error ? r.error.message : String(r.error);
        console.log(`  ${pending[i].id}: ${msg}`);
      }
    }
  }
}

await main();
