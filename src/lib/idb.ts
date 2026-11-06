// ============================================================
// IndexedDB wrapper using the `idb` library
// Provides CRUD operations for transactions, accounts, categories,
// cash denominations, and payouts.
// ============================================================

import { openDB, type IDBPDatabase, type IDBPObjectStore } from 'idb';
import type { Transaction, Account, Category, CashDenomination, Payout, BudgetTarget, Stock, StockTransaction, Dividend, BalanceSnapshot } from '@/types';
import {
  DB_NAME,
  DB_VERSION,
  STORES,
  DATA_STORES,
  LAST_USER_STORAGE_KEY,
} from './constants';
import { generateId } from './utils';
import { parseCsv, type ParsedCsv } from './csv-import';

// ============================================================
// Sync Queue Types (stored in IndexedDB, processed by sync.ts)
// ============================================================

export type SyncOperation = 'create' | 'update' | 'delete';

/** Lifecycle of a queued mutation. Only `pending` is eligible for automatic push. */
export type SyncEntryState = 'pending' | 'blocked' | 'conflict' | 'quarantined';

export interface SyncQueueEntry {
  id: string;
  storeName: string;
  recordId: string;
  operation: SyncOperation;
  // ponytail: unknown is fine here — IndexedDB accepts any structured-cloneable value
  payload: unknown;
  timestamp: number;
  retryCount: number;
  /** Account that produced this mutation. `null` means ownership is unproven. */
  ownerId: string | null;
  state: SyncEntryState;
  /** Raw server row this mutation was based on (snake_case), or null for creates. */
  baseline: Record<string, unknown> | null;
  /** Raw server `updated_at` (or immutable `created_at`) CAS token. */
  baselineRevision: string | null;
  /** Durable archive id for delete operations. */
  deletionSnapshotId?: string | null;
  lastError?: string | null;
  lastAttemptAt?: number | null;
  quarantinedAt?: number | null;
}

/** Per-record synchronization state, keyed `${storeName}:${recordId}`. */
export type SyncMetaState = 'clean' | 'pending' | 'blocked' | 'conflict' | 'quarantined';

export interface SyncConflictSnapshot {
  local: unknown;
  remote: Record<string, unknown> | null;
  reason: string;
  detectedAt: number;
}

export interface SyncMetaEntry {
  id: string;
  storeName: string;
  recordId: string;
  ownerId: string | null;
  baseline: Record<string, unknown> | null;
  baselineRevision: string | null;
  /** Local `updatedAt` observed when the baseline was last reconciled. */
  localUpdatedAt: number | null;
  state: SyncMetaState;
  conflict?: SyncConflictSnapshot | null;
  lastError?: string | null;
  lastAttemptAt?: number | null;
  updatedAt: number;
}

/** Durable copy of a record removed locally or replaced by import/restore. */
export interface SyncDeletionSnapshot {
  id: string;
  storeName: string;
  recordId: string;
  payload: unknown;
  deletedAt: number;
  ownerId: string | null;
  state: 'pending' | 'synced' | 'conflict' | 'quarantined' | 'archived';
  reason: string;
  baselineRevision: string | null;
  lastError?: string | null;
  updatedAt: number;
}

/** Read the account that currently owns the local cache (set after auth scope). */
export function getActiveOwnerId(): string | null {
  try {
    return localStorage.getItem(LAST_USER_STORAGE_KEY) || null;
  } catch {
    return null;
  }
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
  [STORES.SYNC_META]: {
    key: string;
    value: SyncMetaEntry;
    indexes: {
      byStoreName: string;
      byState: string;
    };
  };
  [STORES.SYNC_DELETIONS]: {
    key: string;
    value: SyncDeletionSnapshot;
    indexes: {
      byStoreName: string;
      byRecordId: string;
      byState: string;
    };
  };
}

/** Singleton database instance */
let dbInstance: IDBPDatabase<ExpenseTrackerDB> | null = null;

/**
 * Open (or create) the IndexedDB database and initialize stores/indexes.
 */
