import {
  test,
  expect,
  createBaby,
  setWakeUpTime,
  getDb,
  generateSleepId,
  generateDiaperId,
  postEvents,
  makeEvent,
} from "./fixtures";

test("Rebuild on clean data produces identical row counts", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateSleepId();

  await postEvents(page, [
    makeEvent("sleep.started", {
      babyId,
      startTime: new Date(Date.now() - 3600000).toISOString(),
      sleepDomainId: did,
    }),
  ]);
  await postEvents(page, [
    makeEvent("sleep.ended", { sleepDomainId: did, endTime: new Date().toISOString() }),
  ]);

  const res = await page.request.post("/api/admin/rebuild");
  expect(res.ok()).toBe(true);
  const report = await res.json();
  expect(report.success).toBe(true);
  expect(report.before.sleeps).toBe(report.after.sleeps);
  expect(report.before.diapers).toBe(report.after.diapers);
});

test("Rebuild after manual DB corruption restores data", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateSleepId();
  const diaperDid = generateDiaperId();

  await postEvents(page, [
    makeEvent("sleep.started", {
      babyId,
      startTime: new Date(Date.now() - 3600000).toISOString(),
      sleepDomainId: did,
    }),
  ]);
  await postEvents(page, [
    makeEvent("sleep.ended", { sleepDomainId: did, endTime: new Date().toISOString() }),
  ]);
  await postEvents(page, [
    makeEvent("diaper.logged", {
      babyId,
      time: new Date().toISOString(),
      type: "wet",
      diaperDomainId: diaperDid,
    }),
  ]);

  // Corrupt: delete a projection row
  const db = getDb();
  db.prepare("DELETE FROM sleep_log WHERE domain_id = ?").run(did);
  const sleepsBefore = (db.prepare("SELECT COUNT(*) as c FROM sleep_log").get() as { c: number }).c;
  db.close();
  expect(sleepsBefore).toBe(0);

  // Rebuild should restore
  const res = await page.request.post("/api/admin/rebuild");
  const report = await res.json();
  expect(report.success).toBe(true);
  expect(report.after.sleeps).toBe(1);
});

test("Rebuild report includes correct event count and timing", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  await postEvents(page, [
    makeEvent("diaper.logged", {
      babyId,
      time: new Date().toISOString(),
      type: "wet",
      diaperDomainId: generateDiaperId(),
    }),
  ]);

  const res = await page.request.post("/api/admin/rebuild");
  const report = await res.json();
  expect(report.success).toBe(true);
  // Events: baby.created (from fixture) + diaper.logged
  expect(report.eventsReplayed).toBeGreaterThanOrEqual(2);
  expect(report.durationMs).toBeGreaterThanOrEqual(0);
});

test("After rebuild, all domain_ids are preserved", async ({ page }) => {
  const babyId = createBaby("Testa");
  const did1 = generateSleepId();
  const did2 = generateDiaperId();

  await postEvents(page, [
    makeEvent("sleep.started", {
      babyId,
      startTime: new Date().toISOString(),
      sleepDomainId: did1,
    }),
  ]);
  await postEvents(page, [
    makeEvent("diaper.logged", {
      babyId,
      time: new Date().toISOString(),
      type: "dirty",
      diaperDomainId: did2,
    }),
  ]);

  await page.request.post("/api/admin/rebuild");

  const db = getDb();
  const sleep = db.prepare("SELECT domain_id FROM sleep_log WHERE domain_id = ?").get(did1);
  const diaper = db.prepare("SELECT domain_id FROM diaper_log WHERE domain_id = ?").get(did2);
  db.close();
  expect(sleep).toBeDefined();
  expect(diaper).toBeDefined();
});

test("After rebuild, GET /api/state returns correct current state", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateDiaperId();

  await postEvents(page, [
    makeEvent("diaper.logged", {
      babyId,
      time: new Date().toISOString(),
      type: "wet",
      diaperDomainId: did,
    }),
  ]);

  await page.request.post("/api/admin/rebuild");

  const stateRes = await page.request.get("/api/state");
  const state = await stateRes.json();
  expect(state.baby).toBeDefined();
  expect(state.diaperCount).toBeGreaterThanOrEqual(1);
});
