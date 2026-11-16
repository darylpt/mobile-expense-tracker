// ============================================================
// idb-upgrade-v16.test.ts — the v16 upgrade is additive
//
// Opens a database at version 15 with only the stores an older build had,
// seeds records, then opens it through the app's own `getDB()` at version 16.
// Proves the upgrade adds `syncMeta` without touching existing records: this is
// the one-way step every browser runs on first load of the deployed build.
// ============================================================

import 'fake-indexeddb/auto';

if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (val: unknown) => JSON.parse(JSON.stringify(val));
}

import { openDB, deleteDB } from 'idb';
import { STORES, DB_NAME } from './constants';

const OLD_VERSION = 15;

const ACCOUNT = {
  id: 'acct-upgrade',
  name: 'Upgrade fixture',
  startingBalance: 100,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

const QUEUE_ENTRY = {
  id: 'queued-upgrade',
  storeName: STORES.ACCOUNTS,
  recordId: ACCOUNT.id,
  operation: 'update',
  payload: ACCOUNT,
  timestamp: 1,
  retryCount: 2,
  ownerId: 'user-upgrade',
  state: 'paused',
  lastError: 'kept across the upgrade',
};

beforeEach(async () => {
  await deleteDB(DB_NAME);
  // Reset the module-level connection so getDB() reopens the upgraded database.
  jest.resetModules();
});

test('v15 -> v16 keeps existing records and adds the baseline store', async () => {
  // ── Build a v15-shaped database with a subset of stores ──
  const older = await openDB(DB_NAME, OLD_VERSION, {
    upgrade(db) {
      const accounts = db.createObjectStore(STORES.ACCOUNTS, { keyPath: 'id' });
      accounts.createIndex('name', 'name', { unique: true });
      const transactions = db.createObjectStore(STORES.TRANSACTIONS, { keyPath: 'id' });
      transactions.createIndex('date', 'date', { unique: false });
      transactions.createIndex('type', 'type', { unique: false });
      transactions.createIndex('category', 'category', { unique: false });
      transactions.createIndex('account', 'account', { unique: false });
      transactions.createIndex('fromAccount', 'fromAccount', { unique: false });
      transactions.createIndex('toAccount', 'toAccount', { unique: false });
      const queue = db.createObjectStore(STORES.SYNC_QUEUE, { keyPath: 'id' });
      queue.createIndex('byTimestamp', 'timestamp', { unique: false });
      db.createObjectStore(STORES.SYNC_DELETIONS, { keyPath: 'id' });
    },
  });
  await older.put(STORES.ACCOUNTS, ACCOUNT);
  await older.put(STORES.SYNC_QUEUE, QUEUE_ENTRY);
  older.close();

  // ── Open through the app's real connection at v16 ──
  const { getDB } = await import('./idb');
  const db = await getDB();

  expect(db.version).toBe(16);
  expect(await db.get(STORES.ACCOUNTS, ACCOUNT.id)).toEqual(ACCOUNT);
  expect(await db.get(STORES.SYNC_QUEUE, QUEUE_ENTRY.id)).toEqual(QUEUE_ENTRY);
  // The new store exists and starts empty rather than replacing anything.
  expect(await db.getAll(STORES.SYNC_META)).toEqual([]);
  // Stores the fixture never created are added by the same upgrade.
  expect(db.objectStoreNames.contains(STORES.CATEGORIES)).toBe(true);
  expect(db.objectStoreNames.contains(STORES.DATASET_MARKERS)).toBe(true);
});