export async function getDB(): Promise<IDBPDatabase<ExpenseTrackerDB>> {
  if (dbInstance) return dbInstance;

  dbInstance = await openDB<ExpenseTrackerDB>(DB_NAME, DB_VERSION, {
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

      // ── New stores added in v14 (Phase 3A sync safety) ──
      if (!db.objectStoreNames.contains(STORES.SYNC_META)) {
        const smStore = db.createObjectStore(STORES.SYNC_META, { keyPath: 'id' });
        smStore.createIndex('byStoreName', 'storeName', { unique: false });
        smStore.createIndex('byState', 'state', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.SYNC_DELETIONS)) {
        const sdStore = db.createObjectStore(STORES.SYNC_DELETIONS, { keyPath: 'id' });
        sdStore.createIndex('byStoreName', 'storeName', { unique: false });
        sdStore.createIndex('byRecordId', 'recordId', { unique: false });
        sdStore.createIndex('byState', 'state', { unique: false });
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

      // NOTE: The historical v7 → v8 migration used to clear every store.
      // Phase 3A removes that destructive branch: upgrades must never discard
      // unacknowledged local changes or legacy rows. Existing data is preserved
      // and ownership is verified later against the remote snapshot.

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
        const dividendStore = transaction.objectStore(STORES.DIVIDENDS);

        // Update the existing store in place. A versionchange transaction is
        // atomic: if an upgrade request fails, IndexedDB rolls back both the
        // record updates and index changes and leaves the old version intact.
        if (dividendStore.indexNames.contains('date')) {
          dividendStore.deleteIndex('date');
        }
        for (const indexName of ['stockId', 'exDate', 'payDate', 'type'] as const) {
          if (!dividendStore.indexNames.contains(indexName)) {
            dividendStore.createIndex(indexName, indexName, { unique: false });
          }
        }

        let cursor = await dividendStore.openCursor();
        while (cursor) {
          const dividend = cursor.value as Record<string, unknown>;
          await cursor.update({
            ...dividend,
            exDate: dividend.exDate ?? dividend.date ?? '',
            payDate: dividend.payDate ?? dividend.date ?? '',
            type: dividend.type ?? 'cash',
            qty: dividend.qty ?? 0,
            rate: dividend.rate ?? 0,
            fee: dividend.fee ?? 0,
            dividendYield: dividend.dividendYield ?? null,
            createdAt: dividend.createdAt ?? Date.now(),
            updatedAt: dividend.updatedAt ?? Date.now(),
          });
          cursor = await cursor.continue();
        }
      }

      // ── Migration: v13 → v14 (Phase 3A sync safety) ──
      // Legacy queue rows have no proven owner. Keep their content verbatim,
      // quarantine them, and never auto-assign them to a signed-in user.
      // The whole upgrade runs in one versionchange transaction, so a failure
      // aborts every schema/data change atomically.
      if (oldVersion < 14 && db.objectStoreNames.contains(STORES.SYNC_QUEUE)) {
        const queueStore = transaction.objectStore(STORES.SYNC_QUEUE);
        let cursor = await queueStore.openCursor();
        while (cursor) {
          const entry = cursor.value as Partial<SyncQueueEntry>;
          const knownStore = (DATA_STORES as readonly string[]).includes(entry.storeName ?? '');
          const knownOperation =
            entry.operation === 'create' ||
            entry.operation === 'update' ||
            entry.operation === 'delete';
          if (entry.ownerId == null || !knownStore || !knownOperation) {
            await cursor.update({
              ...entry,
              ownerId: entry.ownerId ?? null,
              state: 'quarantined',
              baseline: entry.baseline ?? null,
              baselineRevision: entry.baselineRevision ?? null,
              lastError:
                entry.lastError ??
                (entry.ownerId == null
                  ? 'Legacy queue entry: owning account is unknown'
                  : 'Unknown store or operation; entry preserved but not replayed'),
              lastAttemptAt: entry.lastAttemptAt ?? null,
              quarantinedAt: entry.quarantinedAt ?? Date.now(),
            } as SyncQueueEntry);
          } else if (entry.state == null) {
            await cursor.update({
              ...entry,
              state: 'pending',
              baseline: entry.baseline ?? null,
              baselineRevision: entry.baselineRevision ?? null,
            } as SyncQueueEntry);
          }
          cursor = await cursor.continue();
        }
      }

    },
  });

  return dbInstance;
}

// ============================================================
// Sync Queue
// ============================================================

/**
 * Count all outbox entries (pending, paused, conflicting, quarantined).
 * Use getSyncStatus() for a state breakdown.
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
function makeQueueEntry(
  storeName: string,
  recordId: string,
  operation: SyncOperation,
  payload: unknown,
  options?: { deletionSnapshotId?: string | null; ownerId?: string | null }
): SyncQueueEntry {
  const ownerId = options?.ownerId !== undefined ? options.ownerId : getActiveOwnerId();
  const seq = ++syncSeqCounter;
  return {
    id: generateId(),
    storeName,
    recordId,
    operation,
    payload,
    timestamp: seq,
    retryCount: 0,
    ownerId,
    state: ownerId ? 'pending' : 'quarantined',
    baseline: null,
    baselineRevision: null,
    deletionSnapshotId: options?.deletionSnapshotId ?? null,
    lastError: ownerId ? null : 'No verified account owns this local change',
    lastAttemptAt: null,
    quarantinedAt: ownerId ? null : Date.now(),
  };
}

function enqueueSyncEntryInTx(
  syncStore: IDBPObjectStore<ExpenseTrackerDB, (typeof STORES)[keyof typeof STORES][], typeof STORES.SYNC_QUEUE, 'readwrite'>,
  storeName: string,
  recordId: string,
  operation: SyncOperation,
  payload: unknown,
  options?: { deletionSnapshotId?: string | null; ownerId?: string | null }
): void {
  syncStore.add(makeQueueEntry(storeName, recordId, operation, payload, options));
}

export async function enqueueSyncEntry<T>(
  storeName: string,
  recordId: string,
  operation: SyncOperation,
  payload: T | null,
  options?: { deletionSnapshotId?: string | null; ownerId?: string | null }
): Promise<void> {
  const entry = makeQueueEntry(storeName, recordId, operation, payload, options);
  const db = await getDB();
  await db.add(STORES.SYNC_QUEUE, entry);
  requestSync(); // fire-and-forget, debounced
}

/** IDB key for the durable per-record synchronization metadata. */
export function syncMetaKey(storeName: string, recordId: string): string {
  return `${storeName}:${recordId}`;
}

/**
 * Archive a record before it is removed locally and enqueue the delete in the
 * same transaction. The archive is never cleaned up automatically.
 */
