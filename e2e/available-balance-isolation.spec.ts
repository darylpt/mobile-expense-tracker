import { test, expect, type Page } from '@playwright/test';
import { seedIndexedDB, type SeedData } from './fixtures';

const BALANCE_SEED: SeedData = {
  accounts: [
    { id: 'checking-fixture', name: 'Checking fixture', startingBalance: 1000 },
    { id: 'savings-fixture', name: 'Savings fixture', startingBalance: 500 },
    { id: 'cash', name: 'Cash', startingBalance: 2000 },
  ],
  categories: [],
  transactions: [],
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'tab_prefs',
      JSON.stringify({ showBalances: true, showPayout: false, showStocks: false }),
    );
  });

  await seedIndexedDB(page, BALANCE_SEED);
  await page.goto('/available-balance');
  await expect(page.getByRole('heading', { name: 'Available Balance' })).toBeVisible();
  await expect(page.getByText('Checking fixture', { exact: true }).filter({ visible: true })).toBeVisible();
});

function visibleCurrentBalance(page: Page, accountName: string) {
  return page
    .getByLabel(`Current balance for ${accountName}`)
    .filter({ visible: true });
}

function visibleDenominationInput(page: Page, label: string) {
  return page
    .getByText(label, { exact: true })
    .filter({ visible: true })
    .locator('xpath=..')
    .getByRole('spinbutton');
}

async function navigateTo(page: Page, label: 'Summary' | 'Balances') {
  const isMobile = (page.viewportSize()?.width ?? 1280) < 768;
  const control = page.getByRole(isMobile ? 'button' : 'link', {
    name: label,
    exact: true,
  });
  await control.click();
}

test('plain balances, sub-splits and cash denominations survive navigation and reload', async ({ page }) => {
  const checking = visibleCurrentBalance(page, 'Checking fixture');
  await checking.fill('1234.56');
  await expect(checking).toHaveValue('1234.56');

  const savings = page.getByText('Savings fixture', { exact: true }).filter({ visible: true }).locator('xpath=..');
  await savings.getByRole('button', { name: 'Enable sub-split' }).click();
  await savings.getByLabel('Sub-split label').first().fill('Emergency fund');
  await savings.getByLabel('Sub-split amount').first().fill('300');
  await expect(savings.getByLabel('Sub-split amount').first()).toHaveValue('300');

  await visibleDenominationInput(page, '₱1,000').fill('2');
  await visibleDenominationInput(page, '₱500').fill('1');
  await page.getByRole('button', { name: 'Save Snapshot', exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole('button', { name: 'Saved!', exact: true }).filter({ visible: true })).toBeVisible();

  await navigateTo(page, 'Summary');
  await expect(page.getByRole('heading', { name: 'Expense Tracker' })).toBeVisible();
  await navigateTo(page, 'Balances');

  await expect(visibleCurrentBalance(page, 'Checking fixture')).toHaveValue('1234.56');
  const savingsAfterNavigation = page.getByText('Savings fixture', { exact: true }).filter({ visible: true }).locator('xpath=..');
  await expect(savingsAfterNavigation.getByLabel('Sub-split label').first()).toHaveValue('Emergency fund');
  await expect(savingsAfterNavigation.getByLabel('Sub-split amount').first()).toHaveValue('300');
  await expect(visibleDenominationInput(page, '₱1,000')).toHaveValue('2');
  await expect(visibleDenominationInput(page, '₱500')).toHaveValue('1');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Available Balance' })).toBeVisible();
  await expect(visibleCurrentBalance(page, 'Checking fixture')).toHaveValue('1234.56');
  const savingsAfterReload = page.getByText('Savings fixture', { exact: true }).filter({ visible: true }).locator('xpath=..');
  await expect(savingsAfterReload.getByLabel('Sub-split label').first()).toHaveValue('Emergency fund');
  await expect(savingsAfterReload.getByLabel('Sub-split amount').first()).toHaveValue('300');
  await expect(visibleDenominationInput(page, '₱1,000')).toHaveValue('2');
  await expect(visibleDenominationInput(page, '₱500')).toHaveValue('1');
});
