// ============================================================
// E2E: Settings delete-blocked-if-in-use (§2.2)
//
// Ensures accounts and categories referenced by existing
// transactions cannot be deleted, while unreferenced ones can.
// ============================================================

import { test, expect, type Page } from '@playwright/test';
import { seedIndexedDB, DEFAULT_SEED } from './fixtures';

test.beforeEach(async ({ page }) => {
  await seedIndexedDB(page, DEFAULT_SEED);
  await page.goto('/settings');
  // Wait for settings page to render fully
  await page.waitForSelector('text=Accounts');
  await page.waitForSelector('text=Categories');
});

// ── Helpers ─────────────────────────────────────────────────

/** Click the Delete button for a table row containing the given name. */
async function clickDelete(page: Page, name: string) {
  const row = page.locator('table').locator('tr', { has: page.locator('td', { hasText: name }) });
  await row.locator('button:has-text("Delete")').click();
}

/** Check if a table row with the given name exists in the visible DOM. */
async function rowExists(page: Page, name: string): Promise<boolean> {
  return (await page.locator('table').locator('tr', { has: page.locator('td', { hasText: name }) }).count()) > 0;
}

// ── Tests ──────────────────────────────────────────────────

test('delete referenced account shows warning and does not remove row', async ({ page }) => {
  // Bank A is referenced by seed transactions (income + transfer)
  await clickDelete(page, 'Bank A');

  // Amber warning should appear
  await expect(page.locator('[role="status"]')).toBeVisible();
  await expect(page.locator('[role="status"]')).toContainText('Cannot delete');

  // Row should still be present
  expect(await rowExists(page, 'Bank A')).toBe(true);
});

test('delete referenced category shows warning and does not remove row', async ({ page }) => {
  // "Food" is referenced by a seed expense transaction
  await clickDelete(page, 'Food');

  // Amber warning should appear
  await expect(page.locator('[role="status"]')).toBeVisible();
  await expect(page.locator('[role="status"]')).toContainText('Cannot delete');

  // Row should still be present
  expect(await rowExists(page, 'Food')).toBe(true);
});

test('delete unreferenced account succeeds', async ({ page }) => {
  // Gcash is NOT referenced by any seed transaction
  expect(await rowExists(page, 'Gcash')).toBe(true);

  await clickDelete(page, 'Gcash');

  // Row should disappear
  await expect(page.locator('table').locator('tr', { has: page.locator('td', { hasText: 'Gcash' }) })).toHaveCount(0);
});

test('delete unreferenced category succeeds', async ({ page }) => {
  // "Bonus" is NOT referenced by any seed transaction
  expect(await rowExists(page, 'Bonus')).toBe(true);

  await clickDelete(page, 'Bonus');

  // Row should disappear
  await expect(page.locator('table').locator('tr', { has: page.locator('td', { hasText: 'Bonus' }) })).toHaveCount(0);
});
