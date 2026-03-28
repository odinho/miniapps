import { test, expect, createBaby } from "./fixtures.js";
import path from "path";
import { writeFileSync, mkdirSync } from "fs";

const NAPPER_CSV = `start,end,category,overallHappiness,babyMoodOnWakeUp,diaperWeight,diaperContent,breastLeftMinutes,breastRightMinutes,amountPumpedLeft,amountPumpedRight,feedingAmount,temperature,bottleFeedingType,comment,createdAt,pauses
2026-01-06T06:00:00.000+01:00,2026-01-06T06:00:00.000+01:00,WOKE_UP,,5,,,,,,,,,,,2026-01-07T12:25:25.998Z,
2026-01-06T09:00:00.000+01:00,2026-01-06T09:45:00.000+01:00,NAP,,5,,,,,,,,,,,2026-01-07T12:27:09.454Z,
2026-01-06T13:15:00.000+01:00,2026-01-06T14:35:00.000+01:00,NAP,,3,,,,,,,,,,,2026-01-07T12:28:38.349Z,
2026-01-06T18:26:00.000+01:00,2026-01-06T18:26:00.000+01:00,BED_TIME,,,,,,,,,,,,,2026-01-07T12:29:20.408Z,
2026-01-07T05:46:00.000+01:00,2026-01-07T05:46:00.000+01:00,WOKE_UP,,3,,,,,,,,,,,2026-01-07T12:15:15.500Z,`;

test("uploads CSV from settings page and sees imported data", async ({ page }) => {
  createBaby("Halldis", "2025-10-21");

  // Write a temp CSV file for upload
  const tmpDir = path.join(process.cwd(), "tmp-test");
  mkdirSync(tmpDir, { recursive: true });
  const csvPath = path.join(tmpDir, "napper-export.csv");
  writeFileSync(csvPath, NAPPER_CSV);

  // Navigate to settings
  await page.goto("/settings");
  await page.waitForSelector("[data-testid='napper-file-input']");

  // Upload the CSV
  const fileInput = page.getByTestId("napper-file-input");
  await fileInput.setInputFiles(csvPath);

  // Click import
  const importBtn = page.getByTestId("napper-import-btn");
  await expect(importBtn).toBeEnabled();
  await importBtn.click();

  // Should see success toast
  await expect(page.locator(".toast")).toContainText("Importerte");

  // Navigate to history and verify entries appear
  await page.goto("/history");
  await page.waitForTimeout(500);

  // Should see sleep entries in the history
  const historyItems = page.locator(".history-item, .sleep-card, [class*='history']");
  await expect(historyItems.first()).toBeVisible({ timeout: 5000 });
});
