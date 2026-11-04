// ============================================================
// E2E: Quick Add → Summary sync (§2.1)
//
// Verifies that adding an income, expense, or transfer via
// the Quick Add form correctly updates the summary cards and
// accounts table in real time.
// ============================================================

import { test, expect, type Page } from '@playwright/test';
import { seedIndexedDB, DEFAULT_SEED, parseCurrency } from './fixtures';

async function openDashboard(page: Page) {
  await page.goto('/');
  await page.locator('#quick-add-panel').waitFor({ state: 'attached' });
  await expect(page.getByLabel('Category').locator('option[value="Food"]')).toHaveCount(1);
  await expect(page.getByLabel('From Account').locator('option[value="cash"]')).toHaveCount(1);
}

async function ensureQuickAddOpen(page: Page) {
  const toggle = page.locator('button[aria-controls="quick-add-panel"]');
  if (await toggle.isVisible() && (await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click();
  }
}

/** Return the amount text from a summary card identified by its heading. */
async function summaryCardAmount(page: Page, heading: string): Promise<string> {
  const card = page.locator(`div.rounded-lg:has(p:text-is("${heading}"))`).first();
  return (await card.locator('p.font-semibold').textContent()) ?? '';
}

/** Return the entry-count text from a summary card. */
async function summaryCardCount(page: Page, heading: string): Promise<string> {
  const card = page.locator(`div.rounded-lg:has(p:text-is("${heading}"))`).first();
  return (await card.locator('p.text-xs').last().textContent()) ?? '';
}

/**
 * Fill the Quick Add form and submit.
 * `fields` must use account IDs for fromAccount/toAccount.
 */
async function addTransaction(
  page: Page,
  fields: { type: string; amount: string; category?: string; fromAccount?: string; toAccount?: string },
) {
  await ensureQuickAddOpen(page);
  await page.getByLabel('Type').selectOption(fields.type);
  // Type change auto-selects first category — wait for re-render
  await page.waitForTimeout(100);
  await page.getByRole('spinbutton', { name: 'Amount' }).fill(fields.amount);

  if (fields.toAccount) {
    await page.getByLabel('To Account').selectOption(fields.toAccount);
  }
  if (fields.fromAccount) {
    await page.getByLabel('From Account').selectOption(fields.fromAccount);
  }

  await page.getByRole('button', { name: 'Add Transaction' }).click();
  const toggle = page.locator('button[aria-controls="quick-add-panel"]');
  if (await toggle.isVisible()) {
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  } else {
    await expect(page.getByRole('spinbutton', { name: 'Amount' })).toHaveValue('');
  }
}

/** Return a specific cell value from the Accounts table for a given account name and column index. */
async function accountCell(page: Page, accountName: string, colIndex: number): Promise<string> {
  const row = page
    .locator('table')
    .first()
    .locator('tbody tr:has(td:first-child:text-is("' + accountName + '"))');
  return (await row.locator('td').nth(colIndex).textContent()) ?? '';
}

test.describe('Quick Add → Summary sync', () => {
  test.beforeEach(async ({ page }) => {
    await seedIndexedDB(page, DEFAULT_SEED);
    await openDashboard(page);
  });

  test('add income → Income summary card updates', async ({ page }) => {
    const initialAmount = parseCurrency(await summaryCardAmount(page, 'Income'));
    const initialCountText = await summaryCardCount(page, 'Income');

    await addTransaction(page, {
      type: 'income',
      amount: '1000',
      toAccount: 'bank-a',
    });

    const newAmount = parseCurrency(await summaryCardAmount(page, 'Income'));
    const newCountText = await summaryCardCount(page, 'Income');

    expect(newAmount).toBe(initialAmount + 1000);
    expect(newCountText).not.toBe(initialCountText);
  });

  test('add expense → Expenses card & account row update', async ({ page }) => {
    const initialExpAmount = parseCurrency(await summaryCardAmount(page, 'Expenses'));
    const initialCashOutflow = parseCurrency(await accountCell(page, 'Cash', 3));

    await addTransaction(page, {
      type: 'expense',
      amount: '200',
      fromAccount: 'cash',
    });

    const newExpAmount = parseCurrency(await summaryCardAmount(page, 'Expenses'));
    expect(newExpAmount).toBe(initialExpAmount + 200);

    const newCashOutflow = parseCurrency(await accountCell(page, 'Cash', 3));
    expect(newCashOutflow).toBe(initialCashOutflow + 200);
  });

  test('add transfer → both account rows update', async ({ page }) => {
    const bankAInflow0 = parseCurrency(await accountCell(page, 'Bank A', 2));
    const bankAOutflow0 = parseCurrency(await accountCell(page, 'Bank A', 3));
    const bankBInflow0 = parseCurrency(await accountCell(page, 'Bank B', 2));
    const bankBOutflow0 = parseCurrency(await accountCell(page, 'Bank B', 3));

    await addTransaction(page, {
      type: 'transaction',
      amount: '500',
      fromAccount: 'bank-a',
      toAccount: 'bank-b',
    });

    const bankAOutflow1 = parseCurrency(await accountCell(page, 'Bank A', 3));
    expect(bankAOutflow1).toBe(bankAOutflow0 + 500);

    const bankAInflow1 = parseCurrency(await accountCell(page, 'Bank A', 2));
    expect(bankAInflow1).toBe(bankAInflow0);

    const bankBInflow1 = parseCurrency(await accountCell(page, 'Bank B', 2));
    expect(bankBInflow1).toBe(bankBInflow0 + 500);

    const bankBOutflow1 = parseCurrency(await accountCell(page, 'Bank B', 3));
    expect(bankBOutflow1).toBe(bankBOutflow0);
  });
});

test.describe('Mobile Quick Add disclosure', () => {
  test.beforeEach(async ({ page }) => {
    await seedIndexedDB(page, DEFAULT_SEED);
    await openDashboard(page);
  });

  test('closed panel is inert, and submit returns focus to the disclosure', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 768, 'disclosure exists below the md breakpoint');

    const toggle = page.locator('button[aria-controls="quick-add-panel"]');
    const panel = page.locator('#quick-add-panel');

    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toHaveJSProperty('inert', true);

    const focusLandedInPanel = await page.evaluate(() => {
      const input = document.querySelector<HTMLElement>('#quick-add-panel input');
      input?.focus();
      return document.activeElement === input;
    });
    expect(focusLandedInPanel).toBe(false);

    await toggle.focus();
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() =>
        document.querySelector('#quick-add-panel')?.contains(document.activeElement)
      )
    ).toBe(false);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(panel).toHaveJSProperty('inert', false);

    const amount = page.getByRole('spinbutton', { name: 'Amount' });
    await expect(amount).toBeVisible();
    await amount.focus();
    await expect(amount).toBeFocused();

    await page.getByLabel('Category').selectOption('Food');
    await page.getByLabel('From Account').selectOption('cash');
    await amount.fill('125');
    await panel.getByRole('button', { name: 'Add Transaction' }).click();

    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    await expect(panel).toHaveJSProperty('inert', true);
  });
});

test.describe('Empty-state onboarding guidance', () => {
  test.beforeEach(async ({ page }) => {
    await seedIndexedDB(page, { accounts: [], categories: [], transactions: [] });
    await page.goto('/');
    await page.waitForSelector('text=No data yet');
  });

  test('guides manual setup through Settings without promising a direct import route', async ({ page }) => {
    const routes = [
      { path: '/', setup: /Add accounts and categories in Settings/ },
      { path: '/transactions', setup: /Add accounts and categories in Settings/ },
      { path: '/available-balance', setup: /Add at least one account in Settings/ },
    ];

    for (const route of routes) {
      await page.goto(route.path);
      const main = page.locator('main');

      await expect(main.getByText('No data yet').first()).toBeVisible();
      await expect(main.getByText(route.setup)).toBeVisible();
      await expect(main.getByText(/Data Tools \(Import \/ Export Data on mobile\)/)).toBeVisible();
      await expect(main.getByText(/then Import from Google Sheets/)).toBeVisible();
      await expect(main.getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', /^\/settings\/?$/);
      await expect(main.getByRole('link', { name: /import/i })).toHaveCount(0);
    }
  });
});
