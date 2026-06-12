import { test, expect, createBaby, fillDateInput } from "./fixtures";

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
