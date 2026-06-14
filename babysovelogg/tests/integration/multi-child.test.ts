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
  expectConsoleError,
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

const familyMode = async () => {
  const data = (await (await get("/api/state")).json()) as {
    family: { isTwinMode: boolean; modeOverride: string | null };
  };
  return `twin=${data.family.isTwinMode} override=${data.family.modeOverride}`;
};

test("twin-mode: inferred from age gap, family.updated override wins", async () => {
  createBaby("Ada", "2025-06-12");
  const bo = createBaby("Bo", "2025-06-20"); // 8 days apart → twins

  expect(await familyMode()).toBe("twin=true override=null");

  await postEvents([makeEvent("family.updated", { modeOverride: "sibling" })]);
  expect(await familyMode()).toBe("twin=false override=sibling");

  await postEvents([makeEvent("family.updated", { modeOverride: null })]);
  expect(await familyMode()).toBe("twin=true override=null");

  // Re-target Bo far from Ada → now siblings by inference.
  await postEvents([makeEvent("baby.updated", { babyId: bo, birthdate: "2023-01-01" })]);
  expect(await familyMode()).toBe("twin=false override=null");

  await postEvents([makeEvent("family.updated", { modeOverride: "twin" })]);
  expect(await familyMode()).toBe("twin=true override=twin");
});

test("sync-mode is a stored family preference, replayed deterministically on rebuild", async () => {
  createBaby("Ada", "2025-06-12");
  createBaby("Bo", "2025-06-20"); // twins

  const syncMode = async () =>
    ((await (await get("/api/state")).json()) as { family: { syncMode: boolean } }).family.syncMode;

  expect(await syncMode()).toBe(false);

  await postEvents([makeEvent("family.updated", { syncMode: true })]);
  expect(await syncMode()).toBe(true);

  // Explicit clear (present-but-false) turns it back off.
  await postEvents([makeEvent("family.updated", { syncMode: false })]);
  expect(await syncMode()).toBe(false);

  const { rebuildAll } = await import("$lib/server/projections.js");

  // Residue clear: drift the row to 1 with NO syncMode event in the log →
  // rebuild must reset it (this is the exact P2-1 reset-omission bug class).
  db.prepare("UPDATE family SET sync_mode = 1 WHERE id = 1").run();
  rebuildAll();
  expect(await syncMode()).toBe(false);

  // And a logged preference replays deterministically.
  await postEvents([makeEvent("family.updated", { syncMode: true })]);
  db.prepare("UPDATE family SET sync_mode = 0 WHERE id = 1").run();
  rebuildAll();
  expect(await syncMode()).toBe(true);
});

test("snapshot revision is monotonic — bumps as events are applied (X-2 guard)", async () => {
  createBaby("Ada", "2025-06-12");
  const rev = async () => ((await (await get("/api/state")).json()) as { revision: number }).revision;

  const r1 = await rev();
  expect(typeof r1).toBe("number");

  await postEvents([
    makeEvent("sleep.started", { babyId: 1, startTime: "2026-06-14T09:30:00.000Z", type: "nap", sleepDomainId: generateSleepId() }),
  ]);
  const r2 = await rev();
  expect(r2).toBeGreaterThan(r1);
});

test("max-2 cap: a 3rd baby.created is a no-op at the projection level (X-10)", async () => {
  expectConsoleError(/baby\.created ignored/);
  await postEvents([
    makeEvent("baby.created", { name: "Ada", birthdate: "2025-06-12" }),
    makeEvent("baby.created", { name: "Bo", birthdate: "2025-06-12" }),
    makeEvent("baby.created", { name: "Cy", birthdate: "2025-06-12" }),
  ]);
  const names = (db.prepare("SELECT name FROM baby ORDER BY id").all() as { name: string }[]).map(
    (b) => b.name,
  );
  expect(names).toEqual(["Ada", "Bo"]);
});

test("twin-mode is off for a single-baby family", async () => {
  createBaby("Ada", "2025-06-12");
  expect(await familyMode()).toBe("twin=false override=null");
});

// Render the whole family roll-up, but reduce firstWake to its baby (the `at`
// time is engine-derived and not the subject of this test) so the assertion
// stays full-state yet deterministic.
const renderFamily = async () => {
  const { family } = (await (await get("/api/state")).json()) as {
    family: {
      isTwinMode: boolean;
      modeOverride: string | null;
      bothAsleep: boolean;
      firstWake: { name: string } | null;
    };
  };
  return `twin=${family.isTwinMode} override=${family.modeOverride} bothAsleep=${family.bothAsleep} firstWake=${family.firstWake?.name ?? "none"}`;
};

test("family roll-up: bothAsleep needs both children down", async () => {
  const ada = createBaby("Ada", "2025-06-12");
  const bo = createBaby("Bo", "2025-06-12");

  expect(await renderFamily()).toBe("twin=true override=null bothAsleep=false firstWake=none");

  await postEvents([
    makeEvent("sleep.started", { babyId: ada, startTime: "2026-06-14T09:30:00.000Z", type: "nap", sleepDomainId: generateSleepId() }),
  ]);
  expect(await renderFamily()).toContain("bothAsleep=false");

  await postEvents([
    makeEvent("sleep.started", { babyId: bo, startTime: "2026-06-14T09:40:00.000Z", type: "nap", sleepDomainId: generateSleepId() }),
  ]);
  expect(await renderFamily()).toContain("bothAsleep=true");
});

test("rebuild is deterministic: mode_override replays from the log, residue is cleared", async () => {
  createBaby("Ada", "2025-06-12");
  createBaby("Bo", "2025-06-20"); // twins by inference, no override event

  // Contaminate the family row as if a stale override leaked in.
  db.prepare("UPDATE family SET mode_override = 'twin' WHERE id = 1").run();

  const { rebuildAll } = await import("$lib/server/projections.js");
  rebuildAll();

  // The event log has no override, so rebuild must return to auto-infer.
  expect(await familyMode()).toBe("twin=true override=null");
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
