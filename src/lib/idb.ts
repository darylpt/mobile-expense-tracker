// ============================================================
// IndexedDB wrapper using the `idb` library
// Provides CRUD operations for transactions, accounts, categories,
// cash denominations, and payouts.
// ============================================================

import { openDB, type IDBPDatabase, type IDBPObjectStore } from 'idb';
import type { Transaction, Account, Category, CashDenomination, Payout, BudgetTarget, Stock, StockTransaction, Dividend, BalanceSnapshot } from '@/types';
import { DB_NAME, DB_VERSION, STORES, LAST_USER_STORAGE_KEY } from './constants';
import { generateId } from './utils';
import { parseCsv, type ParsedCsv } from './csv-import';
import {
  LOCAL_DATASET_OWNER,
  MANAGED_STORES,
  isManagedStore,
  nextDatasetGeneration,
  retainExistingAccountIds,
  type DatasetReplacementMarker,
  type DatasetSnapshot,
} from './dataset-replacement';
import {
  affectedTransactionIds,
  findSelfTransferConflicts,
  groupTransactionsByMissingAccount,
  relinkTransactionReferences,
  type MissingAccountGroup,
} from './orphans';

// ============================================================
// Sync Queue Types (stored in IndexedDB, processed by sync.ts)
// ============================================================

export type SyncOperation = 'create' | 'update' | 'delete';

export interface SyncQueueEntry {
  id: string;
  storeName: string;
  recordId: string;
  operation: SyncOperation;
  // ponytail: unknown is fine here — IndexedDB accepts any structured-cloneable value
  payload: unknown;
  timestamp: number;
  retryCount: number;
  /** Applied dataset generation when the entry was enqueued. */
  datasetGeneration?: number;
  /**
   * Account that produced this mutation. `null`/absent means ownership is
   * unproven: the entry is never replayed for a different account.
   */
  ownerId?: string | null;
  /**
   * `paused` means automatic retries stopped after repeated failures. The entry
   * and its payload stay on disk until the user retries it; it is never deleted
   * for failing. `blocked` means it must not be attempted under the current
   * account (ownership mismatch or a server revision it cannot prove).
   */
  state?: 'pending' | 'paused' | 'blocked';
  /** Last failure message, kept for the paused/retry UI and export. */
  lastError?: string | null;
}

/** Durable snapshot of a record removed because the cloud row was deleted. */
export interface SyncDeletionSnapshot {
  id: string;
  storeName: string;
  recordId: string;
  payload: unknown;
  deletedAt: number;
  reason: 'remote-tombstone' | 'stale-dataset-generation' | 'local-delete';
  remoteDeletedAt: string | null;
}

/**
 * Server revision a record had at its last successful sync. Used as the
 * compare-and-set token on the next write and to detect a remote change made by
 * another client.
 */
export interface SyncMetaEntry {
  /** `${storeName}:${recordId}` */
  id: string;
  storeName: string;
  recordId: string;
  ownerId: string | null;
  /** Raw server `updated_at` (or immutable `created_at`) of that row. */
  baselineRevision: string | null;
  updatedAt: number;
}

// ============================================================
// DB Schema
// ============================================================

/** Schema type for our IndexedDB database */
export interface ExpenseTrackerDB {
  [STORES.TRANSACTIONS]: {
    key: string;
    value: Transaction;
    indexes: {
      date: string;
      type: string;
      category: string;
      account: string;
      fromAccount: string | null;
      toAccount: string | null;
    };
  };
  [STORES.ACCOUNTS]: {
    key: string;
    value: Account;
    indexes: {
      name: string;
    };
  };
  [STORES.CATEGORIES]: {
    key: string;
    value: Category;
    indexes: {
      name: string;
      type: string;
    };
  };
  [STORES.CASH_DENOMINATIONS]: {
    key: string;
    value: CashDenomination;
    indexes: {
      date: string;
    };
  };
  [STORES.PAYOUTS]: {
    key: string;
    value: Payout;
    indexes: {
      date: string;
    };
  };
  [STORES.BUDGET_TARGETS]: {
    key: string;
    value: BudgetTarget;
    indexes: {
      category: string;
      month: string;
    };
  };
  [STORES.SYNC_QUEUE]: {
    key: string;
    value: SyncQueueEntry;
    indexes: {
      byTimestamp: number;
    };
  };
  [STORES.SYNC_DELETIONS]: {
    key: string;
    value: SyncDeletionSnapshot;
    indexes: {
      storeName: string;
    };
  };
  [STORES.SYNC_META]: {
    key: string;
    value: SyncMetaEntry;
    indexes: {
      storeName: string;
    };
  };
  [STORES.DATASET_MARKERS]: {
    key: string;
    value: DatasetReplacementMarker;
  };
  [STORES.STOCKS]: {
    key: string;
    value: Stock;
    indexes: { ticker: string; };
  };
  [STORES.STOCK_TRANSACTIONS]: {
    key: string;
    value: StockTransaction;
    indexes: { stockId: string; date: string; type: string; };
  };
  [STORES.DIVIDENDS]: {
    key: string;
    value: Dividend;
    indexes: { stockId: string; exDate: string; payDate: string; type: string; };
  };
  [STORES.BALANCE_SNAPSHOTS]: {
    key: string;
    value: BalanceSnapshot;
    indexes: {
      accountId: string;
    };
  };
}

/**
 * Single in-flight open. Every caller awaits this promise, so none of them can
 * use the database before the persisted dataset generation is hydrated.
 */
let dbPromise: Promise<IDBPDatabase<ExpenseTrackerDB>> | null = null;

let activeDatasetGeneration = 0;

/**
 * Open (or create) the IndexedDB database and initialize stores/indexes.
 * Resolves only after dataset markers have hydrated the active generation.
 */
