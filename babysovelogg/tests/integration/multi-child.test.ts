import { test, expect } from "bun:test";
import {
  db,
  get,
  post,
  postEvents,
  createBaby,
  makeEvent,
  addCompletedSleep,
  generateSleepId,
  setupHarness,
} from "./harness.js";
setupHarness();

const renderBabies = () =>
  (db.prepare("SELECT id, name, birthdate FROM baby ORDER BY id").all() as {
    id: number;
    name: string;
    birthdate: string;
  }[])
    .map((b) => `#${b.id} ${b.name} (${b.birthdate})`)
    .join("\n");

const renderDayStarts = () =>
  (db.prepare("SELECT baby_id, date, wake_time FROM day_start ORDER BY baby_id, date").all() as {
    baby_id: number;
    date: string;
    wake_time: string;
  }[])
    .map((d) => `baby#${d.baby_id} ${d.date} @ ${d.wake_time}`)
    .join("\n") || "(ingen)";

const familyTz = () =>
  (db.prepare("SELECT timezone FROM family WHERE id = 1").get() as { timezone: string | null })
    .timezone;

const renderSleeps = (rows: { baby_id: number; start_time: string }[]) =>
  rows.map((s) => `#${s.baby_id} ${s.start_time.slice(11, 16)}`).join(", ") || "(ingen)";

test("baby.updated targets the named baby, not the newest one", async () => {
  const ada = createBaby("Ada", "2025-06-12");
  createBaby("Bo", "2025-06-12");

  await postEvents([makeEvent("baby.updated", { babyId: ada, name: "Ada Endra" })]);

  expect(renderBabies()).toMatchInlineSnapshot(`
    "#1 Ada Endra (2025-06-12)
    #2 Bo (2025-06-12)"
  `);
});

test("baby.updated without babyId falls back to the newest baby (replay-compat)", async () => {
  createBaby("Ada", "2025-06-12");
  createBaby("Bo", "2025-06-12");

  await postEvents([makeEvent("baby.updated", { name: "Bo Endra" })]);

  expect(renderBabies()).toMatchInlineSnapshot(`
    "#1 Ada (2025-06-12)
    #2 Bo Endra (2025-06-12)"
  `);
});

test("timezone is family-wide: one zone buckets both babies' day boundaries", async () => {
  const ada = createBaby("Ada", "2025-06-12");
  const bo = createBaby("Bo", "2025-06-12");

  await postEvents([makeEvent("family.updated", { timezone: "America/New_York" })]);
  await postEvents([makeEvent("day.started", { babyId: ada, wakeTime: "2026-03-26T02:00:00.000Z" })]);
  await postEvents([makeEvent("day.started", { babyId: bo, wakeTime: "2026-03-26T02:00:00.000Z" })]);

  expect(renderDayStarts()).toMatchInlineSnapshot(`
    "baby#1 2026-03-25 @ 2026-03-26T02:00:00.000Z
    baby#2 2026-03-25 @ 2026-03-26T02:00:00.000Z"
  `);
});

test("the family zone is overlaid on every baby slice — divergence is impossible", async () => {
  createBaby("Ada", "2025-06-12");
  createBaby("Bo", "2025-06-12");

  await postEvents([makeEvent("family.updated", { timezone: "Asia/Tokyo" })]);
  const data = await (await get("/api/state")).json();

  expect(data.babies.map((b: { baby: { name: string; timezone: string } }) => `${b.baby.name}: ${b.baby.timezone}`))
    .toMatchInlineSnapshot(`
    [
      "Ada: Asia/Tokyo",
      "Bo: Asia/Tokyo",
    ]
  `);
});

test("replay-compat: legacy baby.updated{timezone} still sets the family zone, and it survives rebuild", async () => {
  const ada = createBaby("Ada", "2025-06-12");

  await postEvents([makeEvent("family.updated", { timezone: "Europe/Oslo" })]);
  await postEvents([makeEvent("baby.updated", { babyId: ada, timezone: "America/New_York" })]);
  const afterLegacyEdit = familyTz();
  await post("/api/admin/rebuild", {});

  expect({ afterLegacyEdit, afterRebuild: familyTz() }).toMatchInlineSnapshot(`
    {
      "afterLegacyEdit": "America/New_York",
      "afterRebuild": "America/New_York",
    }
  `);
});

