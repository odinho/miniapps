import {
  test,
  expect,
  createBaby,
  setWakeUpTime,
  fillDateInput,
  postEvents,
  makeEvent,
  addActiveSleep,
} from "./fixtures";

const babyNames = async (request: { get: (url: string) => Promise<{ json: () => Promise<unknown> }> }) => {
  const state = (await (await request.get("/api/state")).json()) as {
    babies: { baby: { name: string } }[];
  };
  return state.babies.map((b) => b.baby.name);
};

test("editing the first child after a second exists does not corrupt the second", async ({
  page,
  request,
}) => {
  createBaby("Ada", "2025-06-12");
  createBaby("Bo", "2025-06-12");

  await page.goto("/settings?baby=1");
  await expect(page.locator("#baby-name")).toHaveValue("Ada", { timeout: 5000 });
  await page.locator("#baby-name").fill("Ada Endra");
  await page.getByRole("button", { name: "Lagra" }).click();

  await expect(page).toHaveURL("/", { timeout: 5000 });
  expect(await babyNames(request)).toEqual(["Ada Endra", "Bo"]);
});

test("settings keeps an unsaved edit when a state refresh arrives", async ({ page }) => {
  const ada = createBaby("Ada", "2025-06-12");
  createBaby("Bo", "2025-06-12");

  await page.goto("/settings?baby=1");
  await expect(page.locator("#baby-name")).toHaveValue("Ada", { timeout: 5000 });

  // Parent edits the name but hasn't saved yet.
  await page.locator("#baby-name").fill("Ada WIP");

  // A state refresh arrives over SSE (another device renamed Ada). The active
  // tab reflects the server value, but the in-progress edit must NOT be reset.
  await postEvents(page, [makeEvent("baby.updated", { babyId: ada, name: "Ada Server" })]);

  // SSE propagated (tab now shows the server name)...
  await expect(
    page.getByTestId("child-tabs").getByRole("button", { name: "Ada Server" }),
  ).toBeVisible({ timeout: 5000 });
  // ...but the unsaved edit survived.
  await expect(page.locator("#baby-name")).toHaveValue("Ada WIP");
});

test("can add a second child from settings", async ({ page, request }) => {
  createBaby("Ada", "2025-06-12");

  await page.goto("/settings");
  await page.getByTestId("add-child").click();
  await expect(page.getByRole("heading", { name: "Legg til barn" })).toBeVisible();
  await page.locator("#baby-name").fill("Bo");
  await fillDateInput(page.locator("input.date-input"), "2025-06-12");
  await page.getByRole("button", { name: "Legg til barn" }).click();

  await expect(page).toHaveURL("/", { timeout: 5000 });
  expect(await babyNames(request)).toEqual(["Ada", "Bo"]);
});

test("a single-baby family sees no child tabs, only the add-child entry", async ({ page }) => {
  createBaby("Ada", "2025-06-12");

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Innstillingar" })).toBeVisible();

  await expect(page.getByTestId("add-child")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ada", exact: true })).toHaveCount(0);
});

const sliceByName = async (
  request: { get: (url: string) => Promise<{ json: () => Promise<unknown> }> },
  name: string,
) => {
  const state = (await (await request.get("/api/state")).json()) as {
    babies: { baby: { name: string }; activeSleep: unknown }[];
  };
  return state.babies.find((b) => b.baby.name === name)!;
};

test("a single-baby family sees the normal dashboard, no family lanes", async ({ page }) => {
  createBaby("Ada", "2025-06-12");

  await page.goto("/");

  await expect(page.getByTestId("baby-name")).toHaveText("Ada", { timeout: 5000 });
  await expect(page.getByTestId("family-home")).toHaveCount(0);
});

test("home shows a lane per child; logging on one lane lands on that child only", async ({
  page,
  request,
}) => {
  createBaby("Ada", "2025-06-12");
  createBaby("Bo", "2025-06-12");

  await page.goto("/");
  await expect(page.getByTestId("family-home")).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("baby-lane")).toHaveCount(2);

  const adaLane = page.getByTestId("baby-lane").filter({ hasText: "Ada" });
  const boLane = page.getByTestId("baby-lane").filter({ hasText: "Bo" });
  await expect(boLane.getByTestId("lane-status")).toContainText("Vaken");

  await adaLane.getByTestId("sleep-button").click();
  await expect(adaLane.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 3000 });
  // The lane now reflects the asleep state with elapsed time.
  await expect(adaLane.getByTestId("lane-status")).toContainText("Søv", { timeout: 3000 });

  expect(!!(await sliceByName(request, "Ada")).activeSleep).toBe(true);
  expect(!!(await sliceByName(request, "Bo")).activeSleep).toBe(false);
});

