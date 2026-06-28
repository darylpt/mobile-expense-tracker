// ============================================================
// E2E: Budget target persistence (§2.5)
//
// Verifies that setting a budget target via the inline editor
// persists across page reloads.
// ============================================================

import { test, expect } from '@playwright/test';
import { seedIndexedDB, DEFAULT_SEED } from './fixtures';

test.beforeEach(async ({ page }) => {
  await seedIndexedDB(page, DEFAULT_SEED);
  await page.goto('/');
  // Ensure app is fully rendered
  await page.waitForSelector('text=Quick Add');
  await page.waitForSelector('text=Expenses Breakdown');
});

test('budget target persists after page reload', async ({ page }) => {
  // Click "Edit Budgets" to open the inline editor
  await page.getByRole('button', { name: 'Edit Budgets' }).click();
  await page.waitForSelector('text=Budget Targets');

  // The only expense category in seed data is "Food"
  // Set a budget target of 5000 for Food
  const foodInput = page.locator('input[type="number"]').first();
  await foodInput.fill('5000');

  // Save
  await page.getByRole('button', { name: 'Save Budgets' }).click();

  // Reload the page
  await page.reload();
  await page.waitForSelector('text=Expenses Breakdown');

  // Open the budget editor again
  await page.getByRole('button', { name: 'Edit Budgets' }).click();
  await page.waitForSelector('text=Budget Targets');

  // Assert the value persisted
  const reloadedInput = page.locator('input[type="number"]').first();
  await expect(reloadedInput).toHaveValue('5000');
});