test("family.updated with a null timezone is ignored — the household zone is never cleared", async () => {
  createBaby("Ada", "2025-06-12");

  await postEvents([makeEvent("family.updated", { timezone: "Europe/Oslo" })]);
  await postEvents([makeEvent("family.updated", { timezone: null })]);

  expect(familyTz()).toMatchInlineSnapshot(`"Europe/Oslo"`);
});

test("rebuild reconstructs the family zone from the event log (created fills, later events overwrite)", async () => {
  await postEvents([makeEvent("baby.created", { name: "Ada", birthdate: "2025-06-12", timezone: "Europe/Oslo" })]);
  const afterCreate = familyTz();
  await postEvents([makeEvent("baby.created", { name: "Bo", birthdate: "2025-06-12", timezone: "Asia/Tokyo" })]);
  const afterSecondCreate = familyTz();
  await postEvents([makeEvent("family.updated", { timezone: "America/New_York" })]);
  const afterUpdate = familyTz();
  await post("/api/admin/rebuild", {});

  expect({ afterCreate, afterSecondCreate, afterUpdate, afterRebuild: familyTz() }).toMatchInlineSnapshot(`
    {
      "afterCreate": "Europe/Oslo",
      "afterRebuild": "America/New_York",
      "afterSecondCreate": "Europe/Oslo",
      "afterUpdate": "America/New_York",
    }
  `);
});

test("day_start dates are byte-for-byte identical before and after a rebuild", async () => {
  const ada = createBaby("Ada", "2025-06-12");

  await postEvents([makeEvent("family.updated", { timezone: "America/New_York" })]);
  await postEvents([makeEvent("day.started", { babyId: ada, wakeTime: "2026-03-26T02:00:00.000Z" })]);
  const before = renderDayStarts();
  await post("/api/admin/rebuild", {});

  expect(renderDayStarts()).toBe(before);
  expect(before).toMatchInlineSnapshot(`"baby#1 2026-03-25 @ 2026-03-26T02:00:00.000Z"`);
});

test("GET /api/state returns a family snapshot with both babies, newest as legacy alias", async () => {
  createBaby("Ada", "2025-06-12");
  createBaby("Bo", "2025-06-12");

  const data = await (await get("/api/state")).json();

  expect({
    babies: data.babies.map((b: { baby: { id: number; name: string } }) => `#${b.baby.id} ${b.baby.name}`),
    legacyAlias: `#${data.baby.id} ${data.baby.name}`,
  }).toMatchInlineSnapshot(`
    {
      "babies": [
        "#1 Ada",
        "#2 Bo",
      ],
      "legacyAlias": "#2 Bo",
    }
  `);
});

test("GET /api/state?baby= scopes to one baby's slice", async () => {
  const ada = createBaby("Ada", "2025-06-12");
  createBaby("Bo", "2025-06-12");

  const slice = await (await get(`/api/state?baby=${ada}`)).json();
  const missing = await get("/api/state?baby=999");

  expect({ name: slice.baby.name, hasBabiesArray: "babies" in slice, missingStatus: missing.status })
    .toMatchInlineSnapshot(`
    {
      "hasBabiesArray": false,
      "missingStatus": 404,
      "name": "Ada",
    }
  `);
});

test("GET /api/sleeps?baby= scopes reads to the requested baby", async () => {
  const ada = createBaby("Ada", "2025-06-12");
  const bo = createBaby("Bo", "2025-06-12");
  addCompletedSleep(ada, "2026-03-26T09:00:00Z", "2026-03-26T10:00:00Z", "nap", generateSleepId());
  addCompletedSleep(bo, "2026-03-26T13:00:00Z", "2026-03-26T14:00:00Z", "nap", generateSleepId());

  const adaSleeps = await (await get(`/api/sleeps?baby=${ada}`)).json();
  const boSleeps = await (await get(`/api/sleeps?baby=${bo}`)).json();
  const defaultSleeps = await (await get("/api/sleeps")).json();

  expect({
    ada: renderSleeps(adaSleeps),
    bo: renderSleeps(boSleeps),
    default: renderSleeps(defaultSleeps),
  }).toMatchInlineSnapshot(`
    {
      "ada": "#1 09:00",
      "bo": "#2 13:00",
      "default": "#2 13:00",
    }
  `);
});
