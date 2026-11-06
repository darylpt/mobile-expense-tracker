import { test, expect } from '@playwright/test';
import { seedIndexedDB, DEFAULT_SEED } from './fixtures';

test.beforeEach(async ({ page }) => {
  await seedIndexedDB(page, DEFAULT_SEED);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Edit Budgets' })).toBeVisible();
});

test('budget target persists after page reload', async ({ page }) => {
  await page.getByRole('button', { name: 'Edit Budgets' }).click();
  await expect(page.getByRole('heading', { name: 'Budget Targets' })).toBeVisible();

  const budgetInput = page
    .getByRole('heading', { name: 'Budget Targets' })
    .locator('xpath=..')
    .locator('input[type="number"]')
    .first();
  await budgetInput.fill('5000');

  await page.getByRole('button', { name: 'Save Budgets' }).click();
  await expect(page.getByRole('button', { name: 'Edit Budgets' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('button', { name: 'Edit Budgets' })).toBeVisible();

  await page.getByRole('button', { name: 'Edit Budgets' }).click();
  await expect(page.getByRole('heading', { name: 'Budget Targets' })).toBeVisible();

  await expect(budgetInput).toHaveValue('5000');
});
