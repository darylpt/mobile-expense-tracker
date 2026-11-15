// ============================================================
// stock-prices.test.ts — Tests for Phisix API price lookup
// ============================================================

import 'fake-indexeddb/auto';

// fake-indexeddb v6 needs structuredClone — polyfill for jsdom
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (val: unknown) => JSON.parse(JSON.stringify(val));
}

import { fetchStockPrice, refreshAllPrices } from './stock-prices';
import * as idb from './idb';
import type { SyncQueueEntry } from './idb';
import { STORES } from './constants';
import type { Stock } from '@/types';

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockFetch = jest.fn();
global.fetch = mockFetch;

// ---------------------------------------------------------------------------
// Fixtures and deferred helpers
// ---------------------------------------------------------------------------

const STOCK_A: Stock = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ticker: 'BDO',
  name: 'BDO Unibank',
  currentPrice: 100,
  priceUpdatedAt: 1,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

const STOCK_B: Stock = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ticker: 'SM',
  name: 'SM Investments',
  currentPrice: 50,
  priceUpdatedAt: 1,
  sortOrder: 1000,
  createdAt: 1,
  updatedAt: 1,
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

interface PhisixEntry {
  symbol: string;
  price: { currency: string; amount: number };
}

function deferred<T>(): Deferred<T> {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

function phisixResponse(entries: PhisixEntry[]) {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue({ stocks: entries }),
  };
}

async function clearPriceStores(): Promise<void> {
  const db = await idb.getDB();
  const tx = db.transaction([STORES.STOCKS, STORES.SYNC_QUEUE], 'readwrite');
  tx.objectStore(STORES.STOCKS).clear();
  tx.objectStore(STORES.SYNC_QUEUE).clear();
  await tx.done;
}

async function seedStocks(...stocks: Stock[]): Promise<void> {
  const db = await idb.getDB();
  const tx = db.transaction(STORES.STOCKS, 'readwrite');
  for (const stock of stocks) {
    tx.objectStore(STORES.STOCKS).put(stock);
  }
  await tx.done;
}

async function readStock(id: string): Promise<Stock | undefined> {
  const db = await idb.getDB();
  return db.get(STORES.STOCKS, id);
}

async function readStockQueue(): Promise<SyncQueueEntry[]> {
  const db = await idb.getDB();
  const entries = await db.getAll(STORES.SYNC_QUEUE);
  return entries.filter((entry) => entry.storeName === STORES.STOCKS);
}

const originalOnLine = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');

afterAll(async () => {
  const db = await idb.getDB();
  db.close();
  if (originalOnLine) {
    Object.defineProperty(window.navigator, 'onLine', originalOnLine);
  } else {
    Reflect.deleteProperty(window.navigator, 'onLine');
  }
});

// ---------------------------------------------------------------------------
// fetchStockPrice
// ---------------------------------------------------------------------------

describe('fetchStockPrice', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('parses a valid Phisix response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        stocks: [{ symbol: 'BDO', price: { currency: 'PHP', amount: 148.5 } }],
      }),
    });

    const result = await fetchStockPrice('BDO');
    expect(result).toEqual({ price: 148.5, currency: 'PHP' });
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('BDO'));
  });

  it('returns null on HTTP 429 (rate limit)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
    });

    const result = await fetchStockPrice('BDO');
    expect(result).toBeNull();
  });

  it('returns null on HTTP 404 (not found)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const result = await fetchStockPrice('INVALID');
    expect(result).toBeNull();
  });

  it('returns null when response has no stock data', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ stocks: [] }),
    });

    const result = await fetchStockPrice('BDO');
    expect(result).toBeNull();
  });

  it('returns null when price is missing from response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        stocks: [{ symbol: 'BDO', price: { currency: 'PHP' } }],
      }),
    });

    const result = await fetchStockPrice('BDO');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await fetchStockPrice('BDO');
    expect(result).toBeNull();
  });

  it('uppercases the ticker', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        stocks: [{ symbol: 'BDO', price: { currency: 'PHP', amount: 148.5 } }],
      }),
    });

    await fetchStockPrice('bdo');
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('BDO'));
  });
});

// ---------------------------------------------------------------------------
// refreshAllPrices — live scope admission
// ---------------------------------------------------------------------------

