#!/usr/bin/env npx tsx
/**
 * Burst Discriminator Experiment
 *
 * Tests how well different models pick the "best" photo from a burst group.
 * Sends only the burst photos (not the full batch) with a focused prompt:
 * "Which photo is the best? Consider sharpness, expression, composition."
 *
 * Compares model picks against:
 *   1. User decisions (ground truth where available)
 *   2. The production LLM's subgroup ranking (baseline)
 *
 * Models tested:
 *   - gemma4:e4b (local, already installed)
 *   - gemini-2.5-flash-lite (cheapest cloud)
 *   - gemini-3.1-flash-lite-preview (current default)
 *   - gemini-3-flash-preview (most capable)
 *
 * Usage:
 *   npx tsx scripts/burst_discriminator_experiment.ts [--groups 12] [--server URL]
 */

import { GoogleGenAI } from "@google/genai";
import Database from "better-sqlite3";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { writeFileSync } from "fs";
import { Agent, setGlobalDispatcher } from "undici";

// Disable undici's default 300s headers timeout — slow CPU-bound Ollama generations
// routinely take longer to emit first bytes (vision preprocessing + prompt eval).
setGlobalDispatcher(
  new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30000 }),
);

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const maxGroups = parseInt(getArg("--groups", "12"), 10);
const server = getArg("--server", "http://localhost:3737").replace(/\/$/, "");
const OLLAMA_URL = getArg("--ollama", "http://localhost:11434");
const skipOllama = args.includes("--skip-ollama");
const skipGemini = args.includes("--skip-gemini");
const onlyList = getArg("--only", ""); // comma-separated variant names to keep
const previewPx = parseInt(getArg("--preview", "1200"), 10);

// ---------------------------------------------------------------------------
// Focused burst-picking prompt
// ---------------------------------------------------------------------------

const BURST_PROMPT = `You are a photo quality judge. You will see a set of very similar photos from a burst or near-duplicate group.

Pick the BEST photo(s) to keep. Consider:
1. **Sharpness/focus** — is the main subject in focus?
2. **Expression** — if people are visible, who has the best expression?
3. **Composition** — framing, balance, no awkward crops
4. **Exposure** — well-lit, not over/underexposed
5. **Moment** — captures the peak action or best instant

These are family/personal photos. People and faces matter most.

Return JSON:
{"best": [index], "reason": "why this one wins", "ranking": [best_to_worst_indices]}

If 2 photos are worth keeping (genuinely different moment/expression), return up to 2 in "best".
Indices are 0-based matching the image order shown.`;

// Terser prompt variant — tests whether less framing helps or hurts accuracy
const BURST_PROMPT_TERSE = `Pick the best family photo(s) from this burst. Faces/expressions matter most, then sharpness, composition, moment.

Return JSON only:
{"best": [index_or_indices], "reason": "brief why", "ranking": [best_to_worst]}

Indices 0-based. Keep 1 unless two frames capture distinctly different moments.`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SubgroupInfo {
  batchId: string;
  subgroupId: string;
  type: string;
  assetIds: string[];
  filenames: string[];
  llmKeepIds: string[];
  llmRanking: string[]; // quality order from LLM
  userKeepIds: string[];
  userCullIds: string[];
}

interface Variant {
  name: string;
  provider: "ollama" | "vertexai";
  model: string;
  temperature: number;
  thinkingLevel?: string;
  think?: boolean; // ollama: enable/disable thinking for models that support it
  numPredict?: number;
  promptOverride?: string;
}

