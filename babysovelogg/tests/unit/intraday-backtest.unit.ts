import { describe, expect, it } from "bun:test";
import {
  intradayBacktest,
  bucketByNapDuration,
  noAdjustment,
  napQualityAdjustment,
} from "$lib/engine/intraday-backtest.js";
import type { DayRecord } from "$lib/engine/backtest.js";

import halldisData from "../fixtures/halldis-sleep.json";

const BIRTHDATE = "2025-06-12";
const TZ = "Europe/Oslo";
const days = halldisData as DayRecord[];

function renderResult(label: string, r: ReturnType<typeof intradayBacktest>) {
  return `${label}: ${r.count} gaps, MAE ${r.mae} min, bias ${r.bias > 0 ? "+" : ""}${r.bias} min`;
}

function renderBuckets(label: string, r: ReturnType<typeof intradayBacktest>) {
  const buckets = bucketByNapDuration(r);
  return buckets
    .map((b) => `  ${label} ${b.label}: ${b.count} gaps, MAE ${b.mae} min, bias ${b.bias > 0 ? "+" : ""}${b.bias}`)
    .join("\n");
}

const noAdj = intradayBacktest(days, BIRTHDATE, noAdjustment, { tz: TZ });
const withAdj = intradayBacktest(days, BIRTHDATE, napQualityAdjustment, { tz: TZ });

describe("intraday backtest", () => {
  it("has enough data points", () => {
    expect(noAdj.count).toBeGreaterThan(20);
  });

  it("no-adjustment vs nap-quality-adjustment — overall", () => {
    const lines = [
      renderResult("no-adjustment", noAdj),
      renderResult("nap-quality-adj", withAdj),
    ];
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "no-adjustment: 67 gaps, MAE 30.4 min, bias -6 min
      nap-quality-adj: 67 gaps, MAE 30.9 min, bias -10.1 min"
    `);
  });

  it("breakdown by previous nap duration", () => {
    const lines = [
      renderBuckets("no-adj", noAdj),
      renderBuckets("adj", withAdj),
    ];
    expect(lines.join("\n\n")).toMatchInlineSnapshot(`
      "  no-adj short (≤30m): 13 gaps, MAE 51.8 min, bias +13.2
        no-adj normal (31-89m): 47 gaps, MAE 23.3 min, bias -9.7
        no-adj long (≥90m): 7 gaps, MAE 38 min, bias -16.6

        adj short (≤30m): 13 gaps, MAE 52.8 min, bias -16.2
        adj normal (31-89m): 47 gaps, MAE 23.3 min, bias -9.7
        adj long (≥90m): 7 gaps, MAE 41 min, bias -1.6"
    `);
  });
});

// ─── Data analysis: what actually happens after short naps? ──────────────────

describe("raw data: actual gaps after short vs normal naps", () => {
  it("shows the actual pattern", () => {
    const shortNapGaps = noAdj.predictions
      .filter((p) => p.prevNapDuration <= 30)
      .map((p) => `${p.date}: ${p.prevNapDuration}min nap → ${p.actualGap}min gap (predicted ${p.predictedGap})`);

    const longNapGaps = noAdj.predictions
      .filter((p) => p.prevNapDuration >= 90)
      .map((p) => `${p.date}: ${p.prevNapDuration}min nap → ${p.actualGap}min gap (predicted ${p.predictedGap})`);

    // Just document the raw data — this is for human inspection
    expect(shortNapGaps.length).toBeGreaterThan(0);
    expect(longNapGaps.length).toBeGreaterThan(0);
  });
});