describe('refreshAllPrices scope admission', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    localStorage.clear();
    // Keep the debounced background sync from starting a real sync cycle.
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: false,
    });
    await clearPriceStores();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not read stocks, fetch prices, or write when already invalid', async () => {
    await seedStocks(STOCK_A);
    const readSpy = jest.spyOn(idb, 'getAllStocks');
    const isCurrent = jest.fn(() => false);

    await expect(refreshAllPrices(isCurrent)).resolves.toEqual([]);

    expect(isCurrent).toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(await readStock(STOCK_A.id)).toEqual(STOCK_A);
    expect(await readStockQueue()).toEqual([]);
  });

  it('stops after the stock read when the scope becomes invalid during it', async () => {
    await seedStocks(STOCK_A);
    const read = deferred<Stock[]>();
    jest.spyOn(idb, 'getAllStocks').mockReturnValueOnce(read.promise);
    let isValid = true;

    const refresh = refreshAllPrices(() => isValid);
    isValid = false;
    read.resolve([STOCK_A]);

    await expect(refresh).resolves.toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(await readStock(STOCK_A.id)).toEqual(STOCK_A);
    expect(await readStockQueue()).toEqual([]);
  });

  it('stops after a deferred network response without reading JSON or writing', async () => {
    await seedStocks(STOCK_A);
    const fetchStarted = deferred<void>();
    const release = deferred<void>();
    const json = jest.fn().mockResolvedValue({
      stocks: [{ symbol: 'BDO', price: { currency: 'PHP', amount: 148.5 } }],
    });
    mockFetch.mockImplementationOnce(async () => {
      fetchStarted.resolve();
      await release.promise;
      return { ok: true, status: 200, json };
    });
    let isValid = true;

    const refresh = refreshAllPrices(() => isValid);
    await fetchStarted.promise;
    isValid = false;
    release.resolve();

    await expect(refresh).resolves.toEqual([]);
    expect(json).not.toHaveBeenCalled();
    expect(await readStock(STOCK_A.id)).toEqual(STOCK_A);
    expect(await readStockQueue()).toEqual([]);
  });

  it('stops after a deferred JSON body without writing', async () => {
    await seedStocks(STOCK_A);
    const body = deferred<{ stocks: PhisixEntry[] }>();
    const jsonStarted = deferred<void>();
    const response = {
      ok: true,
      status: 200,
      json: jest.fn(() => {
        jsonStarted.resolve();
        return body.promise;
      }),
    };
    mockFetch.mockResolvedValueOnce(response);
    let isValid = true;

    const refresh = refreshAllPrices(() => isValid);
    await jsonStarted.promise;
    isValid = false;
    body.resolve({
      stocks: [{ symbol: 'BDO', price: { currency: 'PHP', amount: 148.5 } }],
    });

    await expect(refresh).resolves.toEqual([]);
    expect(await readStock(STOCK_A.id)).toEqual(STOCK_A);
    expect(await readStockQueue()).toEqual([]);
  });

  it('admits the first write but not a later write after invalidation', async () => {
    await seedStocks(STOCK_A, STOCK_B);
    mockFetch.mockResolvedValueOnce(
      phisixResponse([
        { symbol: 'BDO', price: { currency: 'PHP', amount: 148.5 } },
        { symbol: 'SM', price: { currency: 'PHP', amount: 52.25 } },
      ]),
    );

    const realUpdateStock = idb.updateStock;
    let isValid = true;
    const writeSpy = jest.spyOn(idb, 'updateStock').mockImplementation(async (stock) => {
      await realUpdateStock(stock);
      // The first write was admitted while the scope was live; revoke the
      // scope only after that write settles, before the next admission check.
      if (stock.id === STOCK_A.id) isValid = false;
    });

    await expect(refreshAllPrices(() => isValid)).resolves.toEqual([]);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0][0]).toMatchObject({ id: STOCK_A.id });

    const storedA = await readStock(STOCK_A.id);
    const storedB = await readStock(STOCK_B.id);
    expect(storedA).toMatchObject({
      id: STOCK_A.id,
      ticker: STOCK_A.ticker,
      name: STOCK_A.name,
      sortOrder: STOCK_A.sortOrder,
      createdAt: STOCK_A.createdAt,
      currentPrice: 148.5,
    });
    expect(storedB).toEqual(STOCK_B);

    const queue = await readStockQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      storeName: STORES.STOCKS,
      recordId: STOCK_A.id,
      operation: 'update',
    });
    expect(queue[0].payload).toMatchObject({ id: STOCK_A.id, currentPrice: 148.5 });
  });

  it('updates every matching stock and its queue entry while the scope stays valid', async () => {
    await seedStocks(STOCK_A, STOCK_B);
    mockFetch.mockResolvedValueOnce(
      phisixResponse([
        { symbol: 'BDO', price: { currency: 'PHP', amount: 148.5 } },
        { symbol: 'SM', price: { currency: 'PHP', amount: 52.25 } },
      ]),
    );

    const results = await refreshAllPrices(() => true);

    expect(results).toEqual([
      { ticker: 'BDO', price: 148.5, currency: 'PHP' },
      { ticker: 'SM', price: 52.25, currency: 'PHP' },
    ]);

    const storedA = await readStock(STOCK_A.id);
    const storedB = await readStock(STOCK_B.id);
    expect(storedA).toMatchObject({
      id: STOCK_A.id,
      ticker: STOCK_A.ticker,
      name: STOCK_A.name,
      sortOrder: STOCK_A.sortOrder,
      createdAt: STOCK_A.createdAt,
      currentPrice: 148.5,
      priceUpdatedAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    expect(storedB).toMatchObject({
      id: STOCK_B.id,
      ticker: STOCK_B.ticker,
      name: STOCK_B.name,
      sortOrder: STOCK_B.sortOrder,
      createdAt: STOCK_B.createdAt,
      currentPrice: 52.25,
      priceUpdatedAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });

    const queue = await readStockQueue();
    expect(queue).toHaveLength(2);
    for (const recordId of [STOCK_A.id, STOCK_B.id]) {
      expect(queue).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            storeName: STORES.STOCKS,
            recordId,
            operation: 'update',
          }),
        ]),
      );
    }
    expect(queue.find((entry) => entry.recordId === STOCK_A.id)?.payload).toMatchObject({
      id: STOCK_A.id,
      currentPrice: 148.5,
    });
    expect(queue.find((entry) => entry.recordId === STOCK_B.id)?.payload).toMatchObject({
      id: STOCK_B.id,
      currentPrice: 52.25,
    });
  });
});
