import { test, expect } from '@playwright/test';

// Run against the production static export as well as the development server.
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