export async function getDB(): Promise<IDBPDatabase<ExpenseTrackerDB>> {
  if (!dbPromise) {
    dbPromise = openHydratedDB().catch((error: unknown) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

async function openHydratedDB(): Promise<IDBPDatabase<ExpenseTrackerDB>> {
  const db = await openDB<ExpenseTrackerDB>(DB_NAME, DB_VERSION, {
    // ponytail: no automated migration test. If a user reports data loss on upgrade,
    // write a test that opens an old-version DB fixture, runs the upgrade path,
    // and asserts data survives. Classic IndexedDB footgun.
    async upgrade(db, oldVersion, _newVersion, transaction) {
      // ── Create stores if they don't exist yet ──

      // Transactions Store
      if (!db.objectStoreNames.contains(STORES.TRANSACTIONS)) {
        const txStore = db.createObjectStore(STORES.TRANSACTIONS, { keyPath: 'id' });
        txStore.createIndex('date', 'date', { unique: false });
        txStore.createIndex('type', 'type', { unique: false });
        txStore.createIndex('category', 'category', { unique: false });
        txStore.createIndex('account', 'account', { unique: false });
        txStore.createIndex('fromAccount', 'fromAccount', { unique: false });
        txStore.createIndex('toAccount', 'toAccount', { unique: false });
      }

      // Accounts Store
      if (!db.objectStoreNames.contains(STORES.ACCOUNTS)) {
        const acctStore = db.createObjectStore(STORES.ACCOUNTS, { keyPath: 'id' });
        acctStore.createIndex('name', 'name', { unique: true });
      }

      // Categories Store
      if (!db.objectStoreNames.contains(STORES.CATEGORIES)) {
        const catStore = db.createObjectStore(STORES.CATEGORIES, { keyPath: 'id' });
        catStore.createIndex('name', 'name', { unique: false });
        catStore.createIndex('type', 'type', { unique: false });
      }

      // ── New stores added in v3 ──
      if (!db.objectStoreNames.contains(STORES.CASH_DENOMINATIONS)) {
        const cdStore = db.createObjectStore(STORES.CASH_DENOMINATIONS, { keyPath: 'id' });
        cdStore.createIndex('date', 'date', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.PAYOUTS)) {
        const pStore = db.createObjectStore(STORES.PAYOUTS, { keyPath: 'id' });
        pStore.createIndex('date', 'date', { unique: false });
      }

      // ── New stores added in v4 ──
      if (!db.objectStoreNames.contains(STORES.BUDGET_TARGETS)) {
        const btStore = db.createObjectStore(STORES.BUDGET_TARGETS, { keyPath: 'id' });
        btStore.createIndex('category', 'category', { unique: false });
        btStore.createIndex('month', 'month', { unique: false });
      }

      // ── New store added in v5 (sync queue) ──
      if (!db.objectStoreNames.contains(STORES.SYNC_QUEUE)) {
        const sqStore = db.createObjectStore(STORES.SYNC_QUEUE, { keyPath: 'id' });
        sqStore.createIndex('byTimestamp', 'timestamp', { unique: false });
      }

      // ── New store added in v15 (recoverable deletion archive) ──
      if (!db.objectStoreNames.contains(STORES.SYNC_DELETIONS)) {
        const delStore = db.createObjectStore(STORES.SYNC_DELETIONS, { keyPath: 'id' });
        delStore.createIndex('storeName', 'storeName', { unique: false });
      }

      // ── New store added in v16 (per-record server baseline) ──
      if (!db.objectStoreNames.contains(STORES.SYNC_META)) {
        const metaStore = db.createObjectStore(STORES.SYNC_META, { keyPath: 'id' });
        metaStore.createIndex('storeName', 'storeName', { unique: false });
      }

      // ── New store added in v14 (durable dataset replacement marker) ──
      if (!db.objectStoreNames.contains(STORES.DATASET_MARKERS)) {
        db.createObjectStore(STORES.DATASET_MARKERS, { keyPath: 'userId' });
      }

      // ── New stores added in v11 (stock portfolio tracker) ──
      if (!db.objectStoreNames.contains(STORES.STOCKS)) {
        const sStore = db.createObjectStore(STORES.STOCKS, { keyPath: 'id' });
        sStore.createIndex('ticker', 'ticker', { unique: true });
      }

      if (!db.objectStoreNames.contains(STORES.STOCK_TRANSACTIONS)) {
        const stStore = db.createObjectStore(STORES.STOCK_TRANSACTIONS, { keyPath: 'id' });
        stStore.createIndex('stockId', 'stockId', { unique: false });
        stStore.createIndex('date', 'date', { unique: false });
        stStore.createIndex('type', 'type', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.DIVIDENDS)) {
        const dStore = db.createObjectStore(STORES.DIVIDENDS, { keyPath: 'id' });
        dStore.createIndex('stockId', 'stockId', { unique: false });
        dStore.createIndex('exDate', 'exDate', { unique: false });
        dStore.createIndex('payDate', 'payDate', { unique: false });
        dStore.createIndex('type', 'type', { unique: false });
      }

      // ── New store added in v12 (balance snapshots for sync) ──
      if (!db.objectStoreNames.contains(STORES.BALANCE_SNAPSHOTS)) {
        const bsStore = db.createObjectStore(STORES.BALANCE_SNAPSHOTS, { keyPath: 'id' });
        bsStore.createIndex('accountId', 'accountId', { unique: false });
      }

      // ── Migration: v5 → v6 (category + account sortOrder) ──
      if (oldVersion < 6) {
        if (db.objectStoreNames.contains(STORES.CATEGORIES)) {
          const catStore = transaction.objectStore(STORES.CATEGORIES);
          let cursor = await catStore.openCursor();
          let order = 0;
          while (cursor) {
            await cursor.update({ ...cursor.value, sortOrder: order });
            order += 1000;
            cursor = await cursor.continue();
          }
        }
        if (db.objectStoreNames.contains(STORES.ACCOUNTS)) {
          const acctStore = transaction.objectStore(STORES.ACCOUNTS);
          let cursor = await acctStore.openCursor();
          let order = 0;
          while (cursor) {
            await cursor.update({ ...cursor.value, sortOrder: order });
            order += 1000;
            cursor = await cursor.continue();
          }
        }
      }

      // ── Migration: v6 → v7 (fill sortOrder on accounts missed by early v6 migration) ──
      if (oldVersion < 7 && db.objectStoreNames.contains(STORES.ACCOUNTS)) {
        const acctStore = transaction.objectStore(STORES.ACCOUNTS);
        // Check if any account lacks sortOrder
        let needsMigration = false;
        let cursor = await acctStore.openCursor();
        while (cursor) {
          if (cursor.value.sortOrder === undefined) { needsMigration = true; break; }
          cursor = await cursor.continue();
        }
        if (needsMigration) {
          let order = 0;
          cursor = await acctStore.openCursor(); // fresh cursor
          while (cursor) {
            await cursor.update({ ...cursor.value, sortOrder: order });
            order += 1000;
            cursor = await cursor.continue();
          }
        }
      }

      // ── Migration: v7 → v8 (user isolation — clear old shared caches) ──
      if (oldVersion < 8) {
        for (const storeName of Object.values(STORES)) {
          const store = transaction.objectStore(storeName);
          await store.clear();
        }
      }

      // ── Migration: v8 → v9 (add createdAt/updatedAt to accounts and categories) ──
      if (oldVersion < 9) {
        const now = Date.now();
        for (const storeName of [STORES.ACCOUNTS, STORES.CATEGORIES] as const) {
          const store = transaction.objectStore(storeName);
          let cursor = await store.openCursor();
          while (cursor) {
            const r = cursor.value;
            if (r.createdAt === undefined || r.updatedAt === undefined) {
              await cursor.update({ ...r, createdAt: r.createdAt ?? now, updatedAt: r.updatedAt ?? now });
            }
            cursor = await cursor.continue();
          }
        }
      }

      // ── Migration: v9 → v10 (mark Savings/Investment expense categories with hasDestinationAccount) ──
      if (oldVersion < 10) {
        const catStore = transaction.objectStore(STORES.CATEGORIES);
        let cursor = await catStore.openCursor();
        while (cursor) {
          const cat = cursor.value;
          if (cat.type === 'expense' && (cat.name === 'Savings' || cat.name === 'Investment')) {
            await cursor.update({ ...cat, hasDestinationAccount: true });
          }
          cursor = await cursor.continue();
        }
      }

      // ── Migration: v2 → v3 ──
      if (oldVersion < 3) {
        const txStore = transaction.objectStore(STORES.TRANSACTIONS);

        // Add new indexes if they don't exist
        if (!txStore.indexNames.contains('fromAccount')) {
          txStore.createIndex('fromAccount', 'fromAccount', { unique: false });
        }
        if (!txStore.indexNames.contains('toAccount')) {
          txStore.createIndex('toAccount', 'toAccount', { unique: false });
        }

        // Migrate existing transaction records
        let cursor = await txStore.openCursor();
        while (cursor) {
          const record = cursor.value;
          const legacy = record as Record<string, unknown>;
          const updates: Partial<Transaction> = {};

          // Rename type: 'Income' → 'income', 'Expense' → 'expense', 'Transfer' → 'transaction'
          if (record.type === 'Income') {
            updates.type = 'income';
            updates.fromAccount = null;
            updates.toAccount = (legacy.account as string) ?? null;
          } else if (record.type === 'Expense') {
            updates.type = 'expense';
            updates.fromAccount = (legacy.account as string) ?? null;
            updates.toAccount = null;
          } else if (record.type === 'Transfer') {
            updates.type = 'transaction';
            updates.fromAccount = (legacy.account as string) ?? null;
            updates.toAccount = (legacy.account as string) ?? null;
          }

          // Keep the old `account` field for backward compat
          cursor.update({ ...record, ...updates });
          cursor = await cursor.continue();
        }
      }

      // ── Migration: v12 → v13 (dividend schema expansion) ──
      if (oldVersion < 13 && db.objectStoreNames.contains(STORES.DIVIDENDS)) {
        const oldStore = transaction.objectStore(STORES.DIVIDENDS);
        const oldRecords: Record<string, unknown>[] = [];
        let cursor = await oldStore.openCursor();
        while (cursor) {
          oldRecords.push(cursor.value as Record<string, unknown>);
          cursor = await cursor.continue();
        }

        db.deleteObjectStore(STORES.DIVIDENDS);
        const dStore = db.createObjectStore(STORES.DIVIDENDS, { keyPath: 'id' });
        dStore.createIndex('stockId', 'stockId', { unique: false });
        dStore.createIndex('exDate', 'exDate', { unique: false });
        dStore.createIndex('payDate', 'payDate', { unique: false });
        dStore.createIndex('type', 'type', { unique: false });

        for (const old of oldRecords) {
          const oldDiv = old as Record<string, unknown>;
          await dStore.put({
            id: oldDiv.id as string,
            stockId: oldDiv.stockId as string,
            exDate: (oldDiv.date as string) ?? '',
            payDate: (oldDiv.date as string) ?? '',
            type: (oldDiv.type as 'cash' | 'stock') ?? 'cash',
            qty: 0,
            rate: 0,
            amount: (oldDiv.amount as number) ?? 0,
            fee: 0,
            dividendYield: null,
            sharesReceived: (oldDiv.sharesReceived as number | null) ?? null,
            notes: (oldDiv.notes as string | null) ?? null,
            createdAt: (oldDiv.createdAt as number) ?? Date.now(),
            updatedAt: (oldDiv.updatedAt as number) ?? Date.now(),
          });
        }
      }

    },
  });

  try {
    const markers = await db.getAll(STORES.DATASET_MARKERS);
    for (const marker of markers) {
      if (marker.generation > activeDatasetGeneration) {
        activeDatasetGeneration = marker.generation;
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }

  return db;
}

/**
 * Clear all local IndexedDB stores.
 * Used on user sign-out or user switch to wipe the previous user's cache.
 */
export async function clearAllLocalData(): Promise<void> {
  const db = await getDB();
  for (const storeName of Object.values(STORES)) {
    const tx = db.transaction(storeName, 'readwrite');
    await tx.objectStore(storeName).clear();
    await tx.done;
  }
  setActiveDatasetGeneration(0);
}

// ============================================================
// Sync Queue
// ============================================================

/**
 * Enqueue a sync entry for the outbox pattern.
 * Called after each local CRUD to track unsynced changes.
 *
 * Simple CRUD functions now use enqueueSyncEntryInTx() inside a
 * shared transaction for atomicity. This function is still used by
 * batch operations (import, resync, dedup) where a separate tx is acceptable.
 */
/**
 * Count pending sync entries that haven't been pushed to Supabase yet.
 */
export async function getSyncQueueCount(): Promise<number> {
  const db = await getDB();
  return db.count(STORES.SYNC_QUEUE);
}

// Monotonic counter for sync ordering — assigned synchronously before the
// first await in enqueueSyncEntry, guaranteeing call-order is preserved
// even when thousands of entries are enqueued in the same millisecond.
// Seeded with Date.now() to be roughly time-ordered across page loads.
let syncSeqCounter: number = Date.now();

/** Keep the applied generation current so new queue entries carry it. */
export function setActiveDatasetGeneration(generation: number): void {
  activeDatasetGeneration = generation;
}

// Debounced auto-sync: every enqueue triggers a push to Supabase after
// a quiet period, so rapid edits (bulk import, batch deletes) collapse
// into a single sync cycle instead of hammering the API per entry.
let _syncTimer: ReturnType<typeof setTimeout> | null = null;

function requestSync(): void {
  if (!navigator.onLine) return;
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncTimer = setTimeout(async () => {
    try {
      const { backgroundSync } = await import('./sync');
      await backgroundSync();
    } catch {
      // ponytail: fire-and-forget, local data is safe either way
    }
  }, 2000);
}

/**
 * Enqueue a sync entry within an existing IDB transaction.
 * Used by CRUD functions to atomically write data + sync queue entry.
 */
function enqueueSyncEntryInTx(
  syncStore: IDBPObjectStore<ExpenseTrackerDB, (typeof STORES)[keyof typeof STORES][], typeof STORES.SYNC_QUEUE, 'readwrite'>,
  storeName: string,
  recordId: string,
  operation: SyncOperation,
  payload: unknown
): void {
  const seq = ++syncSeqCounter;
  syncStore.add({
    id: generateId(),
    storeName,
    recordId,
    operation,
    payload,
    timestamp: seq,
    retryCount: 0,
    datasetGeneration: activeDatasetGeneration,
  });
}

export async function enqueueSyncEntry<T>(
  storeName: string,
  recordId: string,
  operation: SyncOperation,
  payload: T | null
): Promise<void> {
  const seq = ++syncSeqCounter; // synchronous — order-preserving, no await before this
  const db = await getDB();
  await db.add(STORES.SYNC_QUEUE, {
    id: generateId(),
    storeName,
    recordId,
    operation,
    payload,
    timestamp: seq,
    retryCount: 0,
    datasetGeneration: activeDatasetGeneration,
    // Ownership is captured at write time. Without a marker the cache is
    // local-only or unowned, and the entry is never replayed for a signed-in
    // account until the cache is explicitly claimed.
    ownerId: readOwnerMarker(),
    state: 'pending',
  } satisfies SyncQueueEntry);
  requestSync(); // fire-and-forget, debounced
}

/** Account that owns the local cache, or null when no marker is present. */
function readOwnerMarker(): string | null {
  try {
    return localStorage.getItem(LAST_USER_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * Claim work written before the cache had an owner. Only call this after the
 * cache is verified for `userId`, and only for entries with no owner: entries
 * stamped for another account are never reassigned.
 */
export async function adoptUnownedQueueEntries(userId: string): Promise<number> {
  const db = await getDB();
  const tx = db.transaction(STORES.SYNC_QUEUE, 'readwrite');
  const queue = tx.objectStore(STORES.SYNC_QUEUE);
  const all = await queue.getAll();
  let adopted = 0;
  for (const entry of all) {
    if (entry.ownerId) continue;
    await queue.put({ ...entry, ownerId: userId });
    adopted += 1;
  }
  await tx.done;
  return adopted;
}

/** Server revision observed for a record at its last successful sync. */
export async function getSyncBaseline(
  storeName: string,
  recordId: string,
): Promise<SyncMetaEntry | undefined> {
  const db = await getDB();
  return db.get(STORES.SYNC_META, `${storeName}:${recordId}`);
}

/** Record the revision the server now holds for a record. */
export async function putSyncBaseline(
  storeName: string,
  recordId: string,
  ownerId: string | null,
  baselineRevision: string | null,
): Promise<void> {
  const db = await getDB();
  await db.put(STORES.SYNC_META, {
    id: `${storeName}:${recordId}`,
    storeName,
    recordId,
    ownerId,
    baselineRevision,
    updatedAt: Date.now(),
  } satisfies SyncMetaEntry);
}

// ============================================================
// Transaction CRUD
// ============================================================

/**
 * Retrieve all transactions, sorted by date descending.
 */
export async function getAllTransactions(): Promise<Transaction[]> {
  const db = await getDB();
  const txs = await db.getAll(STORES.TRANSACTIONS);
  return txs.sort((a, b) => {
    const dateCmp = b.date.localeCompare(a.date);
    if (dateCmp !== 0) return dateCmp;
    return b.createdAt - a.createdAt;
  });
}

/**
 * Validate a transaction record against spec §3.2 rules.
 * Throws on invalid data — callers should catch and surface to user.
 */
function validateTransaction(tx: Pick<Transaction, 'type' | 'amount' | 'category' | 'date' | 'fromAccount' | 'toAccount'>): void {
  if (typeof tx.amount !== 'number' || !isFinite(tx.amount) || tx.amount <= 0) {
    throw new Error('Transaction amount must be a positive number');
  }
  if (!tx.date || !/^\d{4}-\d{2}-\d{2}$/.test(tx.date)) {
    throw new Error('Transaction date must be in YYYY-MM-DD format');
  }
  if (!tx.category || tx.category.trim() === '') {
    throw new Error('Transaction category is required');
  }
  switch (tx.type) {
    case 'income':
      if (!tx.toAccount) throw new Error('Income transactions require a destination account');
      if (tx.fromAccount) throw new Error('Income transactions must not have a source account');
      break;
    case 'expense':
      if (!tx.fromAccount) throw new Error('Expense transactions require a source account');
      break;
    case 'transaction':
      if (!tx.fromAccount) throw new Error('Transfer transactions require a source account');
      if (!tx.toAccount) throw new Error('Transfer transactions require a destination account');
      if (tx.fromAccount === tx.toAccount) throw new Error('Transfer source and destination accounts must differ');
      break;
    default:
      throw new Error(`Invalid transaction type: ${tx.type}`);
  }
}

/**
 * Add a new transaction. Generates id and timestamps if missing.
 */
export async function addTransaction(
  tx: Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  validateTransaction(tx);
  const db = await getDB();
  const now = Date.now();
  const newTx: Transaction = {
    ...tx,
    id: generateId(),
    createdAt: now,
    updatedAt: now,
  };
  const idbTx = db.transaction([STORES.TRANSACTIONS, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.TRANSACTIONS).add(newTx);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.TRANSACTIONS, newTx.id, 'create', newTx);
  await idbTx.done;
  requestSync();
  return newTx.id;
}

/**
 * Update an existing transaction.
 */
export async function updateTransaction(tx: Transaction): Promise<void> {
  validateTransaction(tx);
  const db = await getDB();
  const existing = await db.get(STORES.TRANSACTIONS, tx.id);
  if (!existing) {
    throw new Error(`Transaction with id "${tx.id}" not found`);
  }
  const updated = { ...tx, updatedAt: Date.now() };
  const idbTx = db.transaction([STORES.TRANSACTIONS, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.TRANSACTIONS).put(updated);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.TRANSACTIONS, tx.id, 'update', updated);
  await idbTx.done;
  requestSync();
}

/**
 * Delete a transaction by ID.
 */
export async function deleteTransaction(id: string): Promise<void> {
  const db = await getDB();
  const idbTx = db.transaction([STORES.TRANSACTIONS, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.TRANSACTIONS).delete(id);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.TRANSACTIONS, id, 'delete', null);
  await idbTx.done;
  requestSync();
}

// ============================================================
// Account CRUD
// ============================================================

/**
 * Get all accounts, sorted by sortOrder then name.
 */
export async function getAllAccounts(): Promise<Account[]> {
  const db = await getDB();
  const accts = await db.getAll(STORES.ACCOUNTS);
  return accts.sort((a, b) => {
    const orderCmp = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    if (orderCmp !== 0) return orderCmp;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Add a new account. If sortOrder is not set, assigns it to the end.
 */
export async function addAccount(
  account: Omit<Account, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  const db = await getDB();
  const now = Date.now();
  const all = await db.getAll(STORES.ACCOUNTS);
  const maxOrder = all.reduce((max, a) => Math.max(max, a.sortOrder ?? 0), 0);
  const record: Account = {
    ...account,
    id: generateId(),
    createdAt: now,
    updatedAt: now,
    sortOrder: account.sortOrder ?? maxOrder + 1000,
  };
  const idbTx = db.transaction([STORES.ACCOUNTS, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.ACCOUNTS).add(record);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.ACCOUNTS, record.id, 'create', record);
  await idbTx.done;
  requestSync();
  return record.id;
}

/**
 * Update an existing account.
 */
export async function updateAccount(
  account: Partial<Account> & Pick<Account, 'id'>
): Promise<void> {
  const db = await getDB();
  const existing = await db.get(STORES.ACCOUNTS, account.id);
  if (!existing) {
    throw new Error(`Account with id "${account.id}" not found`);
  }
  const updated = { ...existing, ...account, updatedAt: Date.now() };
  const idbTx = db.transaction([STORES.ACCOUNTS, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.ACCOUNTS).put(updated);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.ACCOUNTS, account.id, 'update', updated);
  await idbTx.done;
  requestSync();
}

/**
 * Delete an account by ID.
 */
export async function deleteAccount(id: string): Promise<void> {
  const db = await getDB();
  const idbTx = db.transaction([STORES.ACCOUNTS, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.ACCOUNTS).delete(id);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.ACCOUNTS, id, 'delete', null);
  await idbTx.done;
  requestSync();
}

// ============================================================
// Account reordering — moves an account to a target position
// in the sorted list, then renormalizes all sortOrder values.
// Self-heals ties/undefined values instead of swapping raw numbers.
// ============================================================

async function reorderAccountsTo(id: string, targetIndex: number): Promise<void> {
  const db = await getDB();
  const all = await db.getAll(STORES.ACCOUNTS);
  const sorted = all.sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)
  );

  const fromIdx = sorted.findIndex((a) => a.id === id);
  if (fromIdx < 0 || targetIndex < 0 || targetIndex >= sorted.length || fromIdx === targetIndex) return;

  const [item] = sorted.splice(fromIdx, 1);
  sorted.splice(targetIndex, 0, item);

  const now = Date.now();
  const tx = db.transaction([STORES.ACCOUNTS, STORES.SYNC_QUEUE], 'readwrite');
  const store = tx.objectStore(STORES.ACCOUNTS);
  const syncStore = tx.objectStore(STORES.SYNC_QUEUE);
  const updated = sorted.map((acct, i) => ({ ...acct, sortOrder: i * 1000, updatedAt: now }));
  await Promise.all(updated.map((acct) => store.put(acct)));

  for (const acct of updated) {
    enqueueSyncEntryInTx(syncStore, STORES.ACCOUNTS, acct.id, 'update', acct);
  }

  await tx.done;
  requestSync();
}

/** Move account to a specific position (0-based) in the sorted list. */
export async function moveAccountTo(id: string, targetIndex: number): Promise<void> {
  return reorderAccountsTo(id, targetIndex);
}

// ============================================================
// Category CRUD
// ============================================================

/**
 * Get all categories, sorted by sortOrder then name.
 */
export async function getAllCategories(): Promise<Category[]> {
  const db = await getDB();
  const cats = await db.getAll(STORES.CATEGORIES);
  return cats.sort((a, b) => {
    const orderCmp = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    if (orderCmp !== 0) return orderCmp;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Add a new category. If sortOrder is not set, assigns it to the end of its type group.
 */
export async function addCategory(
  category: Omit<Category, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  const db = await getDB();
  const now = Date.now();
  const all = await db.getAll(STORES.CATEGORIES);
  const maxOrder = all
    .filter((c) => c.type === category.type)
    .reduce((max, c) => Math.max(max, c.sortOrder ?? 0), 0);
  const record: Category = {
    ...category,
    id: generateId(),
    createdAt: now,
    updatedAt: now,
    sortOrder: category.sortOrder ?? maxOrder + 1000,
  };
  const idbTx = db.transaction([STORES.CATEGORIES, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.CATEGORIES).add(record);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.CATEGORIES, record.id, 'create', record);
  await idbTx.done;
  requestSync();
  return record.id;
}

/**
 * Update an existing category.
 */
export async function updateCategory(
  category: Partial<Category> & Pick<Category, 'id'>
): Promise<void> {
  const db = await getDB();
  const existing = await db.get(STORES.CATEGORIES, category.id);
  if (!existing) {
    throw new Error(`Category with id "${category.id}" not found`);
  }
  const updated = { ...existing, ...category, updatedAt: Date.now() };
  const idbTx = db.transaction([STORES.CATEGORIES, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.CATEGORIES).put(updated);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.CATEGORIES, category.id, 'update', updated);
  await idbTx.done;
  requestSync();
}

/**
 * Delete a category by ID.
 */
export async function deleteCategory(id: string): Promise<void> {
  const db = await getDB();
  const idbTx = db.transaction([STORES.CATEGORIES, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.CATEGORIES).delete(id);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.CATEGORIES, id, 'delete', null);
  await idbTx.done;
  requestSync();
}

// ============================================================
// Category reordering — moves a category to a target position
// within its type group, then renormalizes all sortOrder values.
// ============================================================

async function reorderCategoriesTo(id: string, targetIndex: number): Promise<void> {
  const db = await getDB();
  const all = await db.getAll(STORES.CATEGORIES);
  const current = all.find((c) => c.id === id);
  if (!current) throw new Error(`Category "${id}" not found`);

  const group = all
    .filter((c) => c.type === current.type)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));

  const fromIdx = group.findIndex((c) => c.id === id);
  if (fromIdx < 0 || targetIndex < 0 || targetIndex >= group.length || fromIdx === targetIndex) return;

  const [item] = group.splice(fromIdx, 1);
  group.splice(targetIndex, 0, item);

  const now = Date.now();
  const tx = db.transaction([STORES.CATEGORIES, STORES.SYNC_QUEUE], 'readwrite');
  const store = tx.objectStore(STORES.CATEGORIES);
  const syncStore = tx.objectStore(STORES.SYNC_QUEUE);
  const updated = group.map((cat, i) => ({ ...cat, sortOrder: i * 1000, updatedAt: now }));
  await Promise.all(updated.map((cat) => store.put(cat)));

  for (const cat of updated) {
    enqueueSyncEntryInTx(syncStore, STORES.CATEGORIES, cat.id, 'update', cat);
  }

  await tx.done;
  requestSync();
}

/** Move category to a specific position (0-based) within its type group. */
export async function moveCategoryTo(id: string, targetIndex: number): Promise<void> {
  return reorderCategoriesTo(id, targetIndex);
}

// ============================================================
// Cash Denomination CRUD
// ============================================================

/**
 * Get all cash denomination records.
 */
export async function getAllCashDenominations(): Promise<CashDenomination[]> {
  const db = await getDB();
  return db.getAll(STORES.CASH_DENOMINATIONS);
}

/**
 * Add a new cash denomination record.
 */
export async function addCashDenomination(
  cd: Omit<CashDenomination, 'id'>
): Promise<string> {
  const db = await getDB();
  const id = generateId();
  const record = { ...cd, id };
  const idbTx = db.transaction([STORES.CASH_DENOMINATIONS, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.CASH_DENOMINATIONS).add(record);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.CASH_DENOMINATIONS, id, 'create', record);
  await idbTx.done;
  requestSync();
  return id;
}

/**
 * Delete a cash denomination record by ID.
 */
export async function deleteCashDenomination(id: string): Promise<void> {
  const db = await getDB();
  const idbTx = db.transaction([STORES.CASH_DENOMINATIONS, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.CASH_DENOMINATIONS).delete(id);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.CASH_DENOMINATIONS, id, 'delete', null);
  await idbTx.done;
  requestSync();
}

/**
 * Delete all cash denomination records for a given date.
 * Used to clear existing records before saving a fresh snapshot.
 */
export async function deleteCashDenominationsByDate(date: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction([STORES.CASH_DENOMINATIONS, STORES.SYNC_QUEUE], 'readwrite');
  const store = tx.objectStore(STORES.CASH_DENOMINATIONS);
  const syncStore = tx.objectStore(STORES.SYNC_QUEUE);
  const index = store.index('date');
  let cursor = await index.openCursor(date);
  while (cursor) {
    enqueueSyncEntryInTx(syncStore, STORES.CASH_DENOMINATIONS, cursor.value.id, 'delete', null);
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
  requestSync();
}

// ============================================================
// Balance Snapshot CRUD
// ============================================================

/**
 * Get all balance snapshots from IDB.
 * Returns a map of accountId → snapshot data for easy lookup.
 */
export async function getBalanceSnapshots(): Promise<Record<string, { value: number; updatedAt: number; useSubSplit?: boolean; subSplits?: { id: string; label: string; amount: number }[] }>> {
  const db = await getDB();
  const all = await db.getAll(STORES.BALANCE_SNAPSHOTS);
  const result: Record<string, { value: number; updatedAt: number; useSubSplit?: boolean; subSplits?: { id: string; label: string; amount: number }[] }> = {};
  for (const snap of all) {
    result[snap.accountId] = {
      value: snap.value,
      updatedAt: snap.updatedAt,
      useSubSplit: snap.useSubSplit,
      subSplits: snap.subSplits,
    };
  }
  return result;
}

/**
 * Upsert a balance snapshot for an account.
 * Uses accountId as the record id (one snapshot per account).
 * Enqueues sync entry for cross-device sync.
 */
export async function upsertBalanceSnapshot(accountId: string, data: { value: number; useSubSplit?: boolean; subSplits?: { id: string; label: string; amount: number }[] }): Promise<void> {
  const db = await getDB();
  const now = Date.now();
  const existing = await db.get(STORES.BALANCE_SNAPSHOTS, accountId);
  const snapshot: BalanceSnapshot = {
    id: accountId,
    accountId,
    value: data.value,
    updatedAt: now,
    useSubSplit: data.useSubSplit ?? false,
    subSplits: data.subSplits ?? [],
    createdAt: existing?.createdAt ?? now,
  };
  const operation: SyncOperation = existing ? 'update' : 'create';
  const tx = db.transaction([STORES.BALANCE_SNAPSHOTS, STORES.SYNC_QUEUE], 'readwrite');
  await tx.objectStore(STORES.BALANCE_SNAPSHOTS).put(snapshot);
  enqueueSyncEntryInTx(tx.objectStore(STORES.SYNC_QUEUE), STORES.BALANCE_SNAPSHOTS, accountId, operation, snapshot);
  await tx.done;
  requestSync();
}

// ============================================================
// Payout CRUD
// ============================================================

/**
 * Get all payout records.
 */
export async function getAllPayouts(): Promise<Payout[]> {
  const db = await getDB();
  return db.getAll(STORES.PAYOUTS);
}

/**
 * Add a new payout record.
 */
export async function addPayout(
  payout: Omit<Payout, 'id'>
): Promise<string> {
  const db = await getDB();
  const id = generateId();
  const record = { ...payout, id };
  const idbTx = db.transaction([STORES.PAYOUTS, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.PAYOUTS).add(record);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.PAYOUTS, id, 'create', record);
  await idbTx.done;
  requestSync();
  return id;
}

/**
 * Update an existing payout record.
 */
export async function updatePayout(payout: Payout): Promise<void> {
  const db = await getDB();
  const existing = await db.get(STORES.PAYOUTS, payout.id);
  if (!existing) {
    throw new Error(`Payout with id "${payout.id}" not found`);
  }
  const idbTx = db.transaction([STORES.PAYOUTS, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.PAYOUTS).put(payout);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.PAYOUTS, payout.id, 'update', payout);
  await idbTx.done;
  requestSync();
}

/**
 * Delete a payout record by ID.
 */
export async function deletePayout(id: string): Promise<void> {
  const db = await getDB();
  const idbTx = db.transaction([STORES.PAYOUTS, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.PAYOUTS).delete(id);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.PAYOUTS, id, 'delete', null);
  await idbTx.done;
  requestSync();
}

// ============================================================
// Budget Target CRUD
// ============================================================

/**
 * Get the effective budget target for a category + month.
 *
 * Hybrid lookup:
 * 1. Look for record where `category = cat AND month = targetMonth`
 * 2. If not found, look for record where `category = cat AND month IS NULL`
 * 3. If neither found, return 0
 */
export async function getBudgetTarget(category: string, month: string): Promise<number> {
  const db = await getDB();

  // 1. Look for per-month override
  const overrideIndex = db.transaction(STORES.BUDGET_TARGETS).store.index('category');
  let cursor = await overrideIndex.openCursor(category);
  while (cursor) {
    if (cursor.value.month === month) {
      return cursor.value.amount;
    }
    cursor = await cursor.continue();
  }

  // 2. Look for global default (month IS NULL)
  cursor = await overrideIndex.openCursor(category);
  while (cursor) {
    if (cursor.value.month === null) {
      return cursor.value.amount;
    }
    cursor = await cursor.continue();
  }

  // 3. Not found
  return 0;
}

/**
 * Upsert a budget target.
 *
 * If month is omitted (undefined), operates on the global default (month = null):
 *   - updates it if it exists, otherwise inserts a new global default.
 * If month is given:
 *   - updates the record for that category+month if it exists,
 *   - otherwise inserts a new record.
 */
export async function setBudgetTarget(
  category: string,
  amount: number,
  month?: string
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction([STORES.BUDGET_TARGETS, STORES.SYNC_QUEUE], 'readwrite');
  const store = tx.objectStore(STORES.BUDGET_TARGETS);
  const syncStore = tx.objectStore(STORES.SYNC_QUEUE);
  const index = store.index('category');

  const targetMonth = month ?? null;
  const now = Date.now();

  // Try to find existing record
  let cursor = await index.openCursor(category);
  while (cursor) {
    if (cursor.value.month === targetMonth) {
      // Update existing
      const updated = {
        ...cursor.value,
        amount,
        updatedAt: now,
      };
      await cursor.update(updated);
      enqueueSyncEntryInTx(syncStore, STORES.BUDGET_TARGETS, updated.id, 'update', updated);
      await tx.done;
      requestSync();
      return;
    }
    cursor = await cursor.continue();
  }

  // Insert new
  const newTarget: BudgetTarget = {
    id: generateId(),
    category,
    month: targetMonth,
    amount,
    createdAt: now,
    updatedAt: now,
  };
  await store.add(newTarget);
  enqueueSyncEntryInTx(syncStore, STORES.BUDGET_TARGETS, newTarget.id, 'create', newTarget);
  await tx.done;
  requestSync();
}

/**
 * Get all budget target records.
 */
export async function getAllBudgetTargets(): Promise<BudgetTarget[]> {
  const db = await getDB();
  return db.getAll(STORES.BUDGET_TARGETS);
}

// ============================================================
// Stock CRUD
// ============================================================

/**
 * Get all stocks, sorted by sortOrder.
 */
export async function getAllStocks(): Promise<Stock[]> {
  const db = await getDB();
  const all = await db.getAll(STORES.STOCKS);
  return all.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

/**
 * Add a new stock. Auto-assigns sortOrder to the end.
 */
export async function addStock(
  stock: Omit<Stock, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  const db = await getDB();
  const now = Date.now();
  const id = crypto.randomUUID();
  const all = await db.getAll(STORES.STOCKS);
  const maxOrder = all.reduce((max, s) => Math.max(max, s.sortOrder ?? 0), 0);
  const record: Stock = { ...stock, id, sortOrder: maxOrder + 1000, createdAt: now, updatedAt: now };
  const idbTx = db.transaction([STORES.STOCKS, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.STOCKS).add(record);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.STOCKS, id, 'create', record);
  await idbTx.done;
  requestSync();
  return id;
}

/**
 * Update an existing stock.
 */
export async function updateStock(
  stock: Partial<Stock> & Pick<Stock, 'id'>
): Promise<void> {
  const db = await getDB();
  const existing = await db.get(STORES.STOCKS, stock.id);
  if (!existing) throw new Error(`Stock "${stock.id}" not found`);
  const updated: Stock = { ...existing, ...stock, updatedAt: Date.now() };
  const idbTx = db.transaction([STORES.STOCKS, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.STOCKS).put(updated);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.STOCKS, stock.id, 'update', updated);
  await idbTx.done;
  requestSync();
}

/**
 * Delete a stock by ID, cascading to its stock transactions and dividends.
 */
export async function deleteStock(id: string): Promise<void> {
  const db = await getDB();
  // ponytail: cascade-delete stockTransactions + dividends for this stock
  const idbTx = db.transaction(
    [STORES.STOCKS, STORES.STOCK_TRANSACTIONS, STORES.DIVIDENDS, STORES.SYNC_QUEUE],
    'readwrite'
  );
  await idbTx.objectStore(STORES.STOCKS).delete(id);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.STOCKS, id, 'delete', null);

  // Delete stock transactions for this stock
  const txnIndex = idbTx.objectStore(STORES.STOCK_TRANSACTIONS).index('stockId');
  let txnCursor = await txnIndex.openCursor(id);
  while (txnCursor) {
    enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.STOCK_TRANSACTIONS, txnCursor.value.id, 'delete', null);
    await txnCursor.delete();
    txnCursor = await txnCursor.continue();
  }

  // Delete dividends for this stock
  const divIndex = idbTx.objectStore(STORES.DIVIDENDS).index('stockId');
  let divCursor = await divIndex.openCursor(id);
  while (divCursor) {
    enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.DIVIDENDS, divCursor.value.id, 'delete', null);
    await divCursor.delete();
    divCursor = await divCursor.continue();
  }

  await idbTx.done;
  requestSync();
}

/**
 * Move a stock to a specific position (0-based) in the sorted list.
 */
export async function moveStockTo(id: string, targetIndex: number): Promise<void> {
  return reorderStocksTo(id, targetIndex);
}

async function reorderStocksTo(id: string, targetIndex: number): Promise<void> {
  const db = await getDB();
  const all = await db.getAll(STORES.STOCKS);
  const sorted = all.sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
  );

  const fromIdx = sorted.findIndex((s) => s.id === id);
  if (fromIdx < 0 || targetIndex < 0 || targetIndex >= sorted.length || fromIdx === targetIndex) return;

  const [item] = sorted.splice(fromIdx, 1);
  sorted.splice(targetIndex, 0, item);

  const now = Date.now();
  const tx = db.transaction([STORES.STOCKS, STORES.SYNC_QUEUE], 'readwrite');
  const store = tx.objectStore(STORES.STOCKS);
  const syncStore = tx.objectStore(STORES.SYNC_QUEUE);
  const updated = sorted.map((s, i) => ({ ...s, sortOrder: i * 1000, updatedAt: now }));
  await Promise.all(updated.map((s) => store.put(s)));

  for (const s of updated) {
    enqueueSyncEntryInTx(syncStore, STORES.STOCKS, s.id, 'update', s);
  }

  await tx.done;
  requestSync();
}

// ── Stock Transaction CRUD ──────────────────────────────────

export async function getAllStockTransactions(): Promise<StockTransaction[]> {
  const db = await getDB();
  return db.getAll(STORES.STOCK_TRANSACTIONS);
}

export async function addStockTransaction(tx: Omit<StockTransaction, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
  const db = await getDB();
  const now = Date.now();
  const id = crypto.randomUUID();
  const record: StockTransaction = { ...tx, id, createdAt: now, updatedAt: now };
  const idbTx = db.transaction([STORES.STOCK_TRANSACTIONS, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.STOCK_TRANSACTIONS).add(record);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.STOCK_TRANSACTIONS, id, 'create', record);
  await idbTx.done;
  requestSync();
  return id;
}

export async function deleteStockTransaction(id: string): Promise<void> {
  const db = await getDB();
  const idbTx = db.transaction([STORES.STOCK_TRANSACTIONS, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.STOCK_TRANSACTIONS).delete(id);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.STOCK_TRANSACTIONS, id, 'delete', null);
  await idbTx.done;
  requestSync();
}

// ── Dividend CRUD ───────────────────────────────────────────

export async function getAllDividends(): Promise<Dividend[]> {
  const db = await getDB();
  return db.getAll(STORES.DIVIDENDS);
}

export async function addDividend(d: Omit<Dividend, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
  const db = await getDB();
  const now = Date.now();
  const id = crypto.randomUUID();
  const record: Dividend = { ...d, id, createdAt: now, updatedAt: now };
  const idbTx = db.transaction([STORES.DIVIDENDS, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.DIVIDENDS).add(record);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.DIVIDENDS, id, 'create', record);
  await idbTx.done;
  requestSync();
  return id;
}

export async function deleteDividend(id: string): Promise<void> {
  const db = await getDB();
  const idbTx = db.transaction([STORES.DIVIDENDS, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.DIVIDENDS).delete(id);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.DIVIDENDS, id, 'delete', null);
  await idbTx.done;
  requestSync();
}

export async function updateStockTransaction(id: string, updates: Partial<StockTransaction>): Promise<void> {
  const db = await getDB();
  const existing = await db.get(STORES.STOCK_TRANSACTIONS, id);
  if (!existing) throw new Error(`Stock transaction ${id} not found`);
  const record: StockTransaction = { ...existing, ...updates, id, updatedAt: Date.now() };
  const idbTx = db.transaction([STORES.STOCK_TRANSACTIONS, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.STOCK_TRANSACTIONS).put(record);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.STOCK_TRANSACTIONS, id, 'update', record);
  await idbTx.done;
  requestSync();
}

export async function updateDividend(id: string, updates: Partial<Dividend>): Promise<void> {
  const db = await getDB();
  const existing = await db.get(STORES.DIVIDENDS, id);
  if (!existing) throw new Error(`Dividend ${id} not found`);
  const record: Dividend = { ...existing, ...updates, id, updatedAt: Date.now() };
  const idbTx = db.transaction([STORES.DIVIDENDS, STORES.SYNC_QUEUE], 'readwrite');
  await idbTx.objectStore(STORES.DIVIDENDS).put(record);
  enqueueSyncEntryInTx(idbTx.objectStore(STORES.SYNC_QUEUE), STORES.DIVIDENDS, id, 'update', record);
  await idbTx.done;
  requestSync();
}

// ============================================================
// Export / Import
// ============================================================

/** Shape of a full backup JSON. */
export interface BackupData {
  version: 2;
  exportedAt: string;
  /** Records keyed by IndexedDB store name; every store the app owns. */
  data: Record<string, unknown[]>;
}

/** Six-store file written by builds before 0.19.8. */
export interface LegacyBackupV1 {
  version: 1;
  exportedAt: string;
  data: {
    transactions: Transaction[];
    accounts: Account[];
    categories: Category[];
    cashDenominations: CashDenomination[];
    payouts: Payout[];
    budgetTargets: BudgetTarget[];
  };
}

/** Every store the app owns, in dependency-friendly order. */
const BACKUP_STORES = Object.values(STORES);

/** Legacy field name → store name, for version-1 files. */
const LEGACY_STORE_FIELDS: Record<keyof LegacyBackupV1['data'], string> = {
  transactions: STORES.TRANSACTIONS,
  accounts: STORES.ACCOUNTS,
  categories: STORES.CATEGORIES,
  cashDenominations: STORES.CASH_DENOMINATIONS,
  payouts: STORES.PAYOUTS,
  budgetTargets: STORES.BUDGET_TARGETS,
};

/** Financial stores whose restored records must be pushed to the cloud. */
const REENQUEUE_ORDER = [
  STORES.ACCOUNTS,
  STORES.CATEGORIES,
  STORES.CASH_DENOMINATIONS,
  STORES.PAYOUTS,
  STORES.BUDGET_TARGETS,
  STORES.BALANCE_SNAPSHOTS,
  STORES.STOCKS,
  STORES.STOCK_TRANSACTIONS,
  STORES.DIVIDENDS,
  STORES.TRANSACTIONS,
] as const;

/** Map any supported file to records keyed by store name. */
export function normalizeBackup(input: BackupData | LegacyBackupV1): Record<string, unknown[]> {
  if (input.version === 2) return input.data;
  const data: Record<string, unknown[]> = {};
  for (const [field, store] of Object.entries(LEGACY_STORE_FIELDS)) {
    const records = (input.data as Record<string, unknown[] | undefined>)[field];
    if (Array.isArray(records)) data[store] = records;
  }
  return data;
}

export async function exportAllData(): Promise<BackupData> {
  const db = await getDB();
  const tx = db.transaction(BACKUP_STORES, 'readonly');
  const data: Record<string, unknown[]> = {};
  for (const store of BACKUP_STORES) {
    data[store] = (await tx.objectStore(store).getAll()) as unknown[];
  }
  await tx.done;
  return { version: 2, exportedAt: new Date().toISOString(), data };
}

/**
 * Import a full backup — replaces only the stores the file carries, so a
 * six-store legacy file cannot wipe safety stores it never captured.
 */
export async function importAllData(backup: BackupData | LegacyBackupV1): Promise<void> {
  const data = normalizeBackup(backup);
  const provided = BACKUP_STORES.filter((store) => Array.isArray(data[store]));
  const db = await getDB();
  const tx = db.transaction(provided, 'readwrite');
  for (const store of provided) {
    const objectStore = tx.objectStore(store);
    await objectStore.clear();
    for (const record of data[store]) await objectStore.add(record as never);
  }
  await tx.done;

  // Re-enqueue restored financial records so they reach Supabase.
  for (const store of REENQUEUE_ORDER) {
    if (!provided.includes(store)) continue;
    for (const record of data[store]) {
      const id = (record as { id?: unknown }).id;
      if (typeof id !== 'string') continue;
      await enqueueSyncEntry(store, id, 'create', record);
    }
  }
}

/** Every store that can hold user records: financial data, outbox, markers. */
const LOCAL_DATA_STORES = Object.values(STORES);

/**
 * True when any local store holds a record. Used before claiming an unmarked
 * cache for a signed-in account: an unowned cache with data must fail closed,
 * so its records are never exposed or reassigned. Reads only; never mutates.
 */
export async function hasAnyLocalData(): Promise<boolean> {
  const db = await getDB();
  const tx = db.transaction(LOCAL_DATA_STORES, 'readonly');
  let found = false;
  for (const storeName of LOCAL_DATA_STORES) {
    // The whole check stays inside one readonly transaction; the result is
    // only used after it completes.
    found = (await tx.objectStore(storeName).count()) > 0;
    if (found) break;
  }
  await tx.done;
  return found;
}

/**
 * Export transactions as CSV (RFC 4180-ish) for spreadsheet import.
 * Columns: id, date, type, category, fromAccount, toAccount, amount, description, createdAt, updatedAt
 */
export function transactionsToCsv(txs: Transaction[]): string {
  const header = 'id,date,type,category,fromAccount,toAccount,amount,description,createdAt,updatedAt';
  const escape = (v: unknown): string => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = txs.map((tx) =>
    [tx.id, tx.date, tx.type, escape(tx.category), tx.fromAccount ?? '', tx.toAccount ?? '', tx.amount, escape(tx.description ?? ''), tx.createdAt, tx.updatedAt].join(',')
  );
  return [header, ...rows].join('\n');
}

// ============================================================
// UUID data migration — convert existing slug IDs to proper UUIDs
// ============================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

function remapAccountRef(id: string | null, acctMap: Map<string, string>): string | null {
  if (!id) return null;
  return acctMap.get(id) ?? id;
}

/**
 * Rewrite only the identity fields of a replacement snapshot. Everything else
 * in the snapshot stays byte-for-byte what the import committed.
 */
function remapSnapshot(
  snapshot: DatasetSnapshot,
  acctMap: Map<string, string>,
  catMap: Map<string, string>
): DatasetSnapshot {
  return {
    ...snapshot,
    accounts: snapshot.accounts.map((account) => {
      const id = acctMap.get(account.id);
      return id ? { ...account, id } : account;
    }),
    categories: snapshot.categories.map((category) => {
      const id = catMap.get(category.id);
      return id ? { ...category, id } : category;
    }),
    transactions: snapshot.transactions.map((transaction) => ({
      ...transaction,
      fromAccount: remapAccountRef(transaction.fromAccount, acctMap),
      toAccount: remapAccountRef(transaction.toAccount, acctMap),
    })),
  };
}

// Bumped from `uuid_migration_done`: installations that ran the earlier
// migration still run this corrected one once, then this key suppresses scans.
const UUID_MIGRATION_DONE_KEY = 'uuid_migration_v2_done';

/**
 * One-shot migration: find all accounts and categories whose IDs are not
 * valid UUIDs (e.g. from an old CSV import that used slugId()), generate
 * new UUIDs for them, and rewrite every persisted reference in the same
 * readwrite transaction:
 *
 *   - accounts store (old key removed, new key written)
 *   - categories store (old key removed, new key written)
 *   - transactions store (fromAccount / toAccount)
 *   - balanceSnapshots store (id / accountId, one snapshot per account)
 *   - sync queue (recordId + payload id / accountId / account refs)
 *   - datasetMarkers snapshots (account IDs, category IDs, transaction refs)
 *
 * Deleting the old primary key before the new one is written is required:
 * `accounts.name` is a unique index, so leaving the old record behind makes
 * the insert fail with a ConstraintError.
 *
 * The completion flag is written only after the transaction commits. A failed
 * transaction rolls back every store, so a retry starts from a clean state.
 *
 * The flag is versioned: `uuid_migration_v2_done` guards this corrected
 * migration. The earlier `uuid_migration_done` key is deliberately ignored,
 * so an installation that ran the first migration still runs this one once
 * instead of trusting a marker from code that left snapshot references stale.
 */
export async function ensureUuids(): Promise<void> {
  // ponytail: one-shot guard for this migration version — skip once it committed
  try {
    if (localStorage.getItem(UUID_MIGRATION_DONE_KEY)) return;
  } catch { /* localStorage unavailable */ }

  const db = await getDB();
  const [existingAccounts, existingCategories] = await Promise.all([
    db.getAll(STORES.ACCOUNTS),
    db.getAll(STORES.CATEGORIES),
  ]);

  // Cheap pre-check so an already-migrated database does not open a six-store
  // readwrite transaction on every sync cycle.
  if (
    !existingAccounts.some((account) => !isUuid(account.id)) &&
    !existingCategories.some((category) => !isUuid(category.id))
  ) {
    return;
  }

  const tx = db.transaction(
    [
      STORES.ACCOUNTS,
      STORES.CATEGORIES,
      STORES.TRANSACTIONS,
      STORES.BALANCE_SNAPSHOTS,
      STORES.SYNC_QUEUE,
      STORES.DATASET_MARKERS,
    ],
    'readwrite'
  );

  // Observe the abort from the start so a failed write never surfaces as an
  // unhandled rejection; the caller still receives the write error.
  const settlement = tx.done.catch(() => undefined);

  try {
    const acctStore = tx.objectStore(STORES.ACCOUNTS);
    const catStore = tx.objectStore(STORES.CATEGORIES);

    const accounts = await acctStore.getAll();
    const categories = await catStore.getAll();

    const acctMap = new Map<string, string>(); // old slug → new UUID
    for (const account of accounts) {
      if (!isUuid(account.id)) acctMap.set(account.id, crypto.randomUUID());
    }
    const catMap = new Map<string, string>(); // old slug → new UUID
    for (const category of categories) {
      if (!isUuid(category.id)) catMap.set(category.id, crypto.randomUUID());
    }

    if (acctMap.size === 0 && catMap.size === 0) {
      await tx.done;
      return;
    }

    for (const account of accounts) {
      const id = acctMap.get(account.id);
      if (!id) continue;
      await acctStore.delete(account.id);
      await acctStore.put({ ...account, id });
    }

    for (const category of categories) {
      const id = catMap.get(category.id);
      if (!id) continue;
      await catStore.delete(category.id);
      await catStore.put({ ...category, id });
    }

    const txStore = tx.objectStore(STORES.TRANSACTIONS);
    for (const transaction of await txStore.getAll()) {
      const fromAccount = remapAccountRef(transaction.fromAccount, acctMap);
      const toAccount = remapAccountRef(transaction.toAccount, acctMap);
      if (fromAccount !== transaction.fromAccount || toAccount !== transaction.toAccount) {
        await txStore.put({ ...transaction, fromAccount, toAccount });
      }
    }

    const snapshotStore = tx.objectStore(STORES.BALANCE_SNAPSHOTS);
    for (const snapshot of await snapshotStore.getAll()) {
      const accountId = acctMap.get(snapshot.accountId) ?? acctMap.get(snapshot.id);
      if (!accountId) continue;
      await snapshotStore.delete(snapshot.id);
      if (snapshot.accountId !== snapshot.id) await snapshotStore.delete(snapshot.accountId);
      await snapshotStore.put({ ...snapshot, id: accountId, accountId });
    }

    const queueStore = tx.objectStore(STORES.SYNC_QUEUE);
    for (const entry of await queueStore.getAll()) {
      let changed = false;
      const remapped = { ...entry };

      if (acctMap.has(remapped.recordId)) {
        remapped.recordId = acctMap.get(remapped.recordId)!;
        changed = true;
      } else if (catMap.has(remapped.recordId)) {
        remapped.recordId = catMap.get(remapped.recordId)!;
        changed = true;
      }

      if (remapped.payload) {
        const p = remapped.payload as Record<string, unknown>;
        if (typeof p.id === 'string') {
          if (acctMap.has(p.id)) { p.id = acctMap.get(p.id)!; changed = true; }
          else if (catMap.has(p.id)) { p.id = catMap.get(p.id)!; changed = true; }
        }
        if (typeof p.accountId === 'string' && acctMap.has(p.accountId)) {
          p.accountId = acctMap.get(p.accountId)!;
          changed = true;
        }
        if (typeof p.fromAccount === 'string') {
          const fromAccount = remapAccountRef(p.fromAccount, acctMap);
          if (fromAccount !== p.fromAccount) { p.fromAccount = fromAccount; changed = true; }
        }
        if (typeof p.toAccount === 'string') {
          const toAccount = remapAccountRef(p.toAccount, acctMap);
          if (toAccount !== p.toAccount) { p.toAccount = toAccount; changed = true; }
        }
      }

      if (changed) await queueStore.put(remapped);
    }

    const markerStore = tx.objectStore(STORES.DATASET_MARKERS);
    for (const marker of await markerStore.getAll()) {
      if (!marker.snapshot) continue;
      await markerStore.put({
        ...marker,
        snapshot: remapSnapshot(marker.snapshot, acctMap, catMap),
      });
    }

    await tx.done;
  } catch (error) {
    await settlement;
    throw error;
  }

  try { localStorage.setItem(UUID_MIGRATION_DONE_KEY, '1'); } catch { /* ignore */ }
}

/**
 * Re-enqueue every record from every data store into the sync queue.
 * Use this after deploying the monotonic-counter fix to recover entries
 * that were silently dropped after 5 retries due to the FK-ordering bug.
 *
 * Clears the queue first, then enqueues in dependency order:
 * accounts → categories → cash denominations → payouts → budget targets → transactions.
 */
export async function resyncAll(): Promise<{ enqueued: number; skipped: number }> {
  const db = await getDB();

  // Existing work is never discarded. Paused entries, conflicts and delete
  // operations carry payloads a rebuild from local rows cannot reproduce.
  const queued = new Set(
    (await db.getAll(STORES.SYNC_QUEUE)).map((entry) => `${entry.storeName}:${entry.recordId}`),
  );

  // Dependency order: parents before the records that reference them.
  const ordered: Array<[string, Array<{ id: string }>]> = [
    [STORES.ACCOUNTS, await db.getAll(STORES.ACCOUNTS)],
    [STORES.CATEGORIES, await db.getAll(STORES.CATEGORIES)],
    [STORES.CASH_DENOMINATIONS, await db.getAll(STORES.CASH_DENOMINATIONS)],
    [STORES.PAYOUTS, await db.getAll(STORES.PAYOUTS)],
    [STORES.BUDGET_TARGETS, await db.getAll(STORES.BUDGET_TARGETS)],
    [STORES.TRANSACTIONS, await db.getAll(STORES.TRANSACTIONS)],
  ];

  let enqueued = 0;
  let skipped = 0;
  for (const [storeName, records] of ordered) {
    for (const record of records) {
      const key = `${storeName}:${record.id}`;
      if (queued.has(key)) {
        skipped += 1;
        continue;
      }
      await enqueueSyncEntry(storeName, record.id, 'create', record);
      queued.add(key);
      enqueued += 1;
    }
  }
  return { enqueued, skipped };
}

// ============================================================
// CSV Import
// ============================================================

/**
 * Parse a CSV string and replace the six managed stores in one IndexedDB
 * transaction. The same transaction writes the durable replacement marker
 * holding the immutable snapshot and clears stale managed sync entries.
 *
 * Accounts whose names match exactly one existing account keep that ID so
 * transaction references survive the replacement. An authenticated import also
 * drops any obsolete local-only marker in the same transaction, so a stale
 * local snapshot cannot be adopted by a later account.
 */
export async function importFromCsv(
  csvText: string,
  userId: string = LOCAL_DATASET_OWNER
): Promise<ParsedCsv> {
  const parsed = parseCsv(csvText);

  const db = await getDB();
  const tx = db.transaction(
    [...MANAGED_STORES, STORES.SYNC_QUEUE, STORES.DATASET_MARKERS],
    'readwrite'
  );

  const acctStore = tx.objectStore(STORES.ACCOUNTS);
  const catStore = tx.objectStore(STORES.CATEGORIES);
  const txStore = tx.objectStore(STORES.TRANSACTIONS);
  const markerStore = tx.objectStore(STORES.DATASET_MARKERS);

  // A failed write aborts the transaction. Observe its rejection from the
  // start so the AbortError never surfaces unhandled; the caller gets the
  // write error that caused the abort.
  const settlement = tx.done.catch(() => undefined);

  try {
    const existingAccounts = await acctStore.getAll();
    const retained = retainExistingAccountIds(parsed, existingAccounts);

    await acctStore.clear();
    await catStore.clear();
    await txStore.clear();
    await tx.objectStore(STORES.CASH_DENOMINATIONS).clear();
    await tx.objectStore(STORES.PAYOUTS).clear();
    await tx.objectStore(STORES.BUDGET_TARGETS).clear();

    const now = Date.now();

    const addedTransactions: Transaction[] = retained.transactions.map((t) => ({
      ...t,
      id: generateId(),
      createdAt: now,
      updatedAt: now,
    }));

    for (const account of retained.accounts) {
      await acctStore.add(account);
    }
    for (const category of retained.categories) {
      await catStore.add(category);
    }
    for (const transaction of addedTransactions) {
      await txStore.add(transaction);
    }

    const previous = (await markerStore.get(userId)) ?? null;
    const marker: DatasetReplacementMarker = {
      userId,
      generation: nextDatasetGeneration(previous),
      snapshotId: generateId(),
      status: 'pending',
      snapshot: {
        accounts: retained.accounts,
        categories: retained.categories,
        transactions: addedTransactions,
        cashDenominations: [],
        payouts: [],
        budgetTargets: [],
      },
      remoteGeneration: null,
      attempts: 0,
      lastError: null,
      updatedAt: now,
    };
    await markerStore.put(marker);
    if (userId !== LOCAL_DATASET_OWNER) {
      await markerStore.delete(LOCAL_DATASET_OWNER);
    }

    const syncStore = tx.objectStore(STORES.SYNC_QUEUE);
    let syncCursor = await syncStore.index('byTimestamp').openCursor();
    while (syncCursor) {
      if (isManagedStore(syncCursor.value.storeName)) {
        await syncCursor.delete();
      }
      syncCursor = await syncCursor.continue();
    }

    await tx.done;

    setActiveDatasetGeneration(marker.generation);
    requestSync();
    return retained;
  } catch (error) {
    // Wait for the abort to finish rolling back every store, then rethrow the
    // failure that triggered it.
    await settlement;
    throw error;
  }
}

/**
 * Read the durable replacement marker for a user. The marker survives reloads
 * and failed cloud attempts.
 */
export async function getDatasetReplacementMarker(
  userId: string
): Promise<DatasetReplacementMarker | null> {
  const db = await getDB();
  return (await db.get(STORES.DATASET_MARKERS, userId)) ?? null;
}

export async function putDatasetReplacementMarker(
  marker: DatasetReplacementMarker
): Promise<void> {
  const db = await getDB();
  await db.put(STORES.DATASET_MARKERS, marker);
}

/**
 * Rebuild a conflict snapshot from the current local managed stores and clear
 * the managed queue entries it represents in the same transaction. The marker
 * is re-read and validated inside that transaction, and the next generation is
 * derived from it there, so a concurrent import or reconciliation is never
 * overwritten with stale data. Returns the prepared pending marker, or null
 * when the current marker is no longer a conflict.
 */
export async function prepareConflictReplacement(
  userId: string
): Promise<DatasetReplacementMarker | null> {
  const db = await getDB();
  const tx = db.transaction(
    [...MANAGED_STORES, STORES.SYNC_QUEUE, STORES.DATASET_MARKERS],
    'readwrite'
  );
  const markerStore = tx.objectStore(STORES.DATASET_MARKERS);
  const current = await markerStore.get(userId);
  if (!current || current.status !== 'conflict') {
    await tx.done;
    return null;
  }

  const [accounts, categories, transactions, cashDenominations, payouts, budgetTargets] =
    await Promise.all([
      tx.objectStore(STORES.ACCOUNTS).getAll(),
      tx.objectStore(STORES.CATEGORIES).getAll(),
      tx.objectStore(STORES.TRANSACTIONS).getAll(),
      tx.objectStore(STORES.CASH_DENOMINATIONS).getAll(),
      tx.objectStore(STORES.PAYOUTS).getAll(),
      tx.objectStore(STORES.BUDGET_TARGETS).getAll(),
    ]);

  const syncStore = tx.objectStore(STORES.SYNC_QUEUE);
  let cursor = await syncStore.index('byTimestamp').openCursor();
  while (cursor) {
    if (isManagedStore(cursor.value.storeName)) {
      await cursor.delete();
    }
    cursor = await cursor.continue();
  }

  const generation = nextDatasetGeneration(current);
  const marker: DatasetReplacementMarker = {
    ...current,
    generation,
    status: 'pending',
    snapshot: {
      accounts,
      categories,
      transactions,
      cashDenominations,
      payouts,
      budgetTargets,
    },
    snapshotId: generateId(),
    remoteGeneration: null,
    attempts: 0,
    lastError: null,
    updatedAt: Date.now(),
  };
  await markerStore.put(marker);
  await tx.done;

  setActiveDatasetGeneration(generation);
  return marker;
}

// ============================================================
// Orphan review
// ============================================================

export async function getOrphanAccountGroups(): Promise<MissingAccountGroup[]> {
  const db = await getDB();
  const [transactions, accounts] = await Promise.all([
    db.getAll(STORES.TRANSACTIONS),
    db.getAll(STORES.ACCOUNTS),
  ]);
  return groupTransactionsByMissingAccount(transactions, accounts);
}

/**
 * Point every reference to `sourceAccountId` at an existing user-selected
 * account. Only matching from/to references change; no transaction is deleted.
 */
export async function relinkOrphanedAccountRefs(
  sourceAccountId: string,
  targetAccountId: string,
  expectedTransactionIds: string[]
): Promise<number> {
  if (sourceAccountId === targetAccountId) {
    throw new Error('Choose an account that is different from the missing one.');
  }

  const db = await getDB();
  const tx = db.transaction(
    [STORES.TRANSACTIONS, STORES.ACCOUNTS, STORES.SYNC_QUEUE],
    'readwrite'
  );
  const txStore = tx.objectStore(STORES.TRANSACTIONS);
  const syncStore = tx.objectStore(STORES.SYNC_QUEUE);

  const abort = async (message: string): Promise<never> => {
    tx.abort();
    await tx.done.catch(() => {});
    throw new Error(message);
  };

  if (!(await tx.objectStore(STORES.ACCOUNTS).get(targetAccountId))) {
    return abort('Target account not found.');
  }

  const transactions = await txStore.getAll();
  const affectedIds = affectedTransactionIds(transactions, sourceAccountId).sort();
  const reviewedIds = [...new Set(expectedTransactionIds)].sort();
  if (
    affectedIds.length !== reviewedIds.length ||
    affectedIds.some((id, index) => id !== reviewedIds[index])
  ) {
    return abort(
      'The missing-account transactions changed. Review the updated list and try again.'
    );
  }

  const selfTransfers = findSelfTransferConflicts(
    transactions,
    sourceAccountId,
    targetAccountId
  );
  if (selfTransfers.length > 0) {
    return abort(
      `${selfTransfers.length} transfer${selfTransfers.length === 1 ? '' : 's'} would use the same account on both sides. Edit ${selfTransfers.length === 1 ? 'that transaction' : 'those transactions'} individually.`
    );
  }

  const updatedAt = Date.now();
  const { updated, count } = relinkTransactionReferences(
    transactions,
    sourceAccountId,
    targetAccountId,
    updatedAt
  );

  for (const record of updated) {
    await txStore.put(record);
    enqueueSyncEntryInTx(syncStore, STORES.TRANSACTIONS, record.id, 'update', record);
  }

  await tx.done;

  if (count > 0) requestSync();
  return count;
}

// ── Auto-backup ───────────────────────────────────────────────

const AUTO_BACKUP_DATA_KEY = 'auto-backup-data';
const AUTO_BACKUP_TIME_KEY = 'auto-backup-time';
const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Export all data and save to localStorage as an auto-backup.
 * Only runs if the last backup was more than 24 hours ago.
 * Returns true if a backup was saved, false if skipped.
 * Silently catches all errors — never throws.
 */
export async function saveAutoBackup(): Promise<boolean> {
  try {
    const lastTime = localStorage.getItem(AUTO_BACKUP_TIME_KEY);
    if (lastTime) {
      const elapsed = Date.now() - new Date(lastTime).getTime();
      if (elapsed < AUTO_BACKUP_INTERVAL_MS) return false;
    }
    const backup = await exportAllData();
    localStorage.setItem(AUTO_BACKUP_DATA_KEY, JSON.stringify(backup));
    localStorage.setItem(AUTO_BACKUP_TIME_KEY, backup.exportedAt);
    return true;
  } catch {
    // localStorage full, quota exceeded, or IndexedDB error — never throw
    return false;
  }
}

/**
 * Read the auto-backup from localStorage.
 * Returns `{ backup, timestamp }` or `null` if none exists or data is corrupt.
 */
export function getAutoBackup(): { backup: BackupData; timestamp: string } | null {
  try {
    const data = localStorage.getItem(AUTO_BACKUP_DATA_KEY);
    const timestamp = localStorage.getItem(AUTO_BACKUP_TIME_KEY);
    if (!data || !timestamp) return null;
    const backup = JSON.parse(data) as BackupData;
    if (!backup.version || !backup.data) return null;
    return { backup, timestamp };
  } catch {
    return null;
  }
}
