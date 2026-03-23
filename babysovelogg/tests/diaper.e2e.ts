import { test, expect, createBaby, setWakeUpTime, forceMorning } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await forceMorning(page);
});

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