function archiveAndEnqueueDeleteInTx(
  syncStore: IDBPObjectStore<ExpenseTrackerDB, (typeof STORES)[keyof typeof STORES][], typeof STORES.SYNC_QUEUE, 'readwrite'>,
  deletionStore: IDBPObjectStore<ExpenseTrackerDB, (typeof STORES)[keyof typeof STORES][], typeof STORES.SYNC_DELETIONS, 'readwrite'>,
  storeName: string,
  record: Record<string, unknown>,
  reason: string
): void {
  const recordId = String(record.id);
  const snapshotId = generateId();
  const ownerId = getActiveOwnerId();
  const now = Date.now();
  deletionStore.add({
    id: snapshotId,
    storeName,
    recordId,
    payload: record,
    deletedAt: now,
    ownerId,
    state: ownerId ? 'pending' : 'quarantined',
    reason,
    baselineRevision: null,
    lastError: ownerId ? null : 'No verified account owns this deletion',
    updatedAt: now,
  } satisfies SyncDeletionSnapshot);
  enqueueSyncEntryInTx(
    syncStore,
    storeName,
    recordId,
    'delete',
    record,
    { deletionSnapshotId: snapshotId }
  );
}

/**
 * Return true when any local store holds a record — the ten financial stores
 * plus the sync outbox, baselines, and deletion archives. A safety-only cache
 * with no owner marker still counts as local data: claiming the database would
 * orphan its archives, so this never assigns ownership.
 */
export async function hasAnyLocalData(): Promise<boolean> {
  const db = await getDB();
  const tx = db.transaction(ALL_BACKUP_STORES, 'readonly');
  let hasData = false;
  for (const storeName of ALL_BACKUP_STORES) {
    hasData = (await tx.objectStore(storeName).count()) > 0;
    if (hasData) break;
  }
  await tx.done;
  return hasData;
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
  const idbTx = db.transaction(
    [STORES.TRANSACTIONS, STORES.SYNC_QUEUE, STORES.SYNC_DELETIONS],
    'readwrite'
  );
  const store = idbTx.objectStore(STORES.TRANSACTIONS);
  const existing = await store.get(id);
  if (existing) {
    archiveAndEnqueueDeleteInTx(
      idbTx.objectStore(STORES.SYNC_QUEUE),
      idbTx.objectStore(STORES.SYNC_DELETIONS),
      STORES.TRANSACTIONS,
      existing as unknown as Record<string, unknown>,
      'local-delete'
    );
  }
  await store.delete(id);
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
  const idbTx = db.transaction(
    [STORES.ACCOUNTS, STORES.SYNC_QUEUE, STORES.SYNC_DELETIONS],
    'readwrite'
  );
  const store = idbTx.objectStore(STORES.ACCOUNTS);
  const existing = await store.get(id);
  if (existing) {
    archiveAndEnqueueDeleteInTx(
      idbTx.objectStore(STORES.SYNC_QUEUE),
      idbTx.objectStore(STORES.SYNC_DELETIONS),
      STORES.ACCOUNTS,
      existing as unknown as Record<string, unknown>,
      'local-delete'
    );
  }
  await store.delete(id);
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
  const idbTx = db.transaction(
    [STORES.CATEGORIES, STORES.SYNC_QUEUE, STORES.SYNC_DELETIONS],
    'readwrite'
  );
  const store = idbTx.objectStore(STORES.CATEGORIES);
  const existing = await store.get(id);
  if (existing) {
    archiveAndEnqueueDeleteInTx(
      idbTx.objectStore(STORES.SYNC_QUEUE),
      idbTx.objectStore(STORES.SYNC_DELETIONS),
      STORES.CATEGORIES,
      existing as unknown as Record<string, unknown>,
      'local-delete'
    );
  }
  await store.delete(id);
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
  const idbTx = db.transaction(
    [STORES.CASH_DENOMINATIONS, STORES.SYNC_QUEUE, STORES.SYNC_DELETIONS],
    'readwrite'
  );
  const store = idbTx.objectStore(STORES.CASH_DENOMINATIONS);
  const existing = await store.get(id);
  if (existing) {
    archiveAndEnqueueDeleteInTx(
      idbTx.objectStore(STORES.SYNC_QUEUE),
      idbTx.objectStore(STORES.SYNC_DELETIONS),
      STORES.CASH_DENOMINATIONS,
      existing as unknown as Record<string, unknown>,
      'local-delete'
    );
  }
  await store.delete(id);
  await idbTx.done;
  requestSync();
}

/**
 * Delete all cash denomination records for a given date.
 * Used to clear existing records before saving a fresh snapshot.
 */