test('"Sove begge" starts a sleep for both children', async ({ page, request }) => {
  createBaby("Ada", "2025-06-12");
  createBaby("Bo", "2025-06-12");

  await page.goto("/");
  await page.getByTestId("sleep-both").click();
  await expect(page.getByTestId("wake-both")).toBeVisible({ timeout: 3000 });

  expect(!!(await sliceByName(request, "Ada")).activeSleep).toBe(true);
  expect(!!(await sliceByName(request, "Bo")).activeSleep).toBe(true);
});

test("a non-primary child's forgotten (stale) sleep surfaces on its own lane", async ({ page }) => {
  const ada = createBaby("Ada", "2025-06-12"); // id 1 — non-primary (primary alias = newest)
  createBaby("Bo", "2025-06-12");
  // 30h open sleep → stale regardless of the exact current time.
  addActiveSleep(ada, new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(), "night");

  await page.goto("/");
  await expect(page.getByTestId("family-home")).toBeVisible({ timeout: 5000 });

  const adaLane = page.getByTestId("baby-lane").filter({ hasText: "Ada" });
  await expect(adaLane.getByTestId("lane-status")).toContainText("Sjekk vaknetid", { timeout: 5000 });
});

test("mixed-age siblings get lanes but no 'begge' bulk actions", async ({ page }) => {
  createBaby("Ada", "2025-06-12");
  createBaby("Storesøster", "2020-01-01"); // years apart → sibling mode

  await page.goto("/");
  await expect(page.getByTestId("family-home")).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("baby-lane")).toHaveCount(2);
  await expect(page.getByTestId("sleep-both")).toHaveCount(0);
  await expect(page.getByTestId("wake-both")).toHaveCount(0);
});

test("tapping a lane opens that child's detail, and back returns to the family", async ({
  page,
}) => {
  createBaby("Ada", "2025-06-12");
  createBaby("Bo", "2025-06-12");

  await page.goto("/");
  await page.getByTestId("baby-lane").filter({ hasText: "Ada" }).getByTestId("lane-focus").click();

  await expect(page).toHaveURL(/\?baby=1$/, { timeout: 5000 });
  await expect(page.getByTestId("baby-name")).toHaveText("Ada");

  await page.getByTestId("back-to-family").click();
  await expect(page.getByTestId("family-home")).toBeVisible();
});

test("off-day toggle in a child's detail marks that child, not the primary", async ({
  page,
  request,
}) => {
  const ada = createBaby("Ada", "2025-06-12");
  const bo = createBaby("Bo", "2025-06-12");
  setWakeUpTime(ada);
  setWakeUpTime(bo);

  await page.goto("/?baby=1");
  await expect(page.getByTestId("baby-name")).toHaveText("Ada", { timeout: 5000 });
  await page.getByTestId("sleep-button").click();
  await page.getByTestId("off-day-toggle-tag").click();

  await expect
    .poll(async () => {
      const state = (await (await request.get("/api/state")).json()) as {
        babies: { baby: { name: string }; offDays: string[] }[];
      };
      const get = (name: string) => state.babies.find((b) => b.baby.name === name)!.offDays.length;
      return { ada: get("Ada"), bo: get("Bo") };
    })
    .toEqual({ ada: 1, bo: 0 });
});
