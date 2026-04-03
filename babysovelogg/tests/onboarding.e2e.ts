import { test, expect, generateId, fillDateInput } from "./fixtures";

test("Get Started button creates baby and navigates to dashboard", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Velkomen til Babysovelogg" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Kom i gang ✨" })).toBeVisible();

  await page.locator('#baby-name').fill("Halldis");
  await fillDateInput(page.locator('input.date-input'), "2025-06-12");

  await page.getByRole("button", { name: "Kom i gang ✨" }).click();

  // After onboarding, the dashboard appears directly (no morning prompt)
  await expect(page.getByTestId("baby-name")).toHaveText("Halldis", { timeout: 5000 });
  await expect(page.getByTestId("baby-age")).toContainText("mnd");
  await expect(page.getByTestId("sleep-button")).toBeVisible();
});

test("Get Started validates required fields", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Kom i gang ✨" }).click();
  await expect(page.getByRole("heading", { name: "Velkomen til Babysovelogg" })).toBeVisible();

  await page.locator('#baby-name').fill("Halldis");
  await page.getByRole("button", { name: "Kom i gang ✨" }).click();
  await expect(page.getByRole("heading", { name: "Velkomen til Babysovelogg" })).toBeVisible();

  await fillDateInput(page.locator('input.date-input'), "2025-06-12");
  await page.getByRole("button", { name: "Kom i gang ✨" }).click();
  // After onboarding, the dashboard appears directly (no morning prompt)
  await expect(page.getByTestId("baby-name")).toHaveText("Halldis", { timeout: 5000 });
});

test("Sleep tracking flow after onboarding", async ({ page, request }) => {
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
  // After baby is created, the dashboard appears directly (no morning prompt)
  await expect(page.getByTestId("baby-name")).toHaveText("Halldis", { timeout: 5000 });

  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 3000 });
});
