import { test, expect } from "vitest";
import {
  get,
  createBaby,
  setWakeUpTime,
  addCompletedSleep,
  addDiaper,
} from "./harness.js";

test("Export JSON endpoint returns sleep and diaper data", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const now = new Date();
  addCompletedSleep(
    babyId,
    new Date(now.getTime() - 3600000).toISOString(),
    new Date(now.getTime() - 1800000).toISOString(),
    "nap",
  );
  addDiaper(babyId, now.toISOString(), "wet", "middels");

  const res = await get("/api/export");
  expect(res.ok).toBe(true);
  const data = await res.json();
  expect(data.baby).toBeTruthy();
  expect(data.baby.name).toBe("Testa");
  expect(data.sleeps.length).toBe(1);
  expect(data.diapers.length).toBe(1);
  expect(data.dayStarts.length).toBe(1);
});

test("Export CSV endpoint returns valid CSV", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const now = new Date();
  addCompletedSleep(
    babyId,
    new Date(now.getTime() - 3600000).toISOString(),
    new Date(now.getTime() - 1800000).toISOString(),
    "nap",
  );

  const res = await get("/api/export?format=csv");
  expect(res.ok).toBe(true);
  const contentType = res.headers.get("content-type");
  expect(contentType).toContain("text/csv");
  const body = await res.text();
  expect(body).toContain("type,start,end,sleep_type,mood,method,notes");
  expect(body).toContain("sleep,");
});

test("Export returns 404 when no baby", async () => {
  const res = await get("/api/export");
  expect(res.status).toBe(404);
});