interface VariantResult {
  variant: string;
  bestPicks: number[]; // indices chosen as best
  ranking: number[];
  reason: string;
  elapsed: number;
  matchesUser: boolean | null;
  matchesLlm: boolean;
  tokensIn: number;
  tokensOut: number;
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
// Variants
// ---------------------------------------------------------------------------

const VARIANTS: Variant[] = [];

if (!skipOllama) {
  VARIANTS.push({
    name: "gemma4_e4b",
    provider: "ollama",
    model: "gemma4:e4b",
    temperature: 0,
  });
  VARIANTS.push({
    name: "gemma4_31b",
    provider: "ollama",
    model: "gemma4:31b",
    temperature: 0,
  });
  VARIANTS.push({
    name: "qwen36_a3b_nothink",
    provider: "ollama",
    model: "qwen3.6:35b-a3b",
    temperature: 0,
    think: false,
  });
  VARIANTS.push({
    name: "qwen36_a3b_think",
    provider: "ollama",
    model: "qwen3.6:35b-a3b",
    temperature: 0,
    think: true,
    numPredict: 4000,
  });
  VARIANTS.push({
    name: "qwen36_a3b_terse",
    provider: "ollama",
    model: "qwen3.6:35b-a3b",
    temperature: 0,
    think: false,
    promptOverride: BURST_PROMPT_TERSE,
  });
}

if (!skipGemini) {
  VARIANTS.push(
    {
      name: "31flashlite",
      provider: "vertexai",
      model: "gemini-3.1-flash-lite-preview",
      temperature: 0,
    },
  );
}

// Apply --only filter if specified
if (onlyList) {
  const keep = new Set(onlyList.split(",").map((s) => s.trim()));
  for (let i = VARIANTS.length - 1; i >= 0; i--) {
    if (!keep.has(VARIANTS[i].name)) VARIANTS.splice(i, 1);
  }
}

// ---------------------------------------------------------------------------
// Model runners
// ---------------------------------------------------------------------------

async function runOllama(
  variant: Variant,
  filenames: string[],
  imagesB64: string[],
): Promise<{ raw: string; tokensIn: number; tokensOut: number }> {
  const userPrompt = `${filenames.length} photos from a burst. Pick the best.\n\n` +
    filenames.map((f, i) => `Image ${i}: ${f}`).join("\n");

  const sys = variant.promptOverride ?? BURST_PROMPT;
  const body: any = {
    model: variant.model,
    messages: [
      { role: "system", content: sys },
      {
        role: "user",
        content: userPrompt,
        images: imagesB64,
      },
    ],
    stream: true, // avoid undici's 300s headersTimeout on slow CPU-bound generations
    format: "json",
    keep_alive: "30m",
    options: {
      temperature: variant.temperature,
      num_predict: variant.numPredict ?? 2000,
      num_ctx: 32768,
    },
  };
  if (variant.think !== undefined) {
    body.think = variant.think;
  }

  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1800000),
  });

  if (!resp.ok || !resp.body) {
    const err = resp.body ? await resp.text() : "no body";
    throw new Error(`Ollama error ${resp.status}: ${err.slice(0, 200)}`);
  }

  // Concatenate streamed NDJSON chunks
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let promptEvalCount = 0;
  let evalCount = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        if (j.message?.content) content += j.message.content;
        if (j.done) {
          promptEvalCount = j.prompt_eval_count ?? promptEvalCount;
          evalCount = j.eval_count ?? evalCount;
        }
      } catch {
        // ignore parse errors on partial lines
      }
    }
  }
  return { raw: content, tokensIn: promptEvalCount, tokensOut: evalCount };
}

