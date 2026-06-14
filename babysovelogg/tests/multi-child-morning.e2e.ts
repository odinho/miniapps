import {
  test,
  expect,
  createBaby,
  addCompletedSleep,
  fillTimeInput,
} from "./fixtures";

/** Give a baby a derived morning wake by logging the overnight that ended at
 *  `hhmm` today (the same signal production reads). */
function logOvernightWake(babyId: number, hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const end = new Date();
  end.setHours(h, m, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 1);
  start.setHours(19, 0, 0, 0);
  addCompletedSleep(babyId, start.toISOString(), end.toISOString(), "night");
}

// The default `test` fixture forces the clock to 08:00 (autoMorning), so the
// morning-prompt time gate is open for every test here.

type StateBaby = { baby: { name: string }; todayWakeUp: { wake_time: string } | null };

async function wakeTimes(request: { get: (url: string) => Promise<{ json: () => Promise<unknown> }> }) {
  const state = (await (await request.get("/api/state")).json()) as { babies: StateBaby[] };
  return Object.fromEntries(
    state.babies.map((b) => [
      b.baby.name,
      b.todayWakeUp ? new Date(b.todayWakeUp.wake_time).toTimeString().slice(0, 5) : null,
    ]),
  );
}

test("family morning prompt sets one wake time for both children at once", async ({ page, request }) => {
  createBaby("Ada", "2025-06-12");
  createBaby("Bo", "2025-06-12");

  await page.goto("/");
  const prompt = page.getByTestId("family-morning-prompt");
  await expect(prompt).toBeVisible({ timeout: 5000 });
  await expect(prompt).toContainText("Ada");
  await expect(prompt).toContainText("Bo");

  await fillTimeInput(page.getByTestId("family-morning-time"), "06:45");
  await page.getByRole("button", { name: "Sett vaknetid" }).click();

  await expect(prompt).not.toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("family-home")).toBeVisible();
  expect(await wakeTimes(request)).toEqual({ Ada: "06:45", Bo: "06:45" });
});

test("family morning prompt only sets the child who still needs it; logged child stays put", async ({
  page,
  request,
}) => {
  const ada = createBaby("Ada", "2025-06-12");
  createBaby("Bo", "2025-06-12");
  logOvernightWake(ada, "06:30");

  await page.goto("/");
  const prompt = page.getByTestId("family-morning-prompt");
  await expect(prompt).toBeVisible({ timeout: 5000 });

  await fillTimeInput(page.getByTestId("family-morning-time"), "07:15");
  await page.getByRole("button", { name: "Sett vaknetid" }).click();

  await expect(prompt).not.toBeVisible({ timeout: 5000 });
  expect(await wakeTimes(request)).toEqual({ Ada: "06:30", Bo: "07:15" });
});

test("family morning prompt supports per-child times via 'ulik tid?'", async ({ page, request }) => {
  createBaby("Ada", "2025-06-12");
  createBaby("Bo", "2025-06-12");

  await page.goto("/");
  await expect(page.getByTestId("family-morning-prompt")).toBeVisible({ timeout: 5000 });

  await page.getByRole("button", { name: "Ulik tid?" }).click();
  await fillTimeInput(page.getByTestId("family-morning-time-1"), "06:30");
  await fillTimeInput(page.getByTestId("family-morning-time-2"), "07:30");
  await page.getByRole("button", { name: "Sett vaknetid" }).click();

  await expect(page.getByTestId("family-morning-prompt")).not.toBeVisible({ timeout: 5000 });
  expect(await wakeTimes(request)).toEqual({ Ada: "06:30", Bo: "07:30" });
});

test("family morning prompt can be skipped without setting times", async ({ page, request }) => {
  createBaby("Ada", "2025-06-12");
  createBaby("Bo", "2025-06-12");

  await page.goto("/");
  await expect(page.getByTestId("family-morning-prompt")).toBeVisible({ timeout: 5000 });

  await page.getByRole("button", { name: "Hopp over" }).click();
  await expect(page.getByTestId("family-morning-prompt")).not.toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("family-home")).toBeVisible();
  expect(await wakeTimes(request)).toEqual({ Ada: null, Bo: null });
});

test("mixed-age siblings still get the combined morning prompt", async ({ page }) => {
  createBaby("Storebror", "2023-01-01");
  createBaby("Lillesøster", "2025-06-12");

  await page.goto("/");
  const prompt = page.getByTestId("family-morning-prompt");
  await expect(prompt).toBeVisible({ timeout: 5000 });
  await expect(prompt).toContainText("Storebror");
  await expect(prompt).toContainText("Lillesøster");
});

test("single child keeps the original (non-family) morning prompt", async ({ page }) => {
  createBaby("Ada", "2025-06-12");

  await page.goto("/");
  await expect(page.getByTestId("morning-prompt")).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("family-morning-prompt")).not.toBeVisible();
});

test("focused per-child view uses the single prompt, not the family one", async ({ page }) => {
  const ada = createBaby("Ada", "2025-06-12");
  createBaby("Bo", "2025-06-12");

  await page.goto(`/?baby=${ada}`);
  await expect(page.getByTestId("morning-prompt")).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("family-morning-prompt")).not.toBeVisible();
});
