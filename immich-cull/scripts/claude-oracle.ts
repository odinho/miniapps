#!/usr/bin/env npx tsx
/**
 * Claude Oracle: Calibration tool comparing Claude's photo culling against
 * Gemini model results and user decisions.
 *
 * Uses `claude -p` CLI (Claude Code) to evaluate batches. Picks batches
 * with 2+ model runs AND user decisions for maximum comparison value.
 *
 * Usage:
 *   npx tsx scripts/claude-oracle.ts [--batches 5] [--server URL]
 *
 * Prerequisites:
 *   - immich-cull server running (default localhost:3737)
 *   - claude CLI installed and authenticated
 */

import { execSync } from "child_process";
import Database from "better-sqlite3";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const maxBatches = parseInt(getArg("--batches", "5"), 10);
const server = getArg("--server", "http://localhost:3737").replace(/\/$/, "");

// The same system prompt used by all models
const SYSTEM_PROMPT = `You review a batch of personal/family photos from a single session.

PRIORITY:
These are family memory photos. Judge people first — faces, expressions, interaction, children.
Background scenery is secondary unless no people are visible.

TASKS:
1. Assess EVERY photo — star rating + category + brief note + keep/cull.
2. Find similarity subgroups and rank within each.

STARS (0-5): 0=filler, 1=good, 2=strong, 3=excellent, 4=exceptional, 5=gallery-worthy. Most 0-1.
KEEP vs CULL: Keep 50-60%. When in doubt, keep.
Subgroups: Keep 1-2 per group. Keep second if different expression/action/framing.

OUTPUT — compact JSON:
{"sum":"summary","img":[[i,stars,"cat","note","sgId"|null,"k"|"c"],...],"sg":[{"id":"g1","type":"burst|dup|scene|subj","all":[best,...worst],"keep":[kept],"why":"reason"}]}
Categories: por grp sel lan tra evt pet act doc rec wb ss snap tech veh food meme oth`;

