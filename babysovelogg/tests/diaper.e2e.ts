import { test, expect, createBaby, setWakeUpTime, addDiaper, enablePottyMode } from "./fixtures";

test("Can log a diaper change", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  await page.getByRole("button", { name: /Bleie/ }).click();
  await expect(page.getByRole("heading", { name: "Logg bleie" })).toBeVisible();

  await page.getByRole("button", { name: /Skitten/ }).click();
  await page.getByRole("button", { name: "Lagra" }).click();

  await expect(page.getByTestId("modal-overlay")).not.toBeVisible({ timeout: 5000 });

  // Verify diaper was logged via history
  await page.locator(".nav-bar").getByText("Logg").click();
  await expect(page.locator(".diaper-log-item")).toHaveCount(1, { timeout: 5000 });
});

test("Diaper shows in history", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  await page.getByRole("button", { name: /Bleie/ }).click();
  await page.getByRole("button", { name: "Lagra" }).click();
  await expect(page.getByTestId("modal-overlay")).not.toBeVisible({ timeout: 5000 });

  await page.locator(".nav-bar").getByText("Logg").click();
  await expect(page.locator(".diaper-log-item")).toHaveCount(1, { timeout: 5000 });
  await expect(page.locator(".diaper-log-item .log-duration")).toHaveText("Bleie");
});

test("Multiple diapers can be logged", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  // Log first diaper
  await page.getByRole("button", { name: /Bleie/ }).click();
  await page.getByRole("button", { name: "Lagra" }).click();
  await expect(page.getByTestId("modal-overlay")).not.toBeVisible({ timeout: 5000 });

  // Log second diaper
  await page.getByRole("button", { name: /Bleie/ }).click();
  await page.getByRole("button", { name: "Lagra" }).click();
  await expect(page.getByTestId("modal-overlay")).not.toBeVisible({ timeout: 5000 });

  // Verify both in history
  await page.locator(".nav-bar").getByText("Logg").click();
  await expect(page.locator(".diaper-log-item")).toHaveCount(2, { timeout: 5000 });
});

test("Can delete a diaper entry", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  await page.getByRole("button", { name: /Bleie/ }).click();
  await page.getByRole("button", { name: "Lagra" }).click();
  await expect(page.getByTestId("modal-overlay")).not.toBeVisible({ timeout: 5000 });

  await page.locator(".nav-bar").getByText("Logg").click();
  await expect(page.locator(".diaper-log-item")).toHaveCount(1, { timeout: 5000 });

  await page.locator(".diaper-log-item").click();
  await expect(page.getByRole("heading", { name: "Bleiedetaljar" })).toBeVisible();
  // Click Slett in diaper details — opens custom confirm dialog
  await page.getByRole("button", { name: "Slett" }).first().click();
  // Click Slett in confirm dialog
  await page.locator(".modal-overlay").last().getByRole("button", { name: "Slett" }).click();

  await expect(page.locator(".diaper-log-item")).toHaveCount(0, { timeout: 5000 });
});

// Potty mode tests

test("Potty mode shows Do button instead of Bleie", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  enablePottyMode(babyId);
  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  await expect(page.getByRole("button", { name: /Do/ })).toBeVisible();
});

test("Potty entry opens potty edit modal in history", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  enablePottyMode(babyId);
  addDiaper(babyId, new Date().toISOString(), "potty_wet", "dry");

  await page.goto("/#/history");
  await expect(page.locator(".diaper-log-item")).toHaveCount(1, { timeout: 5000 });

  // Category label should say "Do"
  await expect(page.locator(".diaper-log-item .log-duration")).toHaveText("Do");

  // Click opens potty edit modal (not diaper)
  await page.locator(".diaper-log-item").click();
  await expect(page.getByRole("heading", { name: "Dobesøk" })).toBeVisible();

  // Should show potty-specific result pills (use data-potty to avoid ambiguity with status pills)
  await expect(page.locator('[data-potty="potty_wet"]')).toBeVisible();
  await expect(page.locator('[data-potty="potty_dirty"]')).toBeVisible();
  await expect(page.locator('[data-potty="potty_nothing"]')).toBeVisible();
  await expect(page.locator('[data-potty="diaper_only"]')).toBeVisible();

  // The potty_wet result pill should be active
  await expect(page.locator('[data-potty="potty_wet"]')).toHaveClass(/active/);
});

test("Can edit potty entry type in history", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  enablePottyMode(babyId);
  addDiaper(babyId, new Date().toISOString(), "potty_wet", "dry");

  await page.goto("/#/history");
  await expect(page.locator(".diaper-log-item")).toHaveCount(1, { timeout: 5000 });

  await page.locator(".diaper-log-item").click();
  await expect(page.getByRole("heading", { name: "Dobesøk" })).toBeVisible();

  // Change from potty_wet to potty_dirty (use data-potty to avoid status pill ambiguity)
  await page.locator('[data-potty="potty_dirty"]').click();
  await page.getByRole("button", { name: "Lagra" }).click();

  await expect(page.getByTestId("modal-overlay")).not.toBeVisible({ timeout: 5000 });
  // History should show updated type
  await expect(page.locator(".diaper-log-item .log-meta")).toContainText("Bæsj på do");
});

test("Dashboard shows potty count in summary", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  enablePottyMode(babyId);

  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  // Log a potty visit
  await page.getByRole("button", { name: /Do/ }).click();
  await page.getByRole("button", { name: "Lagra" }).click();
  await expect(page.getByTestId("modal-overlay")).not.toBeVisible({ timeout: 5000 });

  // Summary should show "1 dobesøk"
  await expect(page.locator(".summary-row")).toContainText("dobesøk", { timeout: 5000 });
});

test("Diaper entry still opens diaper edit modal", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  addDiaper(babyId, new Date().toISOString(), "wet", "middels");

  await page.goto("/#/history");
  await expect(page.locator(".diaper-log-item")).toHaveCount(1, { timeout: 5000 });

  await page.locator(".diaper-log-item").click();
  // Should open diaper edit modal, not potty
  await expect(page.getByRole("heading", { name: "Bleiedetaljar" })).toBeVisible();
});