async function runGemini(
  variant: Variant,
  filenames: string[],
  imagesB64: string[],
): Promise<{ raw: string; tokensIn: number; tokensOut: number }> {
  const needsGlobal = /gemini-[3-9]/.test(variant.model);
  const ai = new GoogleGenAI({
    vertexai: true,
    project: "tagrdevin",
    location: needsGlobal ? "global" : "europe-west1",
  });

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: BURST_PROMPT + "\n\n" + filenames.length + " photos from a burst. Pick the best.\n" },
  ];
  for (let i = 0; i < imagesB64.length; i++) {
    parts.push({ text: `--- Image ${i}: ${filenames[i]} ---` });
    parts.push({ inlineData: { mimeType: "image/jpeg", data: imagesB64[i] } });
  }
  parts.push({ text: "Return your JSON verdict." });

  const config: any = {
    temperature: variant.temperature,
    maxOutputTokens: 2000,
    responseMimeType: "application/json",
  };

  if (variant.thinkingLevel) {
    config.thinkingConfig = { thinkingLevel: variant.thinkingLevel };
  }

  const result = await ai.models.generateContent({
    model: variant.model,
    contents: [{ role: "user", parts }],
    config,
  });

  return {
    raw: result.text ?? "",
    tokensIn: result.usageMetadata?.promptTokenCount ?? 0,
    tokensOut: result.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Find diverse burst groups with user decisions
// ---------------------------------------------------------------------------

async function findBurstGroups(
  userDecisions: Map<string, string>,
): Promise<SubgroupInfo[]> {
  console.log("Finding burst groups with user decisions...\n");
  const resp = await fetchJson(`${server}/api/batches`);
  const allBatches: Array<{ id: string; hasLlmResult: boolean; count: number }> = resp.batches;

  const groups: SubgroupInfo[] = [];

  for (const b of allBatches) {
    if (!b.hasLlmResult) continue;
    if (groups.length >= maxGroups * 3) break; // collect extras for diversity filtering

    const detail = await fetchJson(`${server}/api/batches/${b.id}`);
    if (!detail.llm) continue;

    for (const sg of detail.llm.similaritySubgroups) {
      if (sg.subgroupType !== "burst" && sg.subgroupType !== "near_duplicate") continue;
      if (sg.imageIds.length < 3) continue; // need 3+ for meaningful comparison

      // Check user decisions
      const userKeep: string[] = [];
      const userCull: string[] = [];
      for (const id of sg.imageIds) {
        const d = userDecisions.get(id);
        if (d === "keep") userKeep.push(id);
        else if (d === "cull") userCull.push(id);
      }

      // Need at least some user decisions for ground truth
      if (userKeep.length + userCull.length < sg.imageIds.length * 0.5) continue;

      const assetMap = new Map(detail.assets.map((a: any) => [a.id, a]));
      groups.push({
        batchId: b.id,
        subgroupId: sg.subgroupId,
        type: sg.subgroupType,
        assetIds: sg.imageIds,
        filenames: sg.imageIds.map((id: string) => assetMap.get(id)?.filename ?? id.slice(0, 8)),
        llmKeepIds: sg.recommendedKeepIds,
        llmRanking: sg.imageIds, // already quality-ordered
        userKeepIds: userKeep,
        userCullIds: userCull,
      });
    }
  }

  // Diverse selection: vary group sizes
  const bySize = new Map<number, SubgroupInfo[]>();
  for (const g of groups) {
    const s = Math.min(g.assetIds.length, 10);
    if (!bySize.has(s)) bySize.set(s, []);
    bySize.get(s)!.push(g);
  }

  const selected: SubgroupInfo[] = [];
  const sizes = [...bySize.keys()].sort((a, b) => a - b);
  while (selected.length < maxGroups) {
    let added = false;
    for (const s of sizes) {
      const arr = bySize.get(s)!;
      if (arr.length > 0 && selected.length < maxGroups) {
        selected.push(arr.shift()!);
        added = true;
      }
    }
    if (!added) break;
  }

  console.log(`Found ${groups.length} burst groups total, selected ${selected.length}:`);
  for (const g of selected) {
    console.log(`  ${g.batchId} ${g.subgroupId}: ${g.assetIds.length} photos (${g.type}), user: ${g.userKeepIds.length}k/${g.userCullIds.length}c`);
  }
  console.log();

  return selected;
}

// ---------------------------------------------------------------------------
// Run experiment
// ---------------------------------------------------------------------------

function parseResponse(raw: string, n: number): { best: number[]; ranking: number[]; reason: string } {
  // Strip any <think>...</think> blocks (qwen thinking models leak these)
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  let parsed: any;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const m = stripped.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) {
      parsed = JSON.parse(m[1]);
    } else {
      // Last resort: find first {...} JSON object
      const obj = stripped.match(/\{[\s\S]*\}/);
      if (obj) parsed = JSON.parse(obj[0]);
      else throw new Error("JSON parse failed");
    }
  }

  const best = Array.isArray(parsed.best) ? parsed.best.filter((i: any) => typeof i === "number" && i >= 0 && i < n) : [];
  const ranking = Array.isArray(parsed.ranking) ? parsed.ranking.filter((i: any) => typeof i === "number" && i >= 0 && i < n) : [];
  const reason = parsed.reason ?? "";

  return { best, ranking, reason };
}

