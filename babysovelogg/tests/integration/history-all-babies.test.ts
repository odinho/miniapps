import { test, expect } from "bun:test";
import {
  get,
  createBaby,
  addCompletedSleep,
  addDiaper,
  addNightWaking,
  setupHarness,
} from "./harness.js";
setupHarness();

// The multi-baby Log view fetches with `?baby=all` and labels each row by
// baby_id. These cover the server contract: `all` returns every child's rows;
// a single baby (default / explicit) stays scoped.

test("?baby=all returns rows for every child across all three log endpoints", async () => {
  const ada = createBaby("Ada", "2025-06-12");
  const bo = createBaby("Bo", "2025-06-12");

  addCompletedSleep(ada, "2026-06-16T10:00:00Z", "2026-06-16T11:00:00Z", "nap");
  addCompletedSleep(bo, "2026-06-16T12:00:00Z", "2026-06-16T13:00:00Z", "nap");
  addDiaper(ada, "2026-06-16T09:00:00Z");
  addDiaper(bo, "2026-06-16T09:30:00Z");
  addNightWaking(ada, "2026-06-16T02:00:00Z", "2026-06-16T02:20:00Z");
  addNightWaking(bo, "2026-06-16T03:00:00Z", "2026-06-16T03:10:00Z");

  const sleeps = (await (await get("/api/sleeps?baby=all")).json()) as { baby_id: number }[];
  const diapers = (await (await get("/api/diapers?baby=all")).json()) as { baby_id: number }[];
  const wakings = (await (await get("/api/night-wakings?baby=all")).json()) as { baby_id: number }[];

  expect(new Set(sleeps.map((r) => r.baby_id))).toEqual(new Set([ada, bo]));
  expect(new Set(diapers.map((r) => r.baby_id))).toEqual(new Set([ada, bo]));
  expect(new Set(wakings.map((r) => r.baby_id))).toEqual(new Set([ada, bo]));
});

test("no baby param scopes to the newest baby (single-baby default unchanged)", async () => {
  const ada = createBaby("Ada", "2025-06-12");
  const bo = createBaby("Bo", "2025-06-12");
  addCompletedSleep(ada, "2026-06-16T10:00:00Z", "2026-06-16T11:00:00Z", "nap");
  addCompletedSleep(bo, "2026-06-16T12:00:00Z", "2026-06-16T13:00:00Z", "nap");

  const sleeps = (await (await get("/api/sleeps")).json()) as { baby_id: number }[];

  expect(sleeps.every((r) => r.baby_id === bo)).toBe(true);
  expect(sleeps.length).toBe(1);
});

test("explicit ?baby=<id> scopes to that child", async () => {
  const ada = createBaby("Ada", "2025-06-12");
  const bo = createBaby("Bo", "2025-06-12");
  addCompletedSleep(ada, "2026-06-16T10:00:00Z", "2026-06-16T11:00:00Z", "nap");
  addCompletedSleep(bo, "2026-06-16T12:00:00Z", "2026-06-16T13:00:00Z", "nap");

  const sleeps = (await (await get(`/api/sleeps?baby=${ada}`)).json()) as { baby_id: number }[];

  expect(sleeps.every((r) => r.baby_id === ada)).toBe(true);
  expect(sleeps.length).toBe(1);
});
