// ============================================================
// phase3a-idb.test.ts — Local data-safety regressions (Phase 3A)
//
// Covers schema upgrade retention, deletion archives, nondestructive
// re-sync, scan-only deduplication, full recovery export, and unowned
// safety-only cache detection.
// ============================================================

import 'fake-indexeddb/auto';

// fake-indexeddb v6 needs structuredClone — polyfill for jsdom
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (val: unknown) => JSON.parse(JSON.stringify(val));
}

import { DATA_STORES, DB_NAME, STORES } from './constants';
import type { Transaction } from '@/types';
import type {
  ExpenseTrackerDB,
  SyncDeletionSnapshot,
  SyncMetaEntry,
  SyncQueueEntry,
} from './idb';
import type { IDBPDatabase } from 'idb';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Dynamic imports in this file are intentional: upgrade tests must obtain a
// fresh idb module after jest.resetModules() so the DB singleton re-opens.
// A static import would keep the previous module instance and connection.

function deleteDatabase(): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const request = indexedDB.deleteDatabase(DB_NAME);
  request.onsuccess = () => resolve();
  request.onerror = () => reject(request.error);
  request.onblocked = () => resolve();
  return promise;
}

function openVersion(
  version: number,
  setup: (db: IDBDatabase) => void
): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(DB_NAME, version);
  request.onupgradeneeded = () => setup(request.result);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  return promise;
}

function makeTransaction(id: string, amount = 100): Transaction {
  return {
    id,
    amount,
    date: '2026-01-05',
    type: 'expense',
    category: 'Food',
    fromAccount: null,
    toAccount: 'acct-1',
    description: 'legacy row',
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeLegacyQueueEntry(id: string, recordId: string) {
  return {
    id,
    storeName: STORES.TRANSACTIONS,
    recordId,
    operation: 'create' as const,
    payload: makeTransaction(recordId),
    timestamp: 123,
    retryCount: 2,
  };
}

type TestDB = IDBPDatabase<ExpenseTrackerDB>;

/** The ten financial stores plus the outbox, baselines, and deletion archives. */
const ALL_LOCAL_STORES = [
  ...DATA_STORES,
  STORES.SYNC_QUEUE,
  STORES.SYNC_META,
  STORES.SYNC_DELETIONS,
] as const;

function makeSafetyQueueEntry(id: string): SyncQueueEntry {
  return {
    id,
    storeName: STORES.TRANSACTIONS,
    recordId: 'tx-safety',
    operation: 'create',
    payload: makeTransaction('tx-safety'),
    timestamp: 123,
    retryCount: 0,
    ownerId: null,
    state: 'quarantined',
    baseline: null,
    baselineRevision: null,
    lastError: 'No verified account owns this queue entry',
    lastAttemptAt: null,
    quarantinedAt: 123,
  };
}

function makeSafetyMetaEntry(): SyncMetaEntry {
  return {
    id: `${STORES.TRANSACTIONS}:tx-safety`,
    storeName: STORES.TRANSACTIONS,
    recordId: 'tx-safety',
    ownerId: null,
    baseline: null,
    baselineRevision: null,
    localUpdatedAt: 1,
    state: 'quarantined',
    conflict: null,
    lastError: 'No verified account owns this baseline',
    lastAttemptAt: null,
    updatedAt: 1,
  };
}

function makeSafetyDeletion(id: string): SyncDeletionSnapshot {
  return {
    id,
    storeName: STORES.TRANSACTIONS,
    recordId: 'tx-safety',
    payload: makeTransaction('tx-safety'),
    deletedAt: 1,
    ownerId: null,
    state: 'quarantined',
    reason: 'local-delete',
    baselineRevision: null,
    lastError: 'No verified account owns this deletion',
    updatedAt: 1,
  };
}

const SAFETY_ONLY_CASES: Array<{
  label: string;
  expected: unknown;
  seed: (db: TestDB) => Promise<unknown>;
  read: (db: TestDB) => Promise<unknown[]>;
}> = [
  {
    label: 'syncQueue',
    expected: makeSafetyQueueEntry('q-alone'),
    seed: (db) => db.put(STORES.SYNC_QUEUE, makeSafetyQueueEntry('q-alone')),
    read: (db) => db.getAll(STORES.SYNC_QUEUE),
  },
  {
    label: 'syncMeta',
    expected: makeSafetyMetaEntry(),
    seed: (db) => db.put(STORES.SYNC_META, makeSafetyMetaEntry()),
    read: (db) => db.getAll(STORES.SYNC_META),
  },
  {
    label: 'syncDeletions',
    expected: makeSafetyDeletion('del-alone'),
    seed: (db) => db.put(STORES.SYNC_DELETIONS, makeSafetyDeletion('del-alone')),
    read: (db) => db.getAll(STORES.SYNC_DELETIONS),
  },
];

function createLegacyStores(db: IDBDatabase): void {
  const txStore = db.createObjectStore(STORES.TRANSACTIONS, { keyPath: 'id' });
  txStore.createIndex('date', 'date');
  txStore.createIndex('type', 'type');
  txStore.createIndex('category', 'category');
  txStore.createIndex('account', 'account');
  txStore.createIndex('fromAccount', 'fromAccount');
  txStore.createIndex('toAccount', 'toAccount');
  db.createObjectStore(STORES.ACCOUNTS, { keyPath: 'id' }).createIndex('name', 'name');
  db.createObjectStore(STORES.CATEGORIES, { keyPath: 'id' }).createIndex('name', 'name');
  db.createObjectStore(STORES.CASH_DENOMINATIONS, { keyPath: 'id' }).createIndex('date', 'date');
  db.createObjectStore(STORES.PAYOUTS, { keyPath: 'id' }).createIndex('date', 'date');
  db.createObjectStore(STORES.BUDGET_TARGETS, { keyPath: 'id' });
  db.createObjectStore(STORES.SYNC_QUEUE, { keyPath: 'id' }).createIndex('byTimestamp', 'timestamp');
}

function writeLegacyRecords(
  db: IDBDatabase,
  stores: string[],
  write: (tx: IDBTransaction) => void
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const tx = db.transaction(stores, 'readwrite');
  write(tx);
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  return promise;
}

beforeEach(async () => {
  jest.resetModules();
  localStorage.clear();
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value: false,
  });
  await deleteDatabase();
});