async function main() {
  console.log("=== Burst Discriminator Experiment ===");
  console.log(`Variants: ${VARIANTS.map((v) => v.name).join(", ")}`);
  console.log(`Target groups: ${maxGroups}\n`);

  // Load user decisions
  const db = new Database(join(__dirname, "..", "data", "state.db"), { readonly: true });
  const userDecisions = new Map<string, string>();
  for (const row of db
    .prepare("SELECT asset_id, state FROM photo_decisions WHERE source = 'manual' AND state IS NOT NULL")
    .all() as any[]) {
    userDecisions.set(row.asset_id, row.state);
  }
  db.close();
  console.log(`User decisions: ${userDecisions.size}\n`);

  const groups = await findBurstGroups(userDecisions);
  if (!groups.length) {
    console.log("No suitable burst groups found.");
    return;
  }

  // Aggregate stats per variant
  const stats: Record<string, { matchUser: number; matchLlm: number; total: number; totalElapsed: number }> = {};
  for (const v of VARIANTS) {
    stats[v.name] = { matchUser: 0, matchLlm: 0, total: 0, totalElapsed: 0 };
  }

  const allResults: Array<{ group: SubgroupInfo; variants: VariantResult[] }> = [];

  for (const group of groups) {
    console.log(`--- ${group.batchId} / ${group.subgroupId}: ${group.assetIds.length} photos (${group.type}) ---`);
    console.log(`  LLM keeps: ${group.llmKeepIds.map((id) => group.assetIds.indexOf(id)).join(",")}`);
    console.log(`  User keeps: ${group.userKeepIds.map((id) => group.assetIds.indexOf(id)).join(",")}`);

    // Fetch images
    const imagesB64: string[] = [];
    for (const id of group.assetIds) {
      try {
        imagesB64.push(await getImageBase64(id, previewPx));
      } catch {
        imagesB64.push("");
      }
    }

    const variantResults: VariantResult[] = [];

    for (const variant of VARIANTS) {
      const t0 = Date.now();
      let raw: string;
      let tokensIn = 0;
      let tokensOut = 0;

      try {
        if (variant.provider === "ollama") {
          const r = await runOllama(variant, group.filenames, imagesB64);
          raw = r.raw;
          tokensIn = r.tokensIn;
          tokensOut = r.tokensOut;
        } else {
          const r = await runGemini(variant, group.filenames, imagesB64);
          raw = r.raw;
          tokensIn = r.tokensIn;
          tokensOut = r.tokensOut;
        }
      } catch (err: any) {
        console.log(`  ${variant.name}: ERROR — ${(err.message ?? "").slice(0, 100)}`);
        variantResults.push({
          variant: variant.name,
          bestPicks: [],
          ranking: [],
          reason: `ERROR: ${(err.message ?? "").slice(0, 100)}`,
          elapsed: (Date.now() - t0) / 1000,
          matchesUser: null,
          matchesLlm: false,
          tokensIn: 0,
          tokensOut: 0,
        });
        continue;
      }

      const elapsed = (Date.now() - t0) / 1000;

      let best: number[] = [];
      let ranking: number[] = [];
      let reason = "";
      try {
        const p = parseResponse(raw, group.assetIds.length);
        best = p.best;
        ranking = p.ranking;
        reason = p.reason;
      } catch {
        console.log(`  ${variant.name}: PARSE ERROR (${elapsed.toFixed(1)}s)`);
        variantResults.push({
          variant: variant.name,
          bestPicks: [],
          ranking: [],
          reason: `PARSE ERROR: ${raw.slice(0, 100)}`,
          elapsed,
          matchesUser: null,
          matchesLlm: false,
          tokensIn,
          tokensOut,
        });
        continue;
      }

      // Compare: does the model's best pick match user's keep?
      const pickedIds = best.map((i) => group.assetIds[i]);
      const matchesUser = group.userKeepIds.length > 0
        ? pickedIds.some((id) => group.userKeepIds.includes(id))
        : null;

      // Compare: does the model's best pick match production LLM's keep?
      const matchesLlm = pickedIds.some((id) => group.llmKeepIds.includes(id));

      if (matchesUser !== null) stats[variant.name].total++;
      if (matchesUser) stats[variant.name].matchUser++;
      if (matchesLlm) stats[variant.name].matchLlm++;
      stats[variant.name].totalElapsed += elapsed;

      const userMark = matchesUser === true ? "✓" : matchesUser === false ? "✗" : "?";
      const llmMark = matchesLlm ? "=LLM" : "≠LLM";
      console.log(`  ${variant.name}: pick=${best.join(",")} ${userMark} ${llmMark} (${elapsed.toFixed(1)}s) — ${reason.slice(0, 60)}`);

      variantResults.push({
        variant: variant.name,
        bestPicks: best,
        ranking,
        reason,
        elapsed,
        matchesUser,
        matchesLlm,
        tokensIn,
        tokensOut,
      });
    }

    allResults.push({ group, variants: variantResults });
    console.log();

    // Write intermediate snapshot after each group so we don't lose data on crash
    const snapshotPath = `/tmp/burst-discriminator-snapshot.json`;
    writeFileSync(snapshotPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      completedGroups: allResults.length,
      targetGroups: groups.length,
      variants: VARIANTS.map((v) => v.name),
      stats,
      results: allResults,
    }, null, 2));
  }

  // ---------------------------------------------------------------------------
  // Aggregate
  // ---------------------------------------------------------------------------

  console.log("=== AGGREGATE RESULTS ===\n");
  console.log("Variant             | User Match | LLM Match | Avg Time");
  console.log("-".repeat(60));
  for (const v of VARIANTS) {
    const s = stats[v.name];
    const userPct = s.total > 0 ? `${((s.matchUser / s.total) * 100).toFixed(0)}% (${s.matchUser}/${s.total})` : "n/a";
    const llmPct = s.total > 0 ? `${((s.matchLlm / s.total) * 100).toFixed(0)}%` : "n/a";
    const avg = s.total > 0 ? `${(s.totalElapsed / s.total).toFixed(1)}s` : "n/a";
    console.log(`${v.name.padEnd(20)}| ${userPct.padEnd(11)}| ${llmPct.padEnd(10)}| ${avg}`);
  }

  // Also show production LLM baseline
  let llmMatchUser = 0;
  let llmTotal = 0;
  for (const r of allResults) {
    if (r.group.userKeepIds.length > 0) {
      llmTotal++;
      if (r.group.llmKeepIds.some((id) => r.group.userKeepIds.includes(id))) {
        llmMatchUser++;
      }
    }
  }
  if (llmTotal > 0) {
    console.log(`${"prod-llm (baseline)".padEnd(20)}| ${((llmMatchUser / llmTotal) * 100).toFixed(0)}% (${llmMatchUser}/${llmTotal})`.padEnd(32) + `| 100%      | 0s`);
  }

  // Save results
  const outPath = `/tmp/burst-discriminator-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(outPath, JSON.stringify({ variants: VARIANTS.map((v) => v.name), stats, results: allResults }, null, 2));
  console.log(`\nRaw results saved to ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