interface BatchDetail {
  id: string;
  assets: Array<{ id: string; filename: string }>;
}

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function main() {
  console.log("=== Claude Oracle ===\n");

  // Load user decisions
  const db = new Database(join(__dirname, "..", "data", "state.db"), { readonly: true });
  const userDecisions = new Map<string, string>();
  for (const row of db
    .prepare("SELECT asset_id, state FROM photo_decisions WHERE state IS NOT NULL")
    .all() as any[]) {
    userDecisions.set(row.asset_id, row.state);
  }
  db.close();
  console.log(`User decisions: ${userDecisions.size}`);

  // Find batches with 2+ model runs and user decisions
  const { batches } = (await fetchJson(`${server}/api/batches`)) as {
    batches: Array<{
      id: string;
      count: number;
      hasLlmResult: boolean;
      viewStatus: string | null;
      agreement: { modelCount: number; tier: string } | null;
    }>;
  };

  const candidates: string[] = [];
  for (const b of batches) {
    if (!b.agreement || b.agreement.modelCount < 2) continue;
    // Check for user decisions
    const detail: BatchDetail = await fetchJson(`${server}/api/batches/${b.id}`);
    const nDecided = detail.assets.filter((a) => userDecisions.has(a.id)).length;
    if (nDecided >= 5) {
      candidates.push(b.id);
      if (candidates.length >= maxBatches) break;
    }
  }

  console.log(`Selected ${candidates.length} batches with 2+ models + user decisions\n`);

  const tmpDir = mkdtempSync(join(tmpdir(), "claude-oracle-"));
  let totalAgree = 0,
    totalWC = 0,
    totalWK = 0,
    totalN = 0;

  for (const batchId of candidates) {
    console.log(`--- Batch: ${batchId} ---`);
    const detail: BatchDetail = await fetchJson(`${server}/api/batches/${batchId}`);
    const n = detail.assets.length;

    // Download images to temp dir
    const batchDir = join(tmpDir, batchId);
    execSync(`mkdir -p ${batchDir}`);
    const imagePaths: string[] = [];
    for (let i = 0; i < n; i++) {
      const asset = detail.assets[i];
      const imgPath = join(batchDir, `${String(i).padStart(2, "0")}_${asset.filename}`);
      try {
        const resp = await fetch(
          `${server}/api/preview?id=${encodeURIComponent(asset.id)}&w=1200`,
          { signal: AbortSignal.timeout(15000) },
        );
        const buf = Buffer.from(await resp.arrayBuffer());
        writeFileSync(imgPath, buf);
        imagePaths.push(imgPath);
      } catch {
        console.log(`  WARNING: Could not fetch image ${i}`);
        imagePaths.push("");
      }
    }

    // Build prompt
    const meta = detail.assets.map((a, i) => ({ i, f: a.filename }));
    const userPrompt = `${SYSTEM_PROMPT}\n\nSession batch with ${n} images, indices 0-${n - 1}. Return EXACTLY ${n} entries in img.\n\nImages:\n${JSON.stringify(meta)}\n\nReview the attached ${n} images and return JSON.`;

    const promptPath = join(batchDir, "prompt.txt");
    writeFileSync(promptPath, userPrompt);

    // Build the claude command with image arguments
    const imageArgs = imagePaths
      .filter((p) => p)
      .map((p) => `"${p}"`)
      .join(" ");

    const t0 = Date.now();
    let rawOutput: string;
    try {
      rawOutput = execSync(
        `cat "${promptPath}" | claude --dangerously-skip-permissions -p ${imageArgs}`,
        {
          encoding: "utf-8",
          timeout: 300000, // 5 min
          maxBuffer: 10 * 1024 * 1024,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch (err: any) {
      console.log(`  ERROR: claude CLI failed: ${(err.message ?? "").slice(0, 100)}`);
      continue;
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

    // Parse JSON from Claude's response
    let parsed: any;
    try {
      // Try direct parse first
      parsed = JSON.parse(rawOutput.trim());
    } catch {
      // Try extracting from markdown code block
      const m = rawOutput.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (m) {
        try {
          parsed = JSON.parse(m[1]);
        } catch {
          console.log(`  PARSE ERROR (${elapsed}s): could not extract JSON`);
          console.log(`  Raw output (first 300 chars): ${rawOutput.slice(0, 300)}`);
          continue;
        }
      } else {
        console.log(`  PARSE ERROR (${elapsed}s): no JSON found`);
        console.log(`  Raw output (first 300 chars): ${rawOutput.slice(0, 300)}`);
        continue;
      }
    }

    // Evaluate
    const imgs: any[] = parsed.img ?? [];
    let agree = 0,
      wc = 0,
      wk = 0,
      tot = 0;
    for (const img of imgs) {
      if (!Array.isArray(img) || img.length < 2) continue;
      const idx = img[0];
      if (typeof idx !== "number" || idx < 0 || idx >= n) continue;
      const kc = img.length >= 6 ? img[5] : img[img.length - 1];
      const llm = kc === "k" ? "keep" : kc === "c" ? "cull" : null;
      if (!llm) continue;

      const assetId = detail.assets[idx].id;
      const user = userDecisions.get(assetId);
      if (!user) continue;

      tot++;
      if (llm === user) agree++;
      else if (llm === "cull" && user === "keep") wc++;
      else wk++;
    }

    totalAgree += agree;
    totalWC += wc;
    totalWK += wk;
    totalN += tot;

    const pct = tot > 0 ? ((agree / tot) * 100).toFixed(0) : "?";
    const wcPct = tot > 0 ? ((wc / tot) * 100).toFixed(0) : "?";
    console.log(
      `  ${pct}% agree (${agree}/${tot}), wrongCull=${wc}(${wcPct}%), wrongKeep=${wk}, ${elapsed}s`,
    );

    // Also compare against Gemini models via agreement endpoint
    try {
      const agreeData = await fetchJson(`${server}/api/batches/${batchId}/agreement`);
      if (agreeData.models) {
        console.log(`  Gemini models: ${agreeData.models.join(", ")}`);
        console.log(
          `  Gemini consensus: ${agreeData.unanimousKeep} keep, ${agreeData.unanimousCull} cull, ${agreeData.disagreements} disputed`,
        );
      }
    } catch {
      /* skip */
    }
    console.log();
  }

  // Cleanup
  rmSync(tmpDir, { recursive: true, force: true });

  // Summary
  console.log("=== CLAUDE ORACLE AGGREGATE ===");
  if (totalN > 0) {
    console.log(`  Agree: ${((totalAgree / totalN) * 100).toFixed(1)}% (${totalAgree}/${totalN})`);
    console.log(`  WrongCull: ${((totalWC / totalN) * 100).toFixed(1)}% (${totalWC})`);
    console.log(`  WrongKeep: ${((totalWK / totalN) * 100).toFixed(1)}% (${totalWK})`);
  } else {
    console.log("  No comparable results.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
