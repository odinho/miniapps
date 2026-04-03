import { test, expect, generateId, fillDateInput, forceMorning, forceHour } from "./fixtures";

test("Get Started button creates baby and shows morning prompt", async ({ page }) => {
  await forceMorning(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Velkomen til Babysovelogg" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Kom i gang ✨" })).toBeVisible();

  await page.locator('#baby-name').fill("Halldis");
  await fillDateInput(page.locator('input.date-input'), "2025-06-12");

  await page.getByRole("button", { name: "Kom i gang ✨" }).click();

  // During morning hours, the morning prompt appears after onboarding
  await expect(page.getByTestId("morning-prompt")).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole("heading", { name: "God morgon!" })).toBeVisible();
});

test("Get Started validates required fields", async ({ page }) => {
  await forceMorning(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Kom i gang ✨" }).click();
  await expect(page.getByRole("heading", { name: "Velkomen til Babysovelogg" })).toBeVisible();

  await page.locator('#baby-name').fill("Halldis");
  await page.getByRole("button", { name: "Kom i gang ✨" }).click();
  await expect(page.getByRole("heading", { name: "Velkomen til Babysovelogg" })).toBeVisible();

  await fillDateInput(page.locator('input.date-input'), "2025-06-12");
  await page.getByRole("button", { name: "Kom i gang ✨" }).click();
  // After onboarding during morning hours, morning prompt shows
  await expect(page.getByTestId("morning-prompt")).toBeVisible({ timeout: 5000 });
});

test("Sleep tracking flow after onboarding", async ({ page, request }) => {
  await forceHour(page, 14); // Afternoon — no morning prompt
  // Create baby via API
  await request.post("/api/events", {
    data: {
      events: [
        {
          type: "baby.created",
          payload: { name: "Halldis", birthdate: "2025-06-12" },
          clientId: "test",
          clientEventId: generateId(),
        },
      ],
    },
  });

  await page.goto("/");
  // Afternoon: no morning prompt, dashboard appears directly
  await expect(page.getByTestId("baby-name")).toHaveText("Halldis", { timeout: 5000 });

  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 3000 });
});

test("Setting wake time via morning prompt enables predictions", async ({ page }) => {
  await forceMorning(page);
  // Create baby via API
  await page.goto("/");
  await page.locator('#baby-name').fill("Testa");
  await fillDateInput(page.locator('input.date-input'), "2025-06-12");
  await page.getByRole("button", { name: "Kom i gang ✨" }).click();

  await expect(page.getByTestId("morning-prompt")).toBeVisible({ timeout: 5000 });

  // Set wake time
  await page.getByRole("button", { name: "Sett vaknetid" }).click();
  await expect(page.getByTestId("morning-prompt")).not.toBeVisible({ timeout: 5000 });

  // Dashboard should now be fully functional
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await expect(page.getByTestId("sleep-button")).toBeVisible();
});

test("Skip button dismisses morning prompt with default time", async ({ page }) => {
  await forceMorning(page);
  await page.goto("/");
  await page.locator('#baby-name').fill("Testa");
  await fillDateInput(page.locator('input.date-input'), "2025-06-12");
  await page.getByRole("button", { name: "Kom i gang ✨" }).click();

  await expect(page.getByTestId("morning-prompt")).toBeVisible({ timeout: 5000 });

  await page.getByRole("button", { name: "Hopp over" }).click();
  await expect(page.getByTestId("morning-prompt")).not.toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("dashboard")).toBeVisible();
});
