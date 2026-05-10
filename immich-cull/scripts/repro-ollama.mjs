#!/usr/bin/env node
// Minimal reproducer for the UND_ERR_HEADERS_TIMEOUT failure.
// Sends a 4-image request to gemma4:31b through Ollama.
// Usage: node repro.mjs [--mode undici-default|undici-noheaders|bun-fetch]

const MODE = process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] ?? "undici-default";
const TARGET_N = parseInt(process.argv.find((a) => a.startsWith("--n="))?.split("=")[1] ?? "4", 10);
const SERVER = "http://localhost:3737";
const OLLAMA = "http://localhost:11434";

// Same 4-photo burst group that consistently failed in the overnight run.
const ASSET_IDS = [
  // 2025-06-02-d97c0edf5b59 / g1 — 4 photos, burst
  // Fetched from /api/batches → pick first failing one
];

async function fetchGroup() {
  // Grab the batch listing, find a 4-photo burst, grab its asset IDs
  const batches = await (await fetch(`${SERVER}/api/batches`)).json();
  for (const b of batches.batches) {
    if (!b.hasLlmResult) continue;
    const det = await (await fetch(`${SERVER}/api/batches/${b.id}`)).json();
    const sgs = det.llm?.similaritySubgroups ?? [];
    for (const sg of sgs) {
      const ids = sg.imageIds ?? [];
      if (ids.length === TARGET_N && sg.subgroupType === "burst") {
        console.log(`Using group ${b.id} / ${sg.subgroupId} (${ids.length} photos, burst)`);
        return ids;
      }
    }
  }
  throw new Error("no 4-photo burst found");
}

async function getImageBase64(assetId, px = 1200) {
  const resp = await fetch(`${SERVER}/api/preview?id=${encodeURIComponent(assetId)}&w=${px}`);
  if (!resp.ok) throw new Error(`preview ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  return buf.toString("base64");
}

const BURST_PROMPT = `You are a photo quality judge. Pick the best photo(s).
Return JSON: {"best":[index],"reason":"...","ranking":[best_to_worst]}.`;

async function main() {
  console.log(`Mode: ${MODE}`);
  const ids = await fetchGroup();
  console.log(`Fetching ${ids.length} images at 1200px...`);
  const images = await Promise.all(ids.map((id) => getImageBase64(id, 1200)));
  const totalBytes = images.reduce((s, i) => s + i.length, 0);
  console.log(`Images loaded, total base64 size: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

  const body = {
    model: "gemma4:31b",
    messages: [
      { role: "system", content: BURST_PROMPT },
      { role: "user", content: `${ids.length} photos. Pick best.`, images },
    ],
    stream: true,
    format: "json",
    keep_alive: "30m",
    options: { temperature: 0, num_predict: 500, num_ctx: 32768 },
  };
  const bodyStr = JSON.stringify(body);
  console.log(`Request body: ${(bodyStr.length / 1024 / 1024).toFixed(2)} MB`);

  const t0 = Date.now();

  let fetchFn = fetch;
  const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: bodyStr };

  if (MODE === "undici-noheaders") {
    const { Agent, fetch: undiciFetch } = await import("undici");
    const agent = new Agent({
      headersTimeout: 0, // disable 300s headers timeout
      bodyTimeout: 0, // disable body idle timeout
      connectTimeout: 30000,
    });
    fetchFn = undiciFetch;
    init.dispatcher = agent;
    console.log("Using undici with headersTimeout=0, bodyTimeout=0");
  } else if (MODE === "undici-default") {
    console.log("Using default Node fetch (undici with 300s headersTimeout)");
  }

  try {
    const resp = await fetchFn(`${OLLAMA}/api/chat`, init);
    const t1 = Date.now();
    console.log(`Headers received at ${((t1 - t0) / 1000).toFixed(1)}s — status ${resp.status}`);

    if (!resp.ok || !resp.body) {
      console.log("ERROR BODY:", await resp.text());
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";
    let chunkCount = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunkCount++;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const j = JSON.parse(line);
        if (j.message?.content) content += j.message.content;
        if (j.done) {
          const t2 = Date.now();
          console.log(`DONE at ${((t2 - t0) / 1000).toFixed(1)}s, chunks=${chunkCount}, tokens=${j.eval_count}`);
          console.log("CONTENT:", content.slice(0, 200));
          return;
        }
      }
    }
    console.log("Stream ended without 'done' chunk");
  } catch (err) {
    const t1 = Date.now();
    console.log(`FAILED at ${((t1 - t0) / 1000).toFixed(1)}s`);
    console.log("Error:", err.message);
    console.log("Cause:", err.cause?.code ?? err.cause?.message ?? err.cause);
    console.log("Stack:", err.stack?.split("\n").slice(0, 5).join("\n"));
  }
}

main();
