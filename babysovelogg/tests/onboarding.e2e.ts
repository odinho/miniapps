import { test, expect, generateId, fillDateInput, forceMorning, forceHour } from "./fixtures";

async function onboardThroughForm(page: import("@playwright/test").Page, name: string) {
  await expect(page.getByRole("heading", { name: "Velkomen til Babysovelogg" })).toBeVisible();
  await page.locator("#baby-name").fill(name);
  await fillDateInput(page.locator("input.date-input"), "2025-06-12");
  await page.getByRole("button", { name: "Kom i gang ✨" }).click();
}

test("Onboarding creates the baby and shows the first-day seed step", async ({ page }) => {
  await forceMorning(page);
  await page.goto("/");
  await onboardThroughForm(page, "Halldis");

  // The seed step intercepts before the dashboard. Morning → "wake" default.
  await expect(page.getByTestId("seed-step")).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("seed-question")).toContainText("vakna Halldis");
});

test("Onboarding validates required fields before reaching the seed step", async ({ page }) => {
  await forceMorning(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Kom i gang ✨" }).click();
  await expect(page.getByRole("heading", { name: "Velkomen til Babysovelogg" })).toBeVisible();

  await page.locator("#baby-name").fill("Halldis");
  await page.getByRole("button", { name: "Kom i gang ✨" }).click();
  await expect(page.getByRole("heading", { name: "Velkomen til Babysovelogg" })).toBeVisible();

  await fillDateInput(page.locator("input.date-input"), "2025-06-12");
  await page.getByRole("button", { name: "Kom i gang ✨" }).click();
  await expect(page.getByTestId("seed-step")).toBeVisible({ timeout: 5000 });
});

test("Seeding a wake time lands on the populated dashboard (no morning prompt)", async ({
  page,
}) => {
  await forceMorning(page);
  await page.goto("/");
  await onboardThroughForm(page, "Halldis");

  await expect(page.getByTestId("seed-step")).toBeVisible({ timeout: 5000 });
  // Default wake time (07:00) is fine — just confirm.
  await page.getByTestId("seed-primary").click();

  await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("baby-name")).toHaveText("Halldis");
  // Wake time recorded → morning prompt suppressed.
  await expect(page.getByTestId("morning-prompt")).toHaveCount(0);
  // A brand-new baby has no sleep data, so the engine's "skipped nap" /
  // rescue-nap nudges must NOT show yet — presumptuous before any logging.
  await expect(page.getByTestId("post-skip-tip")).toHaveCount(0);
  await expect(page.getByTestId("rescue-nap-banner")).toHaveCount(0);
});

test("Seed defaults to bedtime at night and can toggle back to wake", async ({ page }) => {
  await forceHour(page, 21);
  await page.goto("/");
  await onboardThroughForm(page, "Halldis");

  await expect(page.getByTestId("seed-step")).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("seed-question")).toContainText("sovna Halldis");

  await page.getByTestId("seed-toggle-wake").click();
  await expect(page.getByTestId("seed-question")).toContainText("vakna Halldis");
});

test("Skipping the seed still guides a cold baby with the morning prompt at any hour", async ({
  page,
}) => {
  await forceHour(page, 15); // Afternoon — the old hour-gate would have hidden the prompt.
  await page.goto("/");
  await onboardThroughForm(page, "Halldis");

  await expect(page.getByTestId("seed-step")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("seed-skip").click();

  await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 5000 });
  // Cold start → guidance shows even though it's 15:00 (the reported bug).
  await expect(page.getByTestId("morning-prompt")).toBeVisible({ timeout: 5000 });
});

test("Add a sibling from the seed step (twin onboarding), then start", async ({ page, request }) => {
  await forceMorning(page);
  await page.goto("/");
  await onboardThroughForm(page, "Ada");

  await expect(page.getByTestId("seed-step")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("seed-add-another").click();

  // Back in the create form for child #2.
  await expect(page.getByRole("heading", { name: "Legg til barn" })).toBeVisible({ timeout: 5000 });
  await page.locator("#baby-name").fill("Bo");
  await fillDateInput(page.locator("input.date-input"), "2025-06-12");
  await page.getByRole("button", { name: "Legg til barn" }).click();

  // Seed step for Bo now; the 2-child cap removes the add-another button.
  await expect(page.getByTestId("seed-step")).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("seed-question")).toContainText("Bo");
  await expect(page.getByTestId("seed-add-another")).toHaveCount(0);

  await page.getByTestId("seed-primary").click();
  await expect(page).toHaveURL("/", { timeout: 5000 });

  const state = (await (await request.get("/api/state")).json()) as {
    babies: { baby: { name: string } }[];
  };
  expect(state.babies.map((b) => b.baby.name)).toEqual(["Ada", "Bo"]);
});

test("Sleep tracking flow works for a baby created via API", async ({ page, request }) => {
  await forceHour(page, 14);
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
  await expect(page.getByTestId("baby-name")).toHaveText("Halldis", { timeout: 5000 });

  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 3000 });
});

test("Morning prompt records the wake time and clears", async ({ page, request }) => {
  await forceMorning(page);
  await request.post("/api/events", {
    data: {
      events: [
        {
          type: "baby.created",
          payload: { name: "Testa", birthdate: "2025-06-12" },
          clientId: "test",
          clientEventId: generateId(),
        },
      ],
    },
  });

  await page.goto("/");
  // Cold baby → morning prompt shows.
  await expect(page.getByTestId("morning-prompt")).toBeVisible({ timeout: 5000 });

  await page.getByRole("button", { name: "Sett vaknetid" }).click();
  await expect(page.getByTestId("morning-prompt")).not.toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await expect(page.getByTestId("sleep-button")).toBeVisible();
});

test("Morning prompt skip dismisses for the day", async ({ page, request }) => {
  await forceMorning(page);
  await request.post("/api/events", {
    data: {
      events: [
        {
          type: "baby.created",
          payload: { name: "Testa", birthdate: "2025-06-12" },
          clientId: "test",
          clientEventId: generateId(),
        },
      ],
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("morning-prompt")).toBeVisible({ timeout: 5000 });

  await page.getByRole("button", { name: "Hopp over" }).click();
  await expect(page.getByTestId("morning-prompt")).not.toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("dashboard")).toBeVisible();
});
