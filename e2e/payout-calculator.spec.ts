// ============================================================
// E2E: Payout calculator (§2.3)
//
// Verifies validation warnings appear when percentages don't
// sum to 100%, clear when corrected, and that saved payouts
// persist across page reloads.
// ============================================================

import { test, expect, type Page } from '@playwright/test';
import { seedIndexedDB, DEFAULT_SEED } from './fixtures';

test.beforeEach(async ({ page }) => {
  await seedIndexedDB(page, DEFAULT_SEED);
  await page.goto('/payout');
  // Wait for the payout page to render
  await page.waitForSelector('text=Total Amount');
});

// ── Helpers ─────────────────────────────────────────────────

/**
 * Set the percentage for a person row by finding the row that
 * contains the given name as its Person input value.
 */
async function setPersonPct(page: Page, name: string, pct: string) {
  // Find the row whose Person input has the given value
  const row = page.locator('div.rounded-xl.overflow-hidden div.divide-y > div').filter({
    has: page.locator('input[placeholder="Name"]'),
  });
  // Iterate rows to find the one with matching name
  const count = await row.count();
  for (let i = 0; i < count; i++) {
    const nameInput = row.nth(i).locator('input[placeholder="Name"]');
    const val = await nameInput.inputValue();
    if (val.toLowerCase() === name.toLowerCase()) {
      const pctInput = row.nth(i).locator('input[placeholder="0"]').first();
      await pctInput.fill(pct);
      return;
    }
  }
  // If not found, fill the first empty name input and its percentage
  for (let i = 0; i < count; i++) {
    const nameInput = row.nth(i).locator('input[placeholder="Name"]');
    const val = await nameInput.inputValue();
    if (val === '') {
      await nameInput.fill(name);
      const pctInput = row.nth(i).locator('input[placeholder="0"]').first();
      await pctInput.fill(pct);
      return;
    }
  }
}

// ── Tests ──────────────────────────────────────────────────

test('shows warning when percentages do not sum to 100%', async ({ page }) => {
  // Enter a total amount
  await page.getByLabel('Total Amount').fill('10000');

  // Default names exist (Savings, Gy, John, Sona, Daryl) — all at 0%
  // Setting values that DON'T sum to 100: 50 + 20 + 10 + 5 + 5 = 90
  await setPersonPct(page, 'Savings', '50');
  await setPersonPct(page, 'Gy', '20');
  await setPersonPct(page, 'John', '10');
  await setPersonPct(page, 'Sona', '5');
  await setPersonPct(page, 'Daryl', '5');

  // Assert the amber warning appears
  const warningSection = page.locator('section.rounded-xl').filter({ hasText: 'Total:' });
  await expect(warningSection).toContainText('90.0%');
  await expect(warningSection).toContainText('should be 100%');
});

test('warning clears and output table shows correct amounts when corrected', async ({ page }) => {
  await page.getByLabel('Total Amount').fill('10000');

  // First set values that don't sum to 100
  await setPersonPct(page, 'Savings', '50');
  await setPersonPct(page, 'Gy', '25');
  await setPersonPct(page, 'John', '10');
  await setPersonPct(page, 'Sona', '5');
  await setPersonPct(page, 'Daryl', '5');
  // total = 95 — warning should show

  // Correct: 50 + 25 + 10 + 5 + 10 = 100
  await setPersonPct(page, 'Daryl', '10');

  // Warning should be gone — the validation section should NOT contain "should be 100%"
  const warningSection = page.locator('section.rounded-xl').filter({ hasText: 'Total:' });
  await expect(warningSection).not.toContainText('should be 100%');

  // Assert output table shows correct amounts
  // Savings: 50% of 10000 = 5000, Gy: 25% = 2500, John: 10% = 1000, Sona: 5% = 500, Daryl: 10% = 1000
  const outputRows = page.locator('table').last().locator('tbody tr');
  await expect(outputRows.nth(0)).toContainText('₱5,000.00');
  await expect(outputRows.nth(1)).toContainText('₱2,500.00');
  await expect(outputRows.nth(2)).toContainText('₱1,000.00');
  await expect(outputRows.nth(3)).toContainText('₱500.00');
  await expect(outputRows.nth(4)).toContainText('₱1,000.00');
});

test('payout persists after page reload', async ({ page }) => {
  // Fill a valid payout
  await page.getByLabel('Total Amount').fill('10000');
  await setPersonPct(page, 'Savings', '50');
  await setPersonPct(page, 'Gy', '25');
  await setPersonPct(page, 'John', '10');
  await setPersonPct(page, 'Sona', '5');
  await setPersonPct(page, 'Daryl', '10');

  // Save
  await page.getByRole('button', { name: 'Save Payout' }).click();
  // Wait for "✓ Saved!" confirmation
  await expect(page.getByText('✓ Saved!')).toBeVisible();

  // Reload
  await page.reload();
  await page.waitForSelector('text=Total Amount');

  // Check IndexedDB directly for the saved payout
  const payouts = await page.evaluate(() => {
    return new Promise<unknown[]>((resolve, reject) => {
      const req = indexedDB.open('expense-tracker-db', 4);
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

  // Verify a split persisted
  const savingsSplit = payout.splits.find((s: { person: string }) => s.person === 'Savings');
  expect(savingsSplit?.value).toBe(50);
});