afterEach(async () => {
  await deleteDatabase();
});

// ---------------------------------------------------------------------------
// Schema upgrades
// ---------------------------------------------------------------------------

describe('IndexedDB v14 upgrade', () => {
  it('preserves records and quarantines legacy queue rows (v13 → v14)', async () => {
    const legacy = await openVersion(13, (db) => {
      createLegacyStores(db);
    });
    await writeLegacyRecords(
      legacy,
      [STORES.TRANSACTIONS, STORES.SYNC_QUEUE],
      (tx) => {
        tx.objectStore(STORES.TRANSACTIONS).put(makeTransaction('tx-legacy'));
        tx.objectStore(STORES.SYNC_QUEUE).put(makeLegacyQueueEntry('q-legacy', 'tx-legacy'));
      }
    );
    legacy.close();

    const idb = await import('./idb');
    const db = await idb.getDB();

    expect(await db.get(STORES.TRANSACTIONS, 'tx-legacy')).toMatchObject({
      id: 'tx-legacy',
      amount: 100,
    });

    const queue = await db.getAll(STORES.SYNC_QUEUE);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      id: 'q-legacy',
      ownerId: null,
      state: 'quarantined',
      retryCount: 2,
    });
    expect(queue[0].payload).toEqual(makeTransaction('tx-legacy'));

    expect(db.objectStoreNames.contains(STORES.SYNC_META)).toBe(true);
    expect(db.objectStoreNames.contains(STORES.SYNC_DELETIONS)).toBe(true);
    db.close();
  });

  it('upgrades populated v12 dividends in place and preserves legacy and unknown fields', async () => {
    const legacy = await openVersion(12, (db) => {
      createLegacyStores(db);
      const stocks = db.createObjectStore(STORES.STOCKS, { keyPath: 'id' });
      stocks.createIndex('ticker', 'ticker', { unique: true });
      const dividends = db.createObjectStore(STORES.DIVIDENDS, { keyPath: 'id' });
      dividends.createIndex('stockId', 'stockId', { unique: false });
      dividends.createIndex('date', 'date', { unique: false });
      dividends.createIndex('type', 'type', { unique: false });
    });
    const dividend = {
      id: 'div-legacy',
      stockId: 'stock-parent',
      date: '2025-11-14',
      type: 'cash',
      amount: 237.5,
      sharesReceived: null,
      notes: 'legacy dividend',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_123,
      importedMetadata: { source: 'historical-import', batch: 12 },
    };
    await writeLegacyRecords(legacy, [STORES.STOCKS, STORES.DIVIDENDS], (tx) => {
      tx.objectStore(STORES.STOCKS).put({ id: 'stock-parent', ticker: 'ABC' });
      tx.objectStore(STORES.DIVIDENDS).put(dividend);
    });
    legacy.close();

    const idb = await import('./idb');
    const db = await idb.getDB();
    const migrated = await db.get(STORES.DIVIDENDS, dividend.id);
    const indexNames = db.transaction(STORES.DIVIDENDS).objectStore(STORES.DIVIDENDS).indexNames;

    expect(migrated).toEqual({
      ...dividend,
      exDate: dividend.date,
      payDate: dividend.date,
      qty: 0,
      rate: 0,
      fee: 0,
      dividendYield: null,
    });
    expect(await db.get(STORES.STOCKS, dividend.stockId)).toEqual({
      id: 'stock-parent',
      ticker: 'ABC',
    });
    expect(indexNames.contains('stockId')).toBe(true);
    expect(indexNames.contains('exDate')).toBe(true);
    expect(indexNames.contains('payDate')).toBe(true);
    expect(indexNames.contains('type')).toBe(true);
    expect(indexNames.contains('date')).toBe(false);
    expect(
      await db.transaction(STORES.DIVIDENDS).objectStore(STORES.DIVIDENDS).index('stockId').get(dividend.stockId)
    ).toEqual(migrated);
    expect(
      await db.transaction(STORES.DIVIDENDS).objectStore(STORES.DIVIDENDS).index('exDate').get(dividend.date)
    ).toEqual(migrated);
    db.close();
  });

  it('no longer clears data for upgrades from before v8', async () => {
    const legacy = await openVersion(7, (db) => {
      createLegacyStores(db);
    });
    await writeLegacyRecords(legacy, [STORES.TRANSACTIONS], (tx) => {
      tx.objectStore(STORES.TRANSACTIONS).put(makeTransaction('tx-pre-v8'));
    });
    legacy.close();

    const idb = await import('./idb');
    const db = await idb.getDB();

    expect(await db.get(STORES.TRANSACTIONS, 'tx-pre-v8')).toMatchObject({
      id: 'tx-pre-v8',
    });
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Deletion archives
// ---------------------------------------------------------------------------

describe('local deletion archives', () => {
  it('archives the complete transaction payload atomically with the delete queue entry', async () => {
    localStorage.setItem('lastUserId', 'user-1');
    const idb = await import('./idb');
    const db = await idb.getDB();

    const id = await idb.addTransaction({
      amount: 42,
      date: '2026-02-01',
      type: 'expense',
      category: 'Food',
      fromAccount: 'acct-1',
      toAccount: null,
      description: 'to delete',
    });
    await idb.deleteTransaction(id);

    expect(await db.get(STORES.TRANSACTIONS, id)).toBeUndefined();

    const deletions = await db.getAll(STORES.SYNC_DELETIONS);
    expect(deletions).toHaveLength(1);
    expect(deletions[0]).toMatchObject({
      storeName: STORES.TRANSACTIONS,
      recordId: id,
      reason: 'local-delete',
      ownerId: 'user-1',
    });
    expect(deletions[0].payload).toMatchObject({ id, amount: 42, description: 'to delete' });

    const queue = await db.getAll(STORES.SYNC_QUEUE);
    const deleteEntry = queue.find((entry) => entry.operation === 'delete');
    expect(deleteEntry).toMatchObject({
      recordId: id,
      ownerId: 'user-1',
      state: 'pending',
      deletionSnapshotId: deletions[0].id,
    });
    expect(deleteEntry?.payload).toMatchObject({ id, amount: 42 });
    expect(deleteEntry?.retryCount).toBe(0);
    db.close();
  });

  it('archives every record in a stock cascade', async () => {
    localStorage.setItem('lastUserId', 'user-1');
    const idb = await import('./idb');
    const db = await idb.getDB();

    const stockId = await idb.addStock({
      ticker: 'BDO',
      name: 'BDO Unibank',
      type: 'stock',
      currentPrice: null,
      priceUpdatedAt: null,
      sortOrder: 0,
    });
    await idb.addStockTransaction({
      stockId,
      date: '2026-01-02',
      type: 'buy',
      shares: 1,
      pricePerShare: 100,
      fees: 0,
      totalAmount: 100,
    });
    await idb.addDividend({
      stockId,
      exDate: '2026-01-03',
      payDate: '2026-01-04',
      type: 'cash',
      qty: 1,
      rate: 5,
      amount: 5,
      fee: 0,
    });

    await idb.deleteStock(stockId);

    const deletions = await db.getAll(STORES.SYNC_DELETIONS);
    expect(deletions.map((snapshot) => snapshot.storeName).sort()).toEqual(
      [STORES.DIVIDENDS, STORES.STOCK_TRANSACTIONS, STORES.STOCKS].sort()
    );
    const queue = await db.getAll(STORES.SYNC_QUEUE);
    expect(queue.filter((entry) => entry.operation === 'delete')).toHaveLength(3);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Re-sync / dedup / export
// ---------------------------------------------------------------------------

describe('nondestructive recovery operations', () => {
  it('resyncAll retries paused entries without clearing queue, conflicts, or archives', async () => {
    const idb = await import('./idb');
    const db = await idb.getDB();

    const blocked = {
      ...makeLegacyQueueEntry('q-blocked', 'tx-1'),
      ownerId: 'user-1',
      state: 'blocked' as const,
      baseline: null,
      baselineRevision: null,
      lastError: 'network down',
    };
    const conflict = {
      ...makeLegacyQueueEntry('q-conflict', 'tx-2'),
      ownerId: 'user-1',
      state: 'conflict' as const,
      baseline: null,
      baselineRevision: null,
      lastError: 'remote changed',
    };
    await db.put(STORES.SYNC_QUEUE, blocked);
    await db.put(STORES.SYNC_QUEUE, conflict);
    await db.put(STORES.SYNC_DELETIONS, {
      id: 'del-1',
      storeName: STORES.TRANSACTIONS,
      recordId: 'tx-3',
      payload: makeTransaction('tx-3'),
      deletedAt: 1,
      ownerId: 'user-1',
      state: 'pending',
      reason: 'local-delete',
      baselineRevision: null,
      updatedAt: 1,
    });

    const result = await idb.resyncAll();
    expect(result.retried).toBe(1);

    const queue = await db.getAll(STORES.SYNC_QUEUE);
    expect(queue.find((entry) => entry.id === 'q-blocked')).toMatchObject({
      state: 'pending',
      retryCount: 2,
      lastError: 'network down',
    });
    expect(queue.find((entry) => entry.id === 'q-conflict')).toMatchObject({
      state: 'conflict',
    });
    expect(await db.count(STORES.SYNC_DELETIONS)).toBe(1);
    db.close();
  });

  it('deduplicateTransactions reports candidates without mutating data', async () => {
    const idb = await import('./idb');
    const db = await idb.getDB();

    await db.put(STORES.ACCOUNTS, {
      id: 'acct-1',
      name: 'Checking',
      startingBalance: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    const healthy = makeTransaction('tx-healthy', 50);
    const orphan = {
      ...makeTransaction('tx-orphan', 50),
      fromAccount: null,
      toAccount: 'acct-deleted',
    };
    await db.put(STORES.TRANSACTIONS, healthy);
    await db.put(STORES.TRANSACTIONS, orphan);

    const before = await db.getAll(STORES.TRANSACTIONS);
    const result = await idb.deduplicateTransactions();
    const after = await db.getAll(STORES.TRANSACTIONS);

    expect(result).toEqual({
      deleted: 0,
      relinked: 0,
      remaining: 0,
      duplicates: 1,
      orphaned: 1,
    });
    expect(after).toEqual(before);
    expect(await db.count(STORES.SYNC_QUEUE)).toBe(0);
    db.close();
  });

  it('restores outbox, baselines, and deletion archives from a full backup without clearing current ones', async () => {
    localStorage.setItem('lastUserId', 'user-1');
    const idb = await import('./idb');
    const db = await idb.getDB();

    const tx = makeTransaction('tx-restored');
    await idb.importAllData({
      version: 1,
      exportedAt: new Date().toISOString(),
      data: {
        transactions: [tx],
        accounts: [],
        categories: [],
        cashDenominations: [],
        payouts: [],
        budgetTargets: [],
        balanceSnapshots: [],
        stocks: [],
        stockTransactions: [],
        dividends: [],
        syncQueue: [
          {
            ...makeLegacyQueueEntry('q-restored', 'tx-restored'),
            operation: 'update',
            ownerId: 'user-1',
            state: 'pending',
            baseline: { id: 'tx-restored', updated_at: '2026-01-01T00:00:00.000Z' },
            baselineRevision: '2026-01-01T00:00:00.000Z',
          },
        ],
        syncMeta: [
          {
            id: `${STORES.TRANSACTIONS}:tx-restored`,
            storeName: STORES.TRANSACTIONS,
            recordId: 'tx-restored',
            ownerId: 'user-1',
            baseline: { id: 'tx-restored', updated_at: '2026-01-01T00:00:00.000Z' },
            baselineRevision: '2026-01-01T00:00:00.000Z',
            localUpdatedAt: 1,
            state: 'clean',
            conflict: null,
            lastError: null,
            lastAttemptAt: null,
            updatedAt: 1,
          },
        ],
        syncDeletions: [
          {
            id: 'del-restored',
            storeName: STORES.TRANSACTIONS,
            recordId: 'tx-deleted',
            payload: makeTransaction('tx-deleted'),
            deletedAt: 1,
            ownerId: 'user-1',
            state: 'archived',
            reason: 'backup-restore-replaced',
            baselineRevision: null,
            updatedAt: 1,
          },
        ],
      },
    });

    expect(await db.get(STORES.TRANSACTIONS, 'tx-restored')).toMatchObject({
      id: 'tx-restored',
    });
    expect(await db.get(STORES.SYNC_QUEUE, 'q-restored')).toMatchObject({
      state: 'pending',
      operation: 'update',
    });
    expect(
      await db.get(STORES.SYNC_META, `${STORES.TRANSACTIONS}:tx-restored`)
    ).toMatchObject({ baselineRevision: '2026-01-01T00:00:00.000Z' });
    expect(await db.get(STORES.SYNC_DELETIONS, 'del-restored')).toMatchObject({
      recordId: 'tx-deleted',
    });
    // No duplicate create entry for a record covered by the restored queue.
    expect(
      (await db.getAll(STORES.SYNC_QUEUE)).filter(
        (entry) => entry.recordId === 'tx-restored'
      )
    ).toHaveLength(1);
    db.close();
  });

  it('exports all ten data stores plus outbox, baselines, and deletion archives', async () => {
    localStorage.setItem('lastUserId', 'user-1');
    const idb = await import('./idb');
    const db = await idb.getDB();

    const id = await idb.addTransaction({
      amount: 10,
      date: '2026-03-01',
      type: 'expense',
      category: 'Food',
      fromAccount: 'acct-1',
      toAccount: null,
      description: 'exported',
    });
    await idb.deleteTransaction(id);

    const backup = await idb.exportAllData();
    expect(backup.version).toBe(1);
    expect(backup.data).toEqual(
      expect.objectContaining({
        transactions: expect.any(Array),
        accounts: expect.any(Array),
        categories: expect.any(Array),
        cashDenominations: expect.any(Array),
        payouts: expect.any(Array),
        budgetTargets: expect.any(Array),
        balanceSnapshots: expect.any(Array),
        stocks: expect.any(Array),
        stockTransactions: expect.any(Array),
        dividends: expect.any(Array),
        syncQueue: expect.any(Array),
        syncMeta: expect.any(Array),
        syncDeletions: expect.any(Array),
      })
    );
    expect(backup.data.syncDeletions).toHaveLength(1);
    expect(JSON.stringify(backup)).not.toMatch(/access_token|refresh_token|password/i);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Unowned cache ownership
// ---------------------------------------------------------------------------

describe('unowned cache ownership', () => {
  it('treats a safety-only cache with no owner marker as local data', async () => {
    const idb = await import('./idb');
    const db = await idb.getDB();

    try {
      // No account has claimed this cache yet.
      expect(localStorage.getItem('lastUserId')).toBeNull();
      for (const storeName of DATA_STORES) {
        expect(await db.count(storeName)).toBe(0);
      }

      // A deletion archive is the only record on disk. If the startup check
      // treats the empty financial stores as an empty cache, a new account
      // would claim the database and orphan this archive.
      await db.put(STORES.SYNC_DELETIONS, {
        id: 'del-unowned',
        storeName: STORES.TRANSACTIONS,
        recordId: 'tx-unowned',
        payload: makeTransaction('tx-unowned'),
        deletedAt: 1,
        ownerId: null,
        state: 'quarantined',
        reason: 'local-delete',
        baselineRevision: null,
        lastError: 'No verified account owns this deletion',
        updatedAt: 1,
      });

      expect(await db.count(STORES.SYNC_DELETIONS)).toBe(1);
      await expect(idb.hasAnyLocalData()).resolves.toBe(true);
    } finally {
      // Release the connection so afterEach deleteDatabase is not blocked.
      db.close();
    }
  });

  it('reports no local data only when every local store is empty', async () => {
    const idb = await import('./idb');
    const db = await idb.getDB();

    try {
      expect(ALL_LOCAL_STORES).toHaveLength(13);
      for (const storeName of ALL_LOCAL_STORES) {
        expect(await db.count(storeName)).toBe(0);
      }

      await expect(idb.hasAnyLocalData()).resolves.toBe(false);
    } finally {
      // Release the connection so afterEach deleteDatabase is not blocked.
      db.close();
    }
  });

  it('treats a financial row as local data without mutating it', async () => {
    const idb = await import('./idb');
    const db = await idb.getDB();

    try {
      const financialRow = makeTransaction('tx-financial', 19.99);
      await db.put(STORES.TRANSACTIONS, financialRow);

      await expect(idb.hasAnyLocalData()).resolves.toBe(true);
      expect(await db.get(STORES.TRANSACTIONS, financialRow.id)).toEqual(financialRow);
    } finally {
      // Release the connection so afterEach deleteDatabase is not blocked.
      db.close();
    }
  });

  it.each(SAFETY_ONLY_CASES)(
    'treats $label alone as local data without mutating it',
    async ({ expected, seed, read }) => {
      const idb = await import('./idb');
      const db = await idb.getDB();

      try {
        await seed(db);
        const before = await read(db);
        expect(before).toEqual([expected]);

        await expect(idb.hasAnyLocalData()).resolves.toBe(true);
        expect(await read(db)).toEqual(before);
      } finally {
        // Release the connection so afterEach deleteDatabase is not blocked.
        db.close();
      }
    }
  );

  it('rejects instead of reporting empty when the local database is unavailable', async () => {
    const idb = await import('./idb');
    const db = await idb.getDB();
    // Closing the connection makes every later read fail. That failure must
    // surface rather than being mistaken for an empty cache.
    db.close();

    await expect(idb.hasAnyLocalData()).rejects.toThrow();
  });
});
