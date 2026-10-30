// ============================================================
// E2E: Settings orphan-review deep link
//
// Guards `/settings#orphan-review`: the page must hydrate without
// a server/client mismatch, and the deep link must scroll the
// Missing Account Review section into view.
// ============================================================

import { test, expect } from '@playwright/test';

// Short enough that the review section starts below the fold, so the
// viewport assertion fails unless the deep link actually scrolls.
test.use({ viewport: { width: 1280, height: 600 } });

test('deep link reveals the review section without hydration errors', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));

  await page.goto('/settings#orphan-review');

  const review = page.locator('#orphan-review');
  await expect(review).toBeVisible();
  await expect(review.getByRole('heading', { name: 'Missing Account Review' })).toBeInViewport();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  expect(problems.filter((text) => /hydrat|did not match|server-rendered/i.test(text))).toEqual([]);
});
