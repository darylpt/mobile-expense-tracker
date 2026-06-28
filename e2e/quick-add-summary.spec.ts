// ============================================================
// E2E: Quick Add → Summary sync (§2.1)
//
// Verifies that adding an income, expense, or transfer via
// the Quick Add form correctly updates the summary cards and
// accounts table in real time.
// ============================================================

import { test, expect } from '@playwright/test';
import { seedIndexedDB, DEFAULT_SEED, parseCurrency } from './fixtures';

test.beforeEach(async ({ page }) => {
  await seedIndexedDB(page, DEFAULT_SEED);
  await page.goto('/');
  // Wait for the app to fully render the Quick Add form
  await page.waitForSelector('text=Quick Add');
  // Wait for summary to finish loading (Income card visible)
  await page.waitForSelector('text=Income');
});

// ── Helpers ─────────────────────────────────────────────────

/** Return the amount text from a summary card identified by its heading. */
async function summaryCardAmount(page: any, heading: string): Promise<string> {
  const card = page.locator(`div.rounded-lg:has(p:text-is("${heading}"))`).first();
  return (await card.locator('p.font-bold').textContent()) ?? '';
}

/** Return the entry-count text from a summary card. */
async function summaryCardCount(page: any, heading: string): Promise<string> {
  const card = page.locator(`div.rounded-lg:has(p:text-is("${heading}"))`).first();
  return (await card.locator('p.text-xs').first().textContent()) ?? '';
}

/**
 * Fill the Quick Add form and submit.
 * `fields` must use account IDs for fromAccount/toAccount.
 */
async function addTransaction(
  page: any,
  fields: { type: string; amount: string; category?: string; fromAccount?: string; toAccount?: string },
) {
  await page.getByLabel('Type').selectOption(fields.type);
  // Type change auto-selects first category — wait for re-render
  await page.waitForTimeout(100);
  await page.getByLabel('Amount').fill(fields.amount);

  if (fields.toAccount) {
    await page.getByLabel('To Account').selectOption(fields.toAccount);
  }
  if (fields.fromAccount) {
    await page.getByLabel('From Account').selectOption(fields.fromAccount);
  }

  await page.getByRole('button', { name: 'Add Transaction' }).click();
  // Wait for the form to reset (success indicator)
  await expect(page.getByLabel('Amount')).toHaveValue('');
}

/** Return a specific cell value from the Accounts table for a given account name and column index. */
async function accountCell(page: any, accountName: string, colIndex: number): Promise<string> {
  const row = page
    .locator('table')
    .first()
    .locator('tbody tr:has(td:first-child:text-is("' + accountName + '"))');
  return (await row.locator('td').nth(colIndex).textContent()) ?? '';
}

// ── Tests ──────────────────────────────────────────────────

test('add income → Income summary card updates', async ({ page }) => {
  // Capture initial Income state
  const initialAmount = parseCurrency(await summaryCardAmount(page, 'Income'));
  const initialCountText = await summaryCardCount(page, 'Income');

  // Add an income transaction
  await addTransaction(page, {
    type: 'income',
    amount: '1000',
    toAccount: 'bank-a',
  });

  // Re-read and assert
  const newAmount = parseCurrency(await summaryCardAmount(page, 'Income'));
  const newCountText = await summaryCardCount(page, 'Income');

  expect(newAmount).toBe(initialAmount + 1000);
  expect(newCountText).not.toBe(initialCountText); // count increased
});

test('add expense → Expenses card & account row update', async ({ page }) => {
  // Capture initial Expenses state
  const initialExpAmount = parseCurrency(await summaryCardAmount(page, 'Expenses'));
  const initialCashOutflow = parseCurrency(await accountCell(page, 'Cash', 3)); // outflow = col 3

  // Add an expense
  await addTransaction(page, {
    type: 'expense',
    amount: '200',
    fromAccount: 'cash',
  });

  // Assert Expenses card
  const newExpAmount = parseCurrency(await summaryCardAmount(page, 'Expenses'));
  expect(newExpAmount).toBe(initialExpAmount + 200);

  // Assert Cash row outflow increased
  const newCashOutflow = parseCurrency(await accountCell(page, 'Cash', 3));
  expect(newCashOutflow).toBe(initialCashOutflow + 200);
});

test('add transfer → both account rows update', async ({ page }) => {
  // Capture initial account states
  const bankAInflow0 = parseCurrency(await accountCell(page, 'Bank A', 2)); // inflow
  const bankAOutflow0 = parseCurrency(await accountCell(page, 'Bank A', 3)); // outflow
  const bankBInflow0 = parseCurrency(await accountCell(page, 'Bank B', 2));
  const bankBOutflow0 = parseCurrency(await accountCell(page, 'Bank B', 3));

  // Add a transfer
  await addTransaction(page, {
    type: 'transaction',
    amount: '500',
    fromAccount: 'bank-a',
    toAccount: 'bank-b',
  });

  // Assert Bank A outflow increased
  const bankAOutflow1 = parseCurrency(await accountCell(page, 'Bank A', 3));
  expect(bankAOutflow1).toBe(bankAOutflow0 + 500);

  // Assert Bank A inflow unchanged
  const bankAInflow1 = parseCurrency(await accountCell(page, 'Bank A', 2));
  expect(bankAInflow1).toBe(bankAInflow0);

  // Assert Bank B inflow increased
  const bankBInflow1 = parseCurrency(await accountCell(page, 'Bank B', 2));
  expect(bankBInflow1).toBe(bankBInflow0 + 500);

  // Assert Bank B outflow unchanged
  const bankBOutflow1 = parseCurrency(await accountCell(page, 'Bank B', 3));
  expect(bankBOutflow1).toBe(bankBOutflow0);
});
