// ============================================================
// backup-roundtrip.test.ts — the JSON backup carries every store
//
// Real IndexedDB (fake-indexeddb) and the real idb module; no Supabase client
// is involved because export/import are local-only.
// ============================================================

import 'fake-indexeddb/auto';

if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (val: unknown) => JSON.parse(JSON.stringify(val));
}

import { STORES } from './constants';
import {
  exportAllData,
  getDB,
  importAllData,
  type BackupData,
  type LegacyBackupV1,
} from './idb';

const RECORDS: Record<string, Record<string, unknown>> = {
  [STORES.ACCOUNTS]: { id: 'acct-1', name: 'Cash', startingBalance: 0, sortOrder: 0, createdAt: 1, updatedAt: 1 },
  [STORES.CATEGORIES]: { id: 'cat-1', name: 'Food', type: 'expense', color: '#f00', sortOrder: 0, createdAt: 1, updatedAt: 1 },
  [STORES.TRANSACTIONS]: { id: 'tx-1', date: '2026-01-01', type: 'expense', category: 'Food', fromAccount: 'Cash', amount: 10, createdAt: 1, updatedAt: 1 },
  [STORES.CASH_DENOMINATIONS]: { id: 'cash-1', date: '2026-01-01', denomination: 100, count: 1, createdAt: 1 },
  [STORES.PAYOUTS]: { id: 'pay-1', date: '2026-01-01', grossAmount: 100, netAmount: 90, createdAt: 1, updatedAt: 1 },
  [STORES.BUDGET_TARGETS]: { id: 'bt-1', categoryId: 'cat-1', amount: 50, month: null, createdAt: 1, updatedAt: 1 },
  [STORES.BALANCE_SNAPSHOTS]: { id: 'snap-1', accountId: 'acct-1', date: '2026-01-31', actualBalance: 5, createdAt: 1, updatedAt: 1 },
  [STORES.STOCKS]: { id: 'stock-1', ticker: 'AAA', name: 'AAA Fund', type: 'fund', shares: 1, avgPrice: 1, sortOrder: 0, createdAt: 1, updatedAt: 1 },
  [STORES.STOCK_TRANSACTIONS]: { id: 'stx-1', stockId: 'stock-1', type: 'buy', shares: 1, price: 1, date: '2026-01-01', createdAt: 1 },
  [STORES.DIVIDENDS]: { id: 'div-1', stockId: 'stock-1', date: '2026-01-01', qty: 1, rate: 1, fee: 0, amount: 1, createdAt: 1, updatedAt: 1 },
  [STORES.SYNC_QUEUE]: { id: 'q-1', storeName: STORES.ACCOUNTS, recordId: 'acct-1', operation: 'create', payload: {}, timestamp: 1, retryCount: 0 },
  [STORES.SYNC_DELETIONS]: { id: 'del-1', storeName: STORES.ACCOUNTS, recordId: 'gone', payload: {}, deletedAt: 1, reason: 'remote-tombstone', remoteDeletedAt: null },
  [STORES.SYNC_META]: { id: 'meta-1', storeName: STORES.ACCOUNTS, recordId: 'acct-1', ownerId: 'user-1', baselineRevision: 'rev-1', updatedAt: 1 },
  [STORES.DATASET_MARKERS]: { userId: 'user-1', generation: 1, snapshotId: 's', status: 'applied', snapshot: null, remoteGeneration: 1, attempts: 0, lastError: null, updatedAt: 1 },
};

const STORE_NAMES = Object.keys(RECORDS);

async function clearEverything(): Promise<void> {
  const db = await getDB();
  for (const store of STORE_NAMES) {
    await db.clear(store);
  }
}

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem('lastUserId', 'user-1');
  await clearEverything();
});

test('the export carries every store the app owns', async () => {
  const db = await getDB();
  for (const [store, record] of Object.entries(RECORDS)) {
    await db.put(store, record);
  }

  const backup = await exportAllData();

  expect(backup.version).toBe(2);
  for (const store of STORE_NAMES) {
    expect(backup.data[store]).toEqual([RECORDS[store]]);
  }
  expect(Object.keys(backup.data).sort()).toEqual([...STORE_NAMES].sort());
});

test('a full export restores every store, including the safety stores', async () => {
  const db = await getDB();
  for (const [store, record] of Object.entries(RECORDS)) {
    await db.put(store, record);
  }
  const backup = await exportAllData();
  await clearEverything();

  await importAllData(backup);

  for (const [store, record] of Object.entries(RECORDS)) {
    expect(await db.get(store, (record.id ?? record.userId) as string)).toEqual(record);
  }
});

test('a legacy six-store file replaces only the stores it carries', async () => {
  const db = await getDB();
  await db.put(STORES.SYNC_QUEUE, RECORDS[STORES.SYNC_QUEUE]);
  await db.put(STORES.SYNC_DELETIONS, RECORDS[STORES.SYNC_DELETIONS]);

  const legacy: LegacyBackupV1 = {
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    data: {
      accounts: [RECORDS[STORES.ACCOUNTS] as unknown as never],
      categories: [RECORDS[STORES.CATEGORIES] as unknown as never],
      transactions: [],
      cashDenominations: [],
      payouts: [],
      budgetTargets: [],
    },
  };

  await importAllData(legacy as unknown as BackupData | LegacyBackupV1);

  expect(await db.get(STORES.ACCOUNTS, 'acct-1')).toEqual(RECORDS[STORES.ACCOUNTS]);
  expect(await db.get(STORES.SYNC_QUEUE, 'q-1')).toEqual(RECORDS[STORES.SYNC_QUEUE]);
  expect(await db.get(STORES.SYNC_DELETIONS, 'del-1')).toEqual(RECORDS[STORES.SYNC_DELETIONS]);
});