export async function deleteCashDenominationsByDate(date: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(
    [STORES.CASH_DENOMINATIONS, STORES.SYNC_QUEUE, STORES.SYNC_DELETIONS],
    'readwrite'
  );
  const store = tx.objectStore(STORES.CASH_DENOMINATIONS);
  const syncStore = tx.objectStore(STORES.SYNC_QUEUE);
  const deletionStore = tx.objectStore(STORES.SYNC_DELETIONS);
  const index = store.index('date');
  let cursor = await index.openCursor(date);
  while (cursor) {
    archiveAndEnqueueDeleteInTx(
      syncStore,
      deletionStore,
      STORES.CASH_DENOMINATIONS,
      cursor.value as unknown as Record<string, unknown>,
      'local-delete'
    );
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

/**
 * Delete a balance snapshot locally, archiving the full record before removal.
 * The archive and outbox entry are written atomically with the delete.
 */
export async function deleteBalanceSnapshot(accountId: string): Promise<void> {
  const db = await getDB();
  const idbTx = db.transaction(
    [STORES.BALANCE_SNAPSHOTS, STORES.SYNC_QUEUE, STORES.SYNC_DELETIONS],
    'readwrite'
  );
  const store = idbTx.objectStore(STORES.BALANCE_SNAPSHOTS);
  const existing = await store.get(accountId);
  if (existing) {
    archiveAndEnqueueDeleteInTx(
      idbTx.objectStore(STORES.SYNC_QUEUE),
      idbTx.objectStore(STORES.SYNC_DELETIONS),
      STORES.BALANCE_SNAPSHOTS,
      existing as unknown as Record<string, unknown>,
      'local-delete'
    );
  }
  await store.delete(accountId);
  await idbTx.done;
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
  const idbTx = db.transaction(
    [STORES.PAYOUTS, STORES.SYNC_QUEUE, STORES.SYNC_DELETIONS],
    'readwrite'
  );
  const store = idbTx.objectStore(STORES.PAYOUTS);
  const existing = await store.get(id);
  if (existing) {
    archiveAndEnqueueDeleteInTx(
      idbTx.objectStore(STORES.SYNC_QUEUE),
      idbTx.objectStore(STORES.SYNC_DELETIONS),
      STORES.PAYOUTS,
      existing as unknown as Record<string, unknown>,
      'local-delete'
    );
  }
  await store.delete(id);
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
  // ponytail: cascade-delete stockTransactions + dividends for this stock,
  // archiving every record (including the parent) before removal.
  const idbTx = db.transaction(
    [
      STORES.STOCKS,
      STORES.STOCK_TRANSACTIONS,
      STORES.DIVIDENDS,
      STORES.SYNC_QUEUE,
      STORES.SYNC_DELETIONS,
    ],
    'readwrite'
  );
  const syncStore = idbTx.objectStore(STORES.SYNC_QUEUE);
  const deletionStore = idbTx.objectStore(STORES.SYNC_DELETIONS);

  const existingStock = await idbTx.objectStore(STORES.STOCKS).get(id);
  if (existingStock) {
    archiveAndEnqueueDeleteInTx(
      syncStore,
      deletionStore,
      STORES.STOCKS,
      existingStock as unknown as Record<string, unknown>,
      'stock-cascade-delete'
    );
  }
  await idbTx.objectStore(STORES.STOCKS).delete(id);

  // Delete stock transactions for this stock
  const txnIndex = idbTx.objectStore(STORES.STOCK_TRANSACTIONS).index('stockId');
  let txnCursor = await txnIndex.openCursor(id);
  while (txnCursor) {
    archiveAndEnqueueDeleteInTx(
      syncStore,
      deletionStore,
      STORES.STOCK_TRANSACTIONS,
      txnCursor.value as unknown as Record<string, unknown>,
      'stock-cascade-delete'
    );
    await txnCursor.delete();
    txnCursor = await txnCursor.continue();
  }

  // Delete dividends for this stock
  const divIndex = idbTx.objectStore(STORES.DIVIDENDS).index('stockId');
  let divCursor = await divIndex.openCursor(id);
  while (divCursor) {
    archiveAndEnqueueDeleteInTx(
      syncStore,
      deletionStore,
      STORES.DIVIDENDS,
      divCursor.value as unknown as Record<string, unknown>,
      'stock-cascade-delete'
    );
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
  const idbTx = db.transaction(
    [STORES.STOCK_TRANSACTIONS, STORES.SYNC_QUEUE, STORES.SYNC_DELETIONS],
    'readwrite'
  );
  const store = idbTx.objectStore(STORES.STOCK_TRANSACTIONS);
  const existing = await store.get(id);
  if (existing) {
    archiveAndEnqueueDeleteInTx(
      idbTx.objectStore(STORES.SYNC_QUEUE),
      idbTx.objectStore(STORES.SYNC_DELETIONS),
      STORES.STOCK_TRANSACTIONS,
      existing as unknown as Record<string, unknown>,
      'local-delete'
    );
  }
  await store.delete(id);
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
  const idbTx = db.transaction(
    [STORES.DIVIDENDS, STORES.SYNC_QUEUE, STORES.SYNC_DELETIONS],
    'readwrite'
  );
  const store = idbTx.objectStore(STORES.DIVIDENDS);
  const existing = await store.get(id);
  if (existing) {
    archiveAndEnqueueDeleteInTx(
      idbTx.objectStore(STORES.SYNC_QUEUE),
      idbTx.objectStore(STORES.SYNC_DELETIONS),
      STORES.DIVIDENDS,
      existing as unknown as Record<string, unknown>,
      'local-delete'
    );
  }
  await store.delete(id);
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

/**
 * Shape of a full recovery backup JSON.
 *
 * `version: 1` is preserved for backward compatibility. Older backups only
 * contain the original six stores; the Phase 3A fields are optional so they
 * continue to import without losing pending queues, conflicts, or archives.
 */
export interface BackupData {
  version: 1;
  exportedAt: string;
  data: {
    transactions: Transaction[];
    accounts: Account[];
    categories: Category[];
    cashDenominations: CashDenomination[];
    payouts: Payout[];
    budgetTargets: BudgetTarget[];
    balanceSnapshots?: BalanceSnapshot[];
    stocks?: Stock[];
    stockTransactions?: StockTransaction[];
    dividends?: Dividend[];
    /** Full outbox — pending, blocked, quarantined, and conflicting work. */
    syncQueue?: SyncQueueEntry[];
    /** Per-record baselines and conflict snapshots. */
    syncMeta?: SyncMetaEntry[];
    /** Durable deletion archives. */
    syncDeletions?: SyncDeletionSnapshot[];
  };
}

const ALL_STORES = [
  STORES.TRANSACTIONS,
  STORES.ACCOUNTS,
  STORES.CATEGORIES,
  STORES.CASH_DENOMINATIONS,
  STORES.PAYOUTS,
  STORES.BUDGET_TARGETS,
  STORES.BALANCE_SNAPSHOTS,
  STORES.STOCKS,
  STORES.STOCK_TRANSACTIONS,
  STORES.DIVIDENDS,
] as const;

const ALL_BACKUP_STORES = [
  ...ALL_STORES,
  STORES.SYNC_QUEUE,
  STORES.SYNC_META,
  STORES.SYNC_DELETIONS,
] as const;

type BackupStoreName =
  | (typeof ALL_STORES)[number]
  | typeof STORES.SYNC_QUEUE
  | typeof STORES.SYNC_META
  | typeof STORES.SYNC_DELETIONS;

/**
 * Minimal structural view over a heterogeneous object store. IndexedDB
 * transactions type each store separately; recovery code iterates all of them.
 */
interface StoreHandle {
  getAll(): Promise<unknown[]>;
  add(value: unknown): Promise<unknown>;
  put(value: unknown): Promise<unknown>;
  clear(): Promise<void>;
}

function storeHandle(tx: unknown, name: BackupStoreName): StoreHandle {
  // The idb transaction type cannot express one heterogeneous store union.
  const typedTx = tx as { objectStore(storeName: never): unknown };
  return typedTx.objectStore(name as never) as StoreHandle;
}

/**
 * Export every store as a portable JSON blob you can save to disk.
 * Includes all ten data stores plus the outbox, baselines/conflicts, and
 * deletion archives. Never includes authentication secrets.
 */
export async function exportAllData(): Promise<BackupData> {
  const db = await getDB();
  const tx = db.transaction(ALL_BACKUP_STORES, 'readonly');
  const read = <T,>(name: BackupStoreName): Promise<T[]> =>
    storeHandle(tx, name).getAll() as Promise<T[]>;

  const [
    transactions,
    accounts,
    categories,
    cashDenominations,
    payouts,
    budgetTargets,
    balanceSnapshots,
    stocks,
    stockTransactions,
    dividends,
    syncQueue,
    syncMeta,
    syncDeletions,
  ] = await Promise.all([
    read<Transaction>(STORES.TRANSACTIONS),
    read<Account>(STORES.ACCOUNTS),
    read<Category>(STORES.CATEGORIES),
    read<CashDenomination>(STORES.CASH_DENOMINATIONS),
    read<Payout>(STORES.PAYOUTS),
    read<BudgetTarget>(STORES.BUDGET_TARGETS),
    read<BalanceSnapshot>(STORES.BALANCE_SNAPSHOTS),
    read<Stock>(STORES.STOCKS),
    read<StockTransaction>(STORES.STOCK_TRANSACTIONS),
    read<Dividend>(STORES.DIVIDENDS),
    read<SyncQueueEntry>(STORES.SYNC_QUEUE),
    read<SyncMetaEntry>(STORES.SYNC_META),
    read<SyncDeletionSnapshot>(STORES.SYNC_DELETIONS),
  ]);
  await tx.done;
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      transactions,
      accounts,
      categories,
      cashDenominations,
      payouts,
      budgetTargets,
      balanceSnapshots,
      stocks,
      stockTransactions,
      dividends,
      syncQueue,
      syncMeta,
      syncDeletions,
    },
  };
}

/**
 * Import a full backup.
 *
 * Safety properties:
 *   - Runs in a single readwrite transaction.
 *   - Only stores explicitly present in the backup are replaced.
 *   - Replaced records are archived in `syncDeletions` before removal.
 *   - Existing pending outbox entries are NOT deleted. Entries for replaced
 *     records are marked `conflict` so the user can review them.
 *   - Restored records get a fresh create entry owned by the current account
 *     (or quarantined when no account scope has been established).
 */
export async function importAllData(backup: BackupData): Promise<void> {
  const db = await getDB();
  const tx = db.transaction([...ALL_BACKUP_STORES], 'readwrite');

  const data = backup.data;
  const incoming: Array<[BackupStoreName, unknown[] | undefined]> = [
    [STORES.TRANSACTIONS, data.transactions],
    [STORES.ACCOUNTS, data.accounts],
    [STORES.CATEGORIES, data.categories],
    [STORES.CASH_DENOMINATIONS, data.cashDenominations],
    [STORES.PAYOUTS, data.payouts],
    [STORES.BUDGET_TARGETS, data.budgetTargets],
    [STORES.BALANCE_SNAPSHOTS, data.balanceSnapshots],
    [STORES.STOCKS, data.stocks],
    [STORES.STOCK_TRANSACTIONS, data.stockTransactions],
    [STORES.DIVIDENDS, data.dividends],
  ];

  const syncStore = tx.objectStore(STORES.SYNC_QUEUE);
  const metaStore = tx.objectStore(STORES.SYNC_META);
  const deletionStore = tx.objectStore(STORES.SYNC_DELETIONS);
  const ownerId = getActiveOwnerId();
  const now = Date.now();

  const preExistingQueueIds = new Set<string>();
  let queueCursor = await syncStore.index('byTimestamp').openCursor();
  while (queueCursor) {
    preExistingQueueIds.add((queueCursor.value as SyncQueueEntry).id);
    queueCursor = await queueCursor.continue();
  }

  const restoredQueueKeys = new Set<string>();
  for (const entry of data.syncQueue ?? []) {
    if (entry.operation !== 'delete') {
      restoredQueueKeys.add(`${entry.storeName}:${entry.recordId}`);
    }
  }
  const restoredMetaIds = new Set((data.syncMeta ?? []).map((meta) => meta.id));

  const replacedKeys = new Set<string>();
  for (const [storeName, records] of incoming) {
    if (records === undefined) continue;
    const handle = storeHandle(tx, storeName);
    const existing = await handle.getAll();
    for (const record of existing) {
      const rec = record as Record<string, unknown>;
      replacedKeys.add(`${storeName}:${String(rec.id)}`);
      deletionStore.add({
        id: generateId(),
        storeName,
        recordId: String(rec.id),
        payload: rec,
        deletedAt: now,
        ownerId,
        state: 'archived',
        reason: 'backup-restore-replaced',
        baselineRevision: null,
        lastError: null,
        updatedAt: now,
      } satisfies SyncDeletionSnapshot);
    }
    await handle.clear();
    for (const record of records) {
      await handle.add(record);
      const rec = record as Record<string, unknown>;
      const key = syncMetaKey(storeName, String(rec.id));
      if (!restoredMetaIds.has(key)) {
        await metaStore.put({
          id: key,
          storeName,
          recordId: String(rec.id),
          ownerId,
          baseline: null,
          baselineRevision: null,
          localUpdatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : null,
          state: ownerId ? 'pending' : 'quarantined',
          conflict: null,
          lastError: ownerId ? null : 'No verified account owns this restored record',
          lastAttemptAt: null,
          updatedAt: now,
        } satisfies SyncMetaEntry);
      }
      if (!restoredQueueKeys.has(`${storeName}:${String(rec.id)}`)) {
        enqueueSyncEntryInTx(syncStore, storeName, String(rec.id), 'create', rec);
      }
    }
  }

  // Preserve unresolved work, but surface it instead of silently pushing
  // mutations for records that were replaced. Only pre-existing entries are
  // marked; restored outbox entries keep their recorded state.
  queueCursor = await syncStore.index('byTimestamp').openCursor();
  while (queueCursor) {
    const entry = queueCursor.value as SyncQueueEntry;
    if (
      preExistingQueueIds.has(entry.id) &&
      replacedKeys.has(`${entry.storeName}:${entry.recordId}`) &&
      (entry.state === 'pending' || entry.state === 'blocked')
    ) {
      await queueCursor.update({
        ...entry,
        state: 'conflict',
        lastError: 'Record was replaced by a backup restore; review before syncing',
        lastAttemptAt: now,
      } satisfies SyncQueueEntry);
    }
    queueCursor = await queueCursor.continue();
  }

  // Merge the backup's safety metadata. Existing records win so a restore can
  // never silently overwrite unresolved conflicts or deletion archives.
  for (const entry of data.syncQueue ?? []) {
    if (!(await syncStore.get(entry.id))) await syncStore.put(entry);
  }
  for (const meta of data.syncMeta ?? []) {
    if (!(await metaStore.get(meta.id))) await metaStore.put(meta);
  }
  for (const snapshot of data.syncDeletions ?? []) {
    if (!(await deletionStore.get(snapshot.id))) await deletionStore.put(snapshot);
  }

  await tx.done;
  requestSync();
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

/**
 * One-shot migration: find all accounts and categories whose IDs are not
 * valid UUIDs (e.g. from an old CSV import that used slugId()), generate
 * new UUIDs for them, and update every cross-reference:
 *
 *   - accounts store (new ID)
 *   - categories store (new ID)
 *   - transactions store (fromAccount / toAccount)
 *   - sync queue (recordId + payload fields)
 *
 * Safe to call repeatedly — only touches records with non-UUID IDs.
 */
export async function ensureUuids(): Promise<void> {
  const db = await getDB();

  // ponytail: one-shot migration guard — skip if already completed
  try {
    if (localStorage.getItem('uuid_migration_done')) return;
  } catch { /* localStorage unavailable */ }

  // ── 1. Accounts ──
  const accounts = await db.getAll(STORES.ACCOUNTS);
  const acctMap = new Map<string, string>(); // old slug → new UUID
  for (const a of accounts) {
    if (!isUuid(a.id)) {
      const newId = crypto.randomUUID();
      acctMap.set(a.id, newId);
      a.id = newId;
      await db.put(STORES.ACCOUNTS, a);
    }
  }

  // ── 2. Categories ──
  const categories = await db.getAll(STORES.CATEGORIES);
  const catMap = new Map<string, string>(); // old slug → new UUID
  for (const c of categories) {
    if (!isUuid(c.id)) {
      const newId = crypto.randomUUID();
      catMap.set(c.id, newId);
      c.id = newId;
      await db.put(STORES.CATEGORIES, c);
    }
  }

  if (acctMap.size === 0 && catMap.size === 0) return; // nothing to migrate

  // ── 3. Transactions — remap fromAccount / toAccount ──
  const transactions = await db.getAll(STORES.TRANSACTIONS);
  for (const tx of transactions) {
    let changed = false;
    if (tx.fromAccount && acctMap.has(tx.fromAccount)) {
      tx.fromAccount = acctMap.get(tx.fromAccount)!;
      changed = true;
    }
    if (tx.toAccount && acctMap.has(tx.toAccount)) {
      tx.toAccount = acctMap.get(tx.toAccount)!;
      changed = true;
    }
    if (changed) {
      await db.put(STORES.TRANSACTIONS, tx);
    }
  }

  // ── 4. Sync queue — remap IDs in recordId and payload ──
  const entries = await db.getAll(STORES.SYNC_QUEUE);
  for (const entry of entries) {
    // Quarantined/legacy work is preserved verbatim; it is never replayed.
    if (entry.ownerId == null || entry.state === 'quarantined') continue;
    let changed = false;

    // Remap recordId
    if (acctMap.has(entry.recordId)) {
      entry.recordId = acctMap.get(entry.recordId)!;
      changed = true;
    } else if (catMap.has(entry.recordId)) {
      entry.recordId = catMap.get(entry.recordId)!;
      changed = true;
    }

    // Remap payload fields
    if (entry.payload) {
      const p = entry.payload as Record<string, unknown>;
      if (typeof p.id === 'string') {
        if (acctMap.has(p.id)) { p.id = acctMap.get(p.id)!; changed = true; }
        else if (catMap.has(p.id)) { p.id = catMap.get(p.id)!; changed = true; }
      }
      if (typeof p.fromAccount === 'string' && acctMap.has(p.fromAccount)) {
        p.fromAccount = acctMap.get(p.fromAccount)!;
        changed = true;
      }
      if (typeof p.toAccount === 'string' && acctMap.has(p.toAccount)) {
        p.toAccount = acctMap.get(p.toAccount)!;
        changed = true;
      }
    }

    if (changed) {
      await db.put(STORES.SYNC_QUEUE, entry);
    }
  }

  // ── 5. Safety metadata — keep baselines/conflicts keyed by the new IDs ──
  const metas = await db.getAll(STORES.SYNC_META);
  for (const meta of metas) {
    const map = meta.storeName === STORES.ACCOUNTS
      ? acctMap
      : meta.storeName === STORES.CATEGORIES
        ? catMap
        : null;
    const newId = map?.get(meta.recordId);
    if (!newId) continue;
    await db.delete(STORES.SYNC_META, meta.id);
    await db.put(STORES.SYNC_META, {
      ...meta,
      id: syncMetaKey(meta.storeName, newId),
      recordId: newId,
      updatedAt: Date.now(),
    });
  }

  const deletions = await db.getAll(STORES.SYNC_DELETIONS);
  for (const snapshot of deletions) {
    const map = snapshot.storeName === STORES.ACCOUNTS
      ? acctMap
      : snapshot.storeName === STORES.CATEGORIES
        ? catMap
        : null;
    const newId = map?.get(snapshot.recordId);
    if (!newId) continue;
    const payload = snapshot.payload as Record<string, unknown> | null;
    await db.put(STORES.SYNC_DELETIONS, {
      ...snapshot,
      recordId: newId,
      payload: payload ? { ...payload, id: newId } : payload,
      updatedAt: Date.now(),
    });
  }

  try { localStorage.setItem('uuid_migration_done', '1'); } catch { /* ignore */ }
}

/**
 * Nondestructive "re-sync" used by the settings UI.
 *
 * It never clears the outbox, never rebuilds entries from current records,
 * never assigns ownership to legacy rows, and never uploads quarantined or
 * conflicting work. It only moves paused (blocked) entries back to `pending`
 * so the next reconciliation attempt can retry them with their original
 * payload, attempt count, and error history intact. Entries exist for all ten
 * synchronized stores, so every store is covered.
 */
export async function resyncAll(): Promise<{ retried: number }> {
  const db = await getDB();
  const entries = await db.getAllFromIndex(STORES.SYNC_QUEUE, 'byTimestamp');
  const tx = db.transaction(STORES.SYNC_QUEUE, 'readwrite');
  let retried = 0;
  for (const entry of entries) {
    if (entry.state === 'blocked') {
      await tx.store.put({ ...entry, state: 'pending' } satisfies SyncQueueEntry);
      retried++;
    }
  }
  await tx.done;
  if (retried > 0) requestSync();
  return { retried };
}

// ============================================================
// CSV Import
// ============================================================

/**
 * Parse a CSV string and import all data into IndexedDB atomically.
 *
 * Archives the records in the six replaced stores, then writes the parsed
 * accounts (with starting balances from carry-overs), categories, and
 * transactions. Pending outbox work is preserved as conflicts.
 *
 * Returns the parsed data (including any parse errors).
 */
const CSV_REPLACED_STORES = [
  STORES.ACCOUNTS,
  STORES.CATEGORIES,
  STORES.TRANSACTIONS,
  STORES.CASH_DENOMINATIONS,
  STORES.PAYOUTS,
  STORES.BUDGET_TARGETS,
] as const;

export async function importFromCsv(csvText: string): Promise<ParsedCsv> {
  const parsed = parseCsv(csvText);

  const db = await getDB();
  const tx = db.transaction(
    [...CSV_REPLACED_STORES, STORES.SYNC_DELETIONS],
    'readwrite'
  );

  const acctStore = tx.objectStore(STORES.ACCOUNTS);
  const catStore = tx.objectStore(STORES.CATEGORIES);
  const txStore = tx.objectStore(STORES.TRANSACTIONS);
  const deletionStore = tx.objectStore(STORES.SYNC_DELETIONS);
  const ownerId = getActiveOwnerId();
  const replacedKeys = new Set<string>();

  // Archive every record that the import is about to replace.
  for (const storeName of CSV_REPLACED_STORES) {
    const handle = storeHandle(tx, storeName);
    const existing = await handle.getAll();
    for (const record of existing) {
      const rec = record as Record<string, unknown>;
      replacedKeys.add(`${storeName}:${String(rec.id)}`);
      deletionStore.add({
        id: generateId(),
        storeName,
        recordId: String(rec.id),
        payload: rec,
        deletedAt: Date.now(),
        ownerId,
        state: 'archived',
        reason: 'csv-import-replaced',
        baselineRevision: null,
        lastError: null,
        updatedAt: Date.now(),
      } satisfies SyncDeletionSnapshot);
    }
    await handle.clear();
  }

  const now = Date.now();

  const addedAccounts: Account[] = [];
  const addedCategories: Category[] = [];
  const addedTransactions: Transaction[] = [];

  for (const acct of parsed.accounts) {
    await acctStore.add(acct);
    addedAccounts.push(acct);
  }
  for (const cat of parsed.categories) {
    await catStore.add(cat);
    addedCategories.push(cat);
  }
  for (const t of parsed.transactions) {
    const record = { ...t, id: generateId(), createdAt: now, updatedAt: now };
    await txStore.add(record);
    addedTransactions.push(record);
  }

  await tx.done;

  // Never delete pending work just because the records it referred to were
  // replaced. Preserve the entries and surface them as conflicts for review.
  const syncTx = db.transaction(STORES.SYNC_QUEUE, 'readwrite');
  const syncStore = syncTx.objectStore(STORES.SYNC_QUEUE);
  const syncIndex = syncStore.index('byTimestamp');
  let syncCursor = await syncIndex.openCursor();
  while (syncCursor) {
    const entry = syncCursor.value as SyncQueueEntry;
    if (
      replacedKeys.has(`${entry.storeName}:${entry.recordId}`) &&
      (entry.state === 'pending' || entry.state === 'blocked')
    ) {
      await syncCursor.update({
        ...entry,
        state: 'conflict',
        lastError: 'Record was replaced by a CSV import; review before syncing',
        lastAttemptAt: Date.now(),
      } satisfies SyncQueueEntry);
    }
    syncCursor = await syncCursor.continue();
  }
  await syncTx.done;

  // Enqueue sync entries so imported data gets pushed to Supabase
  for (const acct of addedAccounts) {
    enqueueSyncEntry(STORES.ACCOUNTS, acct.id, 'create', acct);
  }
  for (const cat of addedCategories) {
    enqueueSyncEntry(STORES.CATEGORIES, cat.id, 'create', cat);
  }
  for (const t of addedTransactions) {
    enqueueSyncEntry(STORES.TRANSACTIONS, t.id, 'create', t);
  }

  return parsed;
}

// ============================================================
// Transaction Deduplication
// ============================================================

export interface DeduplicationReport {
  /** Always 0: Phase 3A never deletes during a scan. */
  deleted: 0;
  /** Always 0: Phase 3A never rewrites account links during a scan. */
  relinked: 0;
  /** Orphans with no same-date/amount sibling to compare against. */
  remaining: number;
  /** Orphans that look like duplicates of a healthy transaction. */
  duplicates: number;
  /** Total orphaned transactions found. */
  orphaned: number;
}

/**
 * Scan for orphaned transactions (references to deleted accounts) and
 * potential duplicates. Phase 3A is report-only: it never deletes records,
 * rewrites account links, or enqueues sync mutations.
 */
export async function deduplicateTransactions(): Promise<DeduplicationReport> {
  const db = await getDB();
  const allTxs = await db.getAll(STORES.TRANSACTIONS);
  const accounts = await db.getAll(STORES.ACCOUNTS);
  const validIds = new Set(accounts.map((a) => a.id));

  const orphaned = allTxs.filter((tx) => {
    const fromBad = tx.fromAccount && !validIds.has(tx.fromAccount);
    const toBad = tx.toAccount && !validIds.has(tx.toAccount);
    return fromBad || toBad;
  });

  if (orphaned.length === 0) {
    return { deleted: 0, relinked: 0, remaining: 0, duplicates: 0, orphaned: 0 };
  }

  const twinKeys = new Set(
    allTxs
      .filter((tx) => {
        const fromOk = !tx.fromAccount || validIds.has(tx.fromAccount);
        const toOk = !tx.toAccount || validIds.has(tx.toAccount);
        return fromOk && toOk;
      })
      .map((tx) => `${tx.date}|${tx.amount}|${tx.type}|${tx.category}|${tx.description ?? ''}`)
  );

  let duplicates = 0;
  let remaining = 0;
  for (const tx of orphaned) {
    const key = `${tx.date}|${tx.amount}|${tx.type}|${tx.category}|${tx.description ?? ''}`;
    if (twinKeys.has(key)) duplicates++;
    else remaining++;
  }

  return { deleted: 0, relinked: 0, remaining, duplicates, orphaned: orphaned.length };
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
