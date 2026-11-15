// ============================================================
// E2E: Stocks price refresh scope isolation
//
// Runs against fresh local-only browser contexts. Phisix is intercepted so
// the suite never depends on the live community API.
// ============================================================

import { test, expect, type Page } from '@playwright/test';

const DB_NAME = 'expense-tracker-db';
const PHISIX_URL = 'https://phisix-api3.appspot.com/**';
const STOCK_ID = 'e2e00000-0000-4000-8000-000000000001';
const TRANSACTION_ID = 'e2e00000-0000-4000-8000-000000000002';

const STOCK_FIXTURE = {
  id: STOCK_ID,
  ticker: 'BDO',
  type: 'stock',
  name: 'BDO Unibank',
  currentPrice: 100,
  priceUpdatedAt: 1,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

const TRANSACTION_FIXTURE = {
  id: TRANSACTION_ID,
  stockId: STOCK_ID,
  date: '2026-01-02',
  type: 'buy',
  shares: 10,
  pricePerShare: 100,
  fees: 0,
  totalAmount: 1000,
  createdAt: 1,
  updatedAt: 1,
};

const PHISIX_BODY = JSON.stringify({
  stocks: [{ symbol: 'BDO', price: { currency: 'PHP', amount: 148.5 } }],
});

interface PersistedStockState {
  currentPrice: number | null;
  priceUpdatedAt: number | null;
  stockQueueCount: number;
}

async function seedStockFixture(page: Page): Promise<void> {
  await page.goto('/stocks');
  await expect(page.getByText('No stocks configured yet.')).toBeVisible();

  await page.evaluate(
    async ({ dbName, stock, transaction }) => {
      const opened = Promise.withResolvers<IDBDatabase>();
      const request = indexedDB.open(dbName);
      request.onsuccess = () => opened.resolve(request.result);
      request.onerror = () => opened.reject(request.error);
      const db = await opened.promise;

      try {
        const stores = ['stocks', 'stockTransactions', 'dividends', 'syncQueue'];
        const tx = db.transaction(stores, 'readwrite');
        for (const store of stores) {
          tx.objectStore(store).clear();
        }
        tx.objectStore('stocks').put(stock);
        tx.objectStore('stockTransactions').put(transaction);

        const completed = Promise.withResolvers<void>();
        tx.oncomplete = () => completed.resolve();
        tx.onerror = () => completed.reject(tx.error);
        await completed.promise;
      } finally {
        db.close();
      }
    },
    { dbName: DB_NAME, stock: STOCK_FIXTURE, transaction: TRANSACTION_FIXTURE },
  );

  await page.reload();
  await expect(page.getByRole('button', { name: 'Refresh Prices' })).toBeVisible();
  await expect(page.getByText('BDO').filter({ visible: true }).first()).toBeVisible();
}

async function readPersistedStock(page: Page): Promise<PersistedStockState> {
  return page.evaluate(
    async ({ dbName, stockId }) => {
      const open = Promise.withResolvers<IDBDatabase>();
      const request = indexedDB.open(dbName);
      request.onsuccess = () => open.resolve(request.result);
      request.onerror = () => open.reject(request.error);
      const db = await open.promise;

      try {
        const stockTx = db.transaction('stocks', 'readonly');
        const stockRequest = stockTx.objectStore('stocks').get(stockId);
        const stockOpened = Promise.withResolvers<{ currentPrice?: number | null; priceUpdatedAt?: number | null } | undefined>();
        stockRequest.onsuccess = () => stockOpened.resolve(stockRequest.result);
        stockRequest.onerror = () => stockOpened.reject(stockRequest.error);

        const queueTx = db.transaction('syncQueue', 'readonly');
        const queueRequest = queueTx.objectStore('syncQueue').getAll();
        const queueOpened = Promise.withResolvers<Array<{ storeName: string }>>();
        queueRequest.onsuccess = () => queueOpened.resolve(queueRequest.result);
        queueRequest.onerror = () => queueOpened.reject(queueRequest.error);

        const [stock, queue] = await Promise.all([stockOpened.promise, queueOpened.promise]);
        return {
          currentPrice: stock?.currentPrice ?? null,
          priceUpdatedAt: stock?.priceUpdatedAt ?? null,
          stockQueueCount: queue.filter((entry) => entry.storeName === 'stocks').length,
        };
      } finally {
        db.close();
      }
    },
    { dbName: DB_NAME, stockId: STOCK_ID },
  );
}

test.describe('stocks price refresh', () => {
  test('refresh updates and persists the price across a reload', async ({ page }) => {
    await page.route(PHISIX_URL, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: PHISIX_BODY }),
    );
    await seedStockFixture(page);

    await page.getByRole('button', { name: 'Refresh Prices' }).click();

    await expect(page.getByText('All prices updated.')).toBeVisible();
    await expect(page.getByText('₱148.50').filter({ visible: true }).first()).toBeVisible();

    await page.reload();
    await expect(page.getByRole('button', { name: 'Refresh Prices' })).toBeVisible();
    await expect(page.getByText('₱148.50').filter({ visible: true }).first()).toBeVisible();

    const persisted = await readPersistedStock(page);
    expect(persisted.currentPrice).toBe(148.5);
    expect(persisted.stockQueueCount).toBe(1);
  });

  test('work from an unmounted refresh does not update stock or enqueue sync', async ({ page }) => {
    const requestStarted = Promise.withResolvers<void>();
    const releaseResponse = Promise.withResolvers<void>();

    await page.route(PHISIX_URL, async (route) => {
      requestStarted.resolve();
      await releaseResponse.promise;
      await route.fulfill({ status: 200, contentType: 'application/json', body: PHISIX_BODY });
    });
    await seedStockFixture(page);

    const responseReceived = page.waitForResponse(
      (response) => response.url().includes('/stocks.json') && response.ok(),
    );

    await page.getByRole('button', { name: 'Refresh Prices' }).click();
    await requestStarted.promise;

    // Actual client-side navigation unmounts the Stocks page while the
    // Phisix request is still pending. Desktop navigation is link-based;
    // the mobile bottom bar exposes the same destinations as buttons.
    const summaryNav = (page.viewportSize()?.width ?? 0) >= 768
      ? page.getByRole('link', { name: 'Summary', exact: true })
      : page.getByRole('button', { name: 'Summary', exact: true });
    await expect(summaryNav).toBeVisible();
    await summaryNav.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('button', { name: 'Manage Tickers' })).toHaveCount(0);

    releaseResponse.resolve();
    await responseReceived;
    // Let the unmounted page's fetch/JSON continuations and any IDB task run
    // before inspecting durable state. There is no production hook to await
    // them directly, so yield two real browser frames.
    await page.evaluate(async () => {
      for (let frame = 0; frame < 2; frame += 1) {
        const rendered = Promise.withResolvers<void>();
        requestAnimationFrame(() => rendered.resolve());
        await rendered.promise;
      }
    });

    const afterRelease = await readPersistedStock(page);
    expect(afterRelease.currentPrice).toBe(100);
    expect(afterRelease.priceUpdatedAt).toBe(1);
    expect(afterRelease.stockQueueCount).toBe(0);

    await page.goto('/stocks');
    await expect(page.getByRole('button', { name: 'Refresh Prices' })).toBeVisible();
    await expect(page.getByText('₱100.00').filter({ visible: true }).first()).toBeVisible();

    const afterReturn = await readPersistedStock(page);
    expect(afterReturn.currentPrice).toBe(100);
    expect(afterReturn.priceUpdatedAt).toBe(1);
    expect(afterReturn.stockQueueCount).toBe(0);
  });
});
