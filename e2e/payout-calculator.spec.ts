import { test, expect, type Page } from '@playwright/test';
import { seedIndexedDB, DEFAULT_SEED } from './fixtures';

test.beforeEach(async ({ page }) => {
  await seedIndexedDB(page, DEFAULT_SEED);
  await page.goto('/payout');
  await page.waitForSelector('text=Total Amount');
});

async function setPersonPct(page: Page, name: string, pct: string) {
  const rows = page
    .locator('div.divide-y > div')
    .filter({ has: page.locator('input[placeholder="Name"]') });
  const names = await rows
    .locator('input[placeholder="Name"]')
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
  const index = names.findIndex((value) => value.toLowerCase() === name.toLowerCase());
  if (index === -1) {
    throw new Error(`No split row named "${name}". Rows: ${names.join(', ')}`);
  }
  await rows.nth(index).locator('input[placeholder="0"]').fill(pct);
}

test('shows warning when percentages do not sum to 100%', async ({ page }) => {
  await page.getByLabel('Total Amount').fill('10000');

  await setPersonPct(page, 'Savings', '50');
  await setPersonPct(page, 'Gy', '20');
  await setPersonPct(page, 'John', '10');
  await setPersonPct(page, 'Sona', '5');
  await setPersonPct(page, 'Daryl', '5');

  const warningSection = page.locator('section.rounded-xl').filter({ hasText: 'Total:' });
  await expect(warningSection).toContainText('90.0%');
  await expect(warningSection).toContainText('should be 100%');
  await expect(warningSection.getByText('should be 100%')).toBeVisible();
});

test('warning clears and output table shows correct amounts when corrected', async ({ page }) => {
  await page.getByLabel('Total Amount').fill('10000');

  await setPersonPct(page, 'Savings', '50');
  await setPersonPct(page, 'Gy', '25');
  await setPersonPct(page, 'John', '10');
  await setPersonPct(page, 'Sona', '5');
  await setPersonPct(page, 'Daryl', '5');

  await setPersonPct(page, 'Daryl', '10');

  const warningSection = page.locator('section.rounded-xl').filter({ hasText: 'Total:' });
  await expect(warningSection.getByText('should be 100%')).toHaveCount(0);

  const outputSection = page
    .locator('section.rounded-xl')
    .filter({ has: page.getByRole('heading', { name: 'Output', exact: true }) });
  const outputTable = outputSection.locator('table');
  const outputRows = (await outputTable.isVisible())
    ? outputTable.locator('tbody tr')
    : outputSection.locator('div.divide-y > div').filter({ visible: true });

  const expected = [
    ['Savings', '₱5,000.00'],
    ['Gy', '₱2,500.00'],
    ['John', '₱1,000.00'],
    ['Sona', '₱500.00'],
    ['Daryl', '₱1,000.00'],
  ] as const;

  for (const [person, amount] of expected) {
    const row = outputRows.filter({ hasText: person });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(person);
    await expect(row).toContainText(amount);
  }
});

test('payout persists after page reload', async ({ page }) => {
  await page.getByLabel('Total Amount').fill('10000');
  await setPersonPct(page, 'Savings', '50');
  await setPersonPct(page, 'Gy', '25');
  await setPersonPct(page, 'John', '10');
  await setPersonPct(page, 'Sona', '5');
  await setPersonPct(page, 'Daryl', '10');

  await page.getByRole('button', { name: 'Save Payout' }).click();
  await expect(page.getByText('✓ Saved!')).toBeVisible();

  await page.reload();
  await page.waitForSelector('text=Total Amount');

  const payouts = await page.evaluate(() => {
    return new Promise<unknown[]>((resolve, reject) => {
      const req = indexedDB.open('expense-tracker-db');
      req.onsuccess = (ev) => {
        const db = (ev.target as IDBOpenDBRequest).result;
        const tx = db.transaction('payouts', 'readonly');
        const store = tx.objectStore('payouts');
        const getAll = store.getAll();
        getAll.onsuccess = () => {
          db.close();
          resolve(getAll.result);
        };
        getAll.onerror = () => reject(getAll.error);
      };
      req.onerror = () => reject(req.error);
    });
  });

  expect(payouts).toHaveLength(1);
  const payout = payouts[0] as { totalAmount: number; splits: Array<{ person: string; value: number }> };
  expect(payout.totalAmount).toBe(10000);

  const savingsSplit = payout.splits.find((s: { person: string }) => s.person === 'Savings');
  expect(savingsSplit?.value).toBe(50);
});
