import { test, expect, type Page } from '@playwright/test';
import { seedIndexedDB, DEFAULT_SEED } from './fixtures';

test.beforeEach(async ({ page }) => {
  await seedIndexedDB(page, DEFAULT_SEED);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { level: 1, name: /^Settings/ })).toBeVisible();
});

async function openSection(page: Page, desktopLabel: string, mobileLabel: string) {
  const control = page
    .getByRole('button', { name: desktopLabel, exact: true })
    .or(page.getByRole('button', { name: mobileLabel, exact: true }))
    .filter({ visible: true });
  await control.click();
}

function rowLocator(page: Page, name: string) {
  const desktopRow = page
    .locator('table tr')
    .filter({ has: page.getByRole('button', { name: 'Del', exact: true }) })
    .filter({ hasText: name });
  const mobileCard = page
    .getByRole('button', { name: `Delete ${name}`, exact: true })
    .locator('xpath=../..');
  return desktopRow.or(mobileCard).filter({ visible: true });
}

async function clickDelete(page: Page, name: string) {
  const row = rowLocator(page, name);
  await expect(row).toHaveCount(1);
  const desktopDelete = row.getByRole('button', { name: 'Del', exact: true });
  if ((await desktopDelete.count()) > 0) {
    await desktopDelete.click();
  } else {
    await row.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
  }
}

test('delete referenced account shows warning and does not remove row', async ({ page }) => {
  await openSection(page, 'Accounts', 'Accounts & Balances');

  await clickDelete(page, 'Bank A');

  await expect(page.locator('[role="status"]')).toBeVisible();
  await expect(page.locator('[role="status"]')).toContainText('Cannot delete');

  await expect(rowLocator(page, 'Bank A')).toHaveCount(1);
});

test('delete referenced category shows warning and does not remove row', async ({ page }) => {
  await openSection(page, 'Categories', 'Category Mapping');

  await clickDelete(page, 'Food');

  await expect(page.locator('[role="status"]')).toBeVisible();
  await expect(page.locator('[role="status"]')).toContainText('Cannot delete');

  await expect(rowLocator(page, 'Food')).toHaveCount(1);
});

test('delete unreferenced account succeeds', async ({ page }) => {
  await openSection(page, 'Accounts', 'Accounts & Balances');

  await expect(rowLocator(page, 'Gcash')).toHaveCount(1);

  await clickDelete(page, 'Gcash');

  await expect(rowLocator(page, 'Gcash')).toHaveCount(0);
});

test('delete unreferenced category succeeds', async ({ page }) => {
  await openSection(page, 'Categories', 'Category Mapping');

  await expect(rowLocator(page, 'Bonus')).toHaveCount(1);

  await clickDelete(page, 'Bonus');

  await expect(rowLocator(page, 'Bonus')).toHaveCount(0);
});
