#!/usr/bin/env npx tsx
/**
 * Validate the production prompt change (prompt.ts line 89: "keep 1 default"
 * → "keep 2 default") on real user batches.
 *
 * Strategy:
 *   - Pick N recent batches that were ranked with the old prompt (in state.db).
 *   - Re-run ranking on each with the CURRENT prompt (which has the v2 change).
 *   - For each batch, compare: total keeps, per-subgroup keeps, picks that
 *     align with user's actual keep decisions recorded in state.db.
 *
 * Does NOT touch the DB — writes results to data/experiments/.
 *
 * Usage:
 *   npx tsx scripts/validate_prod_prompt_change.ts --n 5
 */

import Database from "better-sqlite3";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync } from "fs";
import { setGlobalDispatcher, Agent } from "undici";
import { GoogleGenAI } from "@google/genai";
import { SYSTEM_PROMPT } from "../src/ranking/prompt.js";

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const N = parseInt(getArg("--n", "5"), 10);
const server = "http://localhost:3737";

type OldLLM = {
  sum?: string;
  img?: Array<[number, number, string, string, string | null, "k" | "c"]>;
  sg?: Array<{ id: string; type: string; all: number[]; keep: number[]; why: string }>;
};

async function getImageBase64(assetId: string): Promise<string> {
  const resp = await fetch(
    `${server}/api/preview?id=${encodeURIComponent(assetId)}&size=preview`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!resp.ok) throw new Error(`preview ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer()).toString("base64");
}

async function runProdPrompt(
  assetIds: string[],
  imagesB64: string[],
  filenames: string[],
  fileCreatedAts: string[],
): Promise<{ raw: string; parsed: OldLLM }> {
  const ai = new GoogleGenAI({
    vertexai: true,
    project: "tagrdevin",
    location: "global",
  });
  const imagesMeta = assetIds.map((id, i) => ({
    i,
    f: filenames[i],
    t: fileCreatedAts[i].slice(11, 19),
  }));
  const userText = `Session: batch
${assetIds.length} images, indices 0-${assetIds.length - 1}. Return EXACTLY ${assetIds.length} entries in img.

Images:
${JSON.stringify(imagesMeta)}

Review the attached ${assetIds.length} images and return JSON.`;
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: SYSTEM_PROMPT + "\n\n" + userText },
  ];
  for (let i = 0; i < imagesB64.length; i++) {
    parts.push({ text: `--- Image ${i} ---` });
    parts.push({ inlineData: { mimeType: "image/jpeg", data: imagesB64[i] } });
  }
  const result = await ai.models.generateContent({
    model: "gemini-3.1-flash-lite-preview",
    contents: [{ role: "user", parts }],
    config: {
      temperature: 0,
      maxOutputTokens: 4000,
      responseMimeType: "application/json",
    },
  });
  const raw = result.text ?? "";
  return { raw, parsed: JSON.parse(raw) };
}

function pickedIndices(parsed: OldLLM): number[] {
  if (!parsed.img) return [];
  const picks: number[] = [];
  for (const entry of parsed.img) {
    if (entry[5] === "k") picks.push(entry[0]);
  }
  return picks.toSorted((a, b) => a - b);
}

function sgKeeps(parsed: OldLLM): Record<string, number[]> {
  if (!parsed.sg) return {};
  const m: Record<string, number[]> = {};
  for (const g of parsed.sg) m[g.id] = g.keep.toSorted((a, b) => a - b);
  return m;
}

async function main() {
  const dbPath = resolve(__dirname, "../data/state.db");
  const db = new Database(dbPath, { readonly: true });
  // Pick recent-ish completed llm_batch_runs with responses
  const rows = db
    .prepare(
      `SELECT batch_id, response_json FROM llm_batch_runs
       WHERE status='completed' AND response_json IS NOT NULL
         AND model='gemini-3.1-flash-lite-preview'
       ORDER BY random()
       LIMIT ?`,
    )
    .all(N) as Array<{ batch_id: string; response_json: string }>;
  db.close();

  console.log(`Validating against ${rows.length} real batches`);

  const results: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    console.log(`\n--- ${row.batch_id} ---`);
    const oldParsed: OldLLM = JSON.parse(row.response_json);
    const oldPicks = pickedIndices(oldParsed);

    // Fetch batch assets from server
    const batch = await (
      await fetch(`${server}/api/batches/${row.batch_id}`, {
        signal: AbortSignal.timeout(60_000),
      })
    ).json();
    const assets = batch.assets ?? [];
    if (!assets.length) {
      console.log("  no assets, skipping");
      continue;
    }
    const assetIds = assets.map((a: { id: string }) => a.id);
    const filenames = assets.map((a: { filename: string }) => a.filename);
    const datesIso = assets.map((a: { date: string }) => a.date);
    console.log(`  ${assetIds.length} images; old kept ${oldPicks.length}/${assetIds.length}`);

    const imagesB64: string[] = [];
    for (const id of assetIds) {
      try {
        imagesB64.push(await getImageBase64(id));
      } catch {
        imagesB64.push("");
      }
    }

    const t0 = Date.now();
    let newParsed: OldLLM | null = null;
    let newRaw = "";
    try {
      const r = await runProdPrompt(assetIds, imagesB64, filenames, datesIso);
      newParsed = r.parsed;
      newRaw = r.raw;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  NEW prompt ERROR: ${msg}`);
      results.push({
        batchId: row.batch_id,
        n: assetIds.length,
        oldPicks,
        newPicks: null,
        error: msg,
      });
      continue;
    }
    const elapsed = (Date.now() - t0) / 1000;

    const newPicks = pickedIndices(newParsed);
    const oldByKeep = new Set(oldPicks);
    const newByKeep = new Set(newPicks);
    const onlyOld = [...oldByKeep].filter((i) => !newByKeep.has(i));
    const onlyNew = [...newByKeep].filter((i) => !oldByKeep.has(i));

    console.log(`  OLD kept: [${[...oldByKeep].toSorted().join(",")}] (${oldPicks.length})`);
    console.log(`  NEW kept: [${[...newByKeep].toSorted().join(",")}] (${newPicks.length})`);
    console.log(`  only old: [${onlyOld.join(",")}]`);
    console.log(`  only new: [${onlyNew.join(",")}]`);
    console.log(`  elapsed: ${elapsed.toFixed(1)}s`);

    results.push({
      batchId: row.batch_id,
      n: assetIds.length,
      oldKeepCount: oldPicks.length,
      newKeepCount: newPicks.length,
      oldPicks,
      newPicks,
      onlyOld,
      onlyNew,
      oldSg: sgKeeps(oldParsed),
      newSg: sgKeeps(newParsed),
      elapsed,
      newRaw,
    });
  }

  const outPath = resolve(
    __dirname,
    "../data/experiments/2026-04-20-prod-prompt-validation.json",
  );
  writeFileSync(outPath, JSON.stringify({ count: results.length, results }, null, 2));
  console.log(`\nWrote ${outPath}`);

  // Summary
  const successful = results.filter((r) => r.newPicks !== null);
  const oldTotal = successful.reduce((s, r) => s + (r.oldKeepCount as number), 0);
  const newTotal = successful.reduce((s, r) => s + (r.newKeepCount as number), 0);
  const n = successful.reduce((s, r) => s + (r.n as number), 0);
  console.log("\n=== SUMMARY ===");
  console.log(`Batches: ${successful.length}/${rows.length}`);
  console.log(`Total photos reviewed: ${n}`);
  console.log(`Old prompt kept: ${oldTotal} (${((100 * oldTotal) / n).toFixed(1)}%)`);
  console.log(`New prompt kept: ${newTotal} (${((100 * newTotal) / n).toFixed(1)}%)`);
  console.log(`Δ: +${newTotal - oldTotal} photos (+${(((newTotal - oldTotal) / oldTotal) * 100).toFixed(1)}%)`);
}

main();
