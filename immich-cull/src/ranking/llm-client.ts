/**
 * LLM client for photo ranking via OpenRouter (Gemini models).
 *
 * Uses OpenRouter's OpenAI-compatible API to access Gemini Flash Lite.
 * Images are sent as base64-encoded data URLs.
 */
import { readFileSync } from "fs";
import { SYSTEM_PROMPT, buildPrompt } from "./prompt.js";
import { DayBatchResponse } from "./types.js";
import { SessionBatch } from "../batching/session-batcher.js";
import sharp from "sharp";

export interface LlmClientConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  previewMaxPx: number;
}

export const DEFAULT_LLM_CONFIG: LlmClientConfig = {
  apiKey: "",
  model: "google/gemini-2.5-flash-lite",
  baseUrl: "https://openrouter.ai/api/v1",
  previewMaxPx: 800, // smaller than review UI since we're optimizing for token count
};

export class LlmClient {
  private config: LlmClientConfig;

  constructor(config: Partial<LlmClientConfig> & { apiKey: string }) {
    this.config = { ...DEFAULT_LLM_CONFIG, ...config };
  }

  /**
   * Rank a day-batch of photos.
   * Resizes images, sends to LLM, parses response.
   */
  async rankBatch(
    batch: SessionBatch,
    resolveFilePath: (asset: { path: string }) => string | null,
    onProgress?: (status: string) => void
  ): Promise<{ response: DayBatchResponse; rawJson: string; inputTokens: number; outputTokens: number }> {
    onProgress?.(`Preparing ${batch.assets.length} images...`);

    // Build image content parts
    const imageParts: Array<{ type: "image_url"; image_url: { url: string } }> = [];

    for (const asset of batch.assets) {
      const fp = resolveFilePath(asset);
      if (!fp) {
        // Use a placeholder for missing files
        imageParts.push({
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" }, // tiny placeholder
        });
        continue;
      }

      const buf = await sharp(fp)
        .rotate()
        .resize(this.config.previewMaxPx, this.config.previewMaxPx, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 75 })
        .toBuffer();

      imageParts.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}` },
      });
    }

    onProgress?.(`Sending to ${this.config.model}...`);

    const userPrompt = buildPrompt(batch);

    const body = {
      model: this.config.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: userPrompt },
            ...imageParts,
          ],
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 16000,
      temperature: 0.2,
    };

    const resp = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`LLM API error ${resp.status}: ${err.slice(0, 500)}`);
    }

    const result = await resp.json() as any;

    const rawJson = result.choices?.[0]?.message?.content ?? "";
    const inputTokens = result.usage?.prompt_tokens ?? 0;
    const outputTokens = result.usage?.completion_tokens ?? 0;

    onProgress?.(`Parsing response (${inputTokens} in, ${outputTokens} out)...`);

    // Parse the JSON response
    let parsed: DayBatchResponse;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      // Try to extract JSON from markdown code blocks
      const match = rawJson.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        parsed = JSON.parse(match[1]);
      } else {
        throw new Error(`Failed to parse LLM response as JSON: ${rawJson.slice(0, 200)}`);
      }
    }

    // Validate basic structure
    if (!parsed.images || !Array.isArray(parsed.images)) {
      throw new Error(`LLM response missing 'images' array`);
    }
    if (parsed.images.length !== batch.assets.length) {
      console.warn(`LLM returned ${parsed.images.length} images, expected ${batch.assets.length}`);
    }

    return { response: parsed, rawJson, inputTokens, outputTokens };
  }
}
