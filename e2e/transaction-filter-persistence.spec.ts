import { test, expect } from '@playwright/test';

// `playwright.config.ts` runs this suite against `next dev`.
// `playwright.prod.config.ts` builds `out/` and serves the static export
// (`npm run test:e2e:prod`).

test('selecting a type filter mirrors to storage and restores after tab navigation', async ({ page }) => {
  const mobile = (page.viewportSize()?.width ?? 1280) < 768;
  await page.goto('/transactions/');
  const expenseChip = page.getByRole('button', { name: 'Expense', exact: true }).filter({ visible: true });
  await expect(expenseChip).toHaveAttribute('aria-pressed', 'true');

  await expenseChip.click();
  await expect(expenseChip).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => new URL(page.url()).searchParams.get('type')).toBe('income,transaction');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('transactions_filters'))).toBe('type=income%2Ctransaction');

  await page.getByRole(mobile ? 'button' : 'link', { name: 'Settings', exact: true }).filter({ visible: true }).click();
  await expect.poll(() => new URL(page.url()).pathname.replace(/\/+$/, '')).toBe('/settings');

  await page.getByRole(mobile ? 'button' : 'link', { name: 'Transactions', exact: true }).filter({ visible: true }).click();
  await expect.poll(() => new URL(page.url()).pathname.replace(/\/+$/, '')).toBe('/transactions');
  await expect.poll(() => new URL(page.url()).searchParams.get('type')).toBe('income,transaction');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('transactions_filters'))).toBe('type=income%2Ctransaction');
  await expect(page.getByRole('button', { name: 'Expense', exact: true }).filter({ visible: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Income', exact: true }).filter({ visible: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Transfer', exact: true }).filter({ visible: true })).toHaveAttribute('aria-pressed', 'true');
});

test('clears direct URL filters and keeps them cleared after reload', async ({ page }) => {
  await page.goto('/transactions/?month=2026-06&q=direct');
  const search = page.getByRole('textbox', { name: 'Search transactions' }).filter({ visible: true });
  await expect(search).toHaveValue('direct');
  await page.getByRole('button', { name: 'Clear all', exact: true }).filter({ visible: true }).click();
  await expect.poll(() => new URL(page.url()).search).toBe('');
  await expect(search).toHaveValue('');
  await page.reload();
  await expect(search).toHaveValue('');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('transactions_filters'))).toBeNull();
});

test('removes the last direct search pill without restoring it', async ({ page }) => {
  await page.goto('/transactions/?q=direct');
  await page.getByRole('button', { name: 'Remove search filter' }).filter({ visible: true }).click();
  await expect.poll(() => new URL(page.url()).search).toBe('');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Search transactions' }).filter({ visible: true })).toHaveValue('');
});

for (const mobile of [false, true]) {
  test(`tab return restores only saved filters from a direct URL (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/transactions/?month=2026-06&q=direct&group=date&page=3&unrelated=extra');
    await expect(page.getByRole('textbox', { name: 'Search transactions' }).filter({ visible: true })).toHaveValue('direct');
    await expect.poll(() => new URL(page.url()).search).toBe('?month=2026-06&q=direct&group=date&unrelated=extra');
    await page.getByRole(mobile ? 'button' : 'link', { name: 'Settings', exact: true }).filter({ visible: true }).click();
    await page.getByRole(mobile ? 'button' : 'link', { name: 'Transactions', exact: true }).filter({ visible: true }).click();
    await expect.poll(() => new URL(page.url()).search).toBe('?month=2026-06&q=direct');
  });
}
