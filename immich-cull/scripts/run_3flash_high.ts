import { GoogleGenAI } from "@google/genai";
import Database from "better-sqlite3";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const SERVER = "http://localhost:3737";
  const { SYSTEM_PROMPT } = await import("../src/ranking/prompt.js");

  const db = new Database(join(__dirname, "..", "data", "state.db"), { readonly: true });
  const userDecisions = new Map<string, string>();
  for (const row of db.prepare("SELECT asset_id, state FROM photo_decisions WHERE state IS NOT NULL").all() as any[]) {
    userDecisions.set(row.asset_id, row.state);
  }
  db.close();

  const batchIds = [
    "2026-01-01-4e7da09b7e60", "2026-04-02-593563f6ea4b", "2026-02-14-a7a96fd5fcfd",
    "2026-01-31-3e202cb1b758", "2025-12-21-4229a9dbeb60", "2026-03-29-3acb3f05e0e4",
    "2026-02-25-276f55082f3f", "2026-02-06-2d8ca6fb04f9", "2025-12-30-8aaa9e082e48",
    "2025-11-30-a5ffecb5c152",
  ];

  const ai = new GoogleGenAI({ vertexai: true, project: "tagrdevin", location: "global" });
  let totalAgree = 0, totalWC = 0, totalWK = 0, totalN = 0;

  for (const batchId of batchIds) {
    const batch = await (await fetch(`${SERVER}/api/batches/${batchId}`, { signal: AbortSignal.timeout(10000) })).json() as any;
    const assets = batch.assets;
    const n = assets.length;
    const meta = assets.map((a: any, i: number) => ({ i, f: a.filename }));
    const userPrompt = `Session batch with ${n} images, indices 0-${n - 1}. Return EXACTLY ${n} entries in img.\n\nImages:\n${JSON.stringify(meta)}\n\nReview the attached ${n} images and return JSON.`;

    const parts: any[] = [{ text: SYSTEM_PROMPT + "\n\n" + userPrompt }];
    for (let i = 0; i < n; i++) {
      const resp = await fetch(`${SERVER}/api/preview?id=${encodeURIComponent(assets[i].id)}&w=1200`, { signal: AbortSignal.timeout(15000) });
      const buf = Buffer.from(await resp.arrayBuffer());
      parts.push({ text: `--- Image ${i}: ${assets[i].filename} ---` });
      parts.push({ inlineData: { mimeType: "image/jpeg", data: buf.toString("base64") } });
    }
    parts.push({ text: "Now return your JSON assessment for all images above." });

    const t0 = Date.now();
    try {
      const result = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ role: "user", parts }],
        config: {
          temperature: 0,
          maxOutputTokens: 65000,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingLevel: "high" as any },
        },
      });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

      let parsed: any;
      try { parsed = JSON.parse(result.text ?? ""); } catch { console.log(`  ${batchId}: PARSE ERROR (${elapsed}s)`); continue; }

      const imgs: any[] = parsed.img ?? [];
      let agree = 0, wc = 0, wk = 0, tot = 0;
      for (const img of imgs) {
        if (!Array.isArray(img) || img.length < 6) continue;
        const idx = img[0];
        if (typeof idx !== "number" || idx < 0 || idx >= n) continue;
        const llm = img[5] === "k" ? "keep" : "cull";
        const user = userDecisions.get(assets[idx].id);
        if (!user) continue;
        tot++;
        if (llm === user) agree++;
        else if (llm === "cull" && user === "keep") wc++;
        else wk++;
      }
      totalAgree += agree; totalWC += wc; totalWK += wk; totalN += tot;
      console.log(`  ${batchId}: ${tot > 0 ? ((agree/tot)*100).toFixed(0) : "?"}% agree (${agree}/${tot}), wc=${wc}(${tot > 0 ? ((wc/tot)*100).toFixed(0) : "?"}%), wk=${wk}, ${elapsed}s`);
    } catch (err: any) {
      console.log(`  ${batchId}: ERROR (${((Date.now()-t0)/1000).toFixed(0)}s): ${(err.message ?? err).toString().slice(0,150)}`);
    }
  }

  console.log(`\n=== 3flash_think_high AGGREGATE ===`);
  if (totalN > 0) {
    console.log(`  Agree: ${(totalAgree/totalN*100).toFixed(1)}% (${totalAgree}/${totalN})`);
    console.log(`  WrongCull: ${(totalWC/totalN*100).toFixed(1)}% (${totalWC})`);
    console.log(`  WrongKeep: ${(totalWK/totalN*100).toFixed(1)}% (${totalWK})`);
  } else {
    console.log("  No results.");
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
