// ============================================================
// IndexedDB wrapper using the `idb` library
// Provides CRUD operations for transactions, accounts, categories,
// cash denominations, and payouts.
// ============================================================

import { openDB, type IDBPDatabase } from 'idb';
import type { Transaction, Account, Category, CashDenomination, Payout, BudgetTarget } from '@/types';
import { DB_NAME, DB_VERSION, STORES } from './constants';
import { generateId } from './utils';
import { parseCsv, type ParsedCsv } from './csv-import';

// ============================================================
// Sync Queue Types (stored in IndexedDB, processed by sync.ts)
// ============================================================

export type SyncOperation = 'create' | 'update' | 'delete';

export interface SyncQueueEntry {
  id: string;
  storeName: string;
  recordId: string;
  operation: SyncOperation;
  /** Full data snapshot (null for deletes) */
  payload: Record<string, unknown> | null;
  timestamp: number;
  retryCount: number;
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
          const updates: Partial<Transaction> = {};

          // Rename type: 'Income' → 'income', 'Expense' → 'expense', 'Transfer' → 'transaction'
          if (record.type === 'Income') {
            updates.type = 'income';
            updates.fromAccount = null;
            updates.toAccount = record.account ?? null;
          } else if (record.type === 'Expense') {
            updates.type = 'expense';
            updates.fromAccount = record.account ?? null;
            updates.toAccount = null;
          } else if (record.type === 'Transfer') {
            updates.type = 'transaction';
            updates.fromAccount = record.account ?? null;
            updates.toAccount = record.account ?? null;
          }

          // Keep the old `account` field for backward compat
          cursor.update({ ...record, ...updates });
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
 * Enqueue a sync entry for the outbox pattern.
 * Called after each local CRUD to track unsynced changes.
 *
 * ponytail: The queue write runs in its own transaction (not the
 * same transaction as the data write). If the app crashes between
 * the data write and the queue write, the change is never pushed
 * to Supabase. A future full pull from Supabase will eventually
 * reconcile, so this is acceptable for a 2-user household. If
 * data-loss risk becomes a concern, merge both writes into a
 * single readwrite transaction.
 */
export async function enqueueSyncEntry(
  storeName: string,
  recordId: string,
  operation: SyncOperation,
  payload: Record<string, unknown> | null
): Promise<void> {
  const db = await getDB();
  await db.add(STORES.SYNC_QUEUE, {
    id: generateId(),
    storeName,
    recordId,
    operation,
    payload,
    timestamp: Date.now(),
    retryCount: 0,
  });
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
 * Add a new transaction. Generates id and timestamps if missing.
 */
export async function addTransaction(
  tx: Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  const db = await getDB();
  const now = Date.now();
  const newTx: Transaction = {
    ...tx,
    id: generateId(),
    createdAt: now,
    updatedAt: now,
  };
  await db.add(STORES.TRANSACTIONS, newTx);
  // Enqueue sync entry (fire-and-forget, own transaction)
  enqueueSyncEntry(STORES.TRANSACTIONS, newTx.id, 'create', newTx as unknown as Record<string, unknown>);
  return newTx.id;
}

/**
 * Update an existing transaction.
 */
export async function updateTransaction(tx: Transaction): Promise<void> {
  const db = await getDB();
  const existing = await db.get(STORES.TRANSACTIONS, tx.id);
  if (!existing) {
    throw new Error(`Transaction with id "${tx.id}" not found`);
  }
  const updated = { ...tx, updatedAt: Date.now() };
  await db.put(STORES.TRANSACTIONS, updated);
  enqueueSyncEntry(STORES.TRANSACTIONS, tx.id, 'update', updated as unknown as Record<string, unknown>);
}

/**
 * Delete a transaction by ID.
 */
export async function deleteTransaction(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORES.TRANSACTIONS, id);
  enqueueSyncEntry(STORES.TRANSACTIONS, id, 'delete', null);
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
export async function addAccount(account: Account): Promise<string> {
  const db = await getDB();
  const all = await db.getAll(STORES.ACCOUNTS);
  const maxOrder = all.reduce((max, a) => Math.max(max, a.sortOrder ?? 0), 0);
  const record = { ...account, sortOrder: account.sortOrder ?? maxOrder + 1000 };
  await db.add(STORES.ACCOUNTS, record);
  enqueueSyncEntry(STORES.ACCOUNTS, record.id, 'create', record as unknown as Record<string, unknown>);
  return record.id;
}

/**
 * Update an existing account.
 */
export async function updateAccount(account: Account): Promise<void> {
  const db = await getDB();
  const existing = await db.get(STORES.ACCOUNTS, account.id);
  if (!existing) {
    throw new Error(`Account with id "${account.id}" not found`);
  }
  await db.put(STORES.ACCOUNTS, account);
  enqueueSyncEntry(STORES.ACCOUNTS, account.id, 'update', account as unknown as Record<string, unknown>);
}

/**
 * Delete an account by ID.
 */
export async function deleteAccount(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORES.ACCOUNTS, id);
  enqueueSyncEntry(STORES.ACCOUNTS, id, 'delete', null);
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

  const tx = db.transaction(STORES.ACCOUNTS, 'readwrite');
  const store = tx.objectStore(STORES.ACCOUNTS);
  const updated = sorted.map((acct, i) => ({ ...acct, sortOrder: i * 1000 }));
  await Promise.all(updated.map((acct) => store.put(acct)));
  await tx.done;

  for (const acct of updated) {
    enqueueSyncEntry(STORES.ACCOUNTS, acct.id, 'update', acct as unknown as Record<string, unknown>);
  }
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
export async function addCategory(category: Category): Promise<string> {
  const db = await getDB();
  const all = await db.getAll(STORES.CATEGORIES);
  const maxOrder = all
    .filter((c) => c.type === category.type)
    .reduce((max, c) => Math.max(max, c.sortOrder ?? 0), 0);
  const record = { ...category, sortOrder: category.sortOrder ?? maxOrder + 1000 };
  await db.add(STORES.CATEGORIES, record);
  enqueueSyncEntry(STORES.CATEGORIES, record.id, 'create', record as unknown as Record<string, unknown>);
  return record.id;
}

/**
 * Update an existing category.
 */
export async function updateCategory(category: Category): Promise<void> {
  const db = await getDB();
  const existing = await db.get(STORES.CATEGORIES, category.id);
  if (!existing) {
    throw new Error(`Category with id "${category.id}" not found`);
  }
  await db.put(STORES.CATEGORIES, category);
  enqueueSyncEntry(STORES.CATEGORIES, category.id, 'update', category as unknown as Record<string, unknown>);
}

/**
 * Delete a category by ID.
 */
export async function deleteCategory(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORES.CATEGORIES, id);
  enqueueSyncEntry(STORES.CATEGORIES, id, 'delete', null);
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

  const tx = db.transaction(STORES.CATEGORIES, 'readwrite');
  const store = tx.objectStore(STORES.CATEGORIES);
  const updated = group.map((cat, i) => ({ ...cat, sortOrder: i * 1000 }));
  await Promise.all(updated.map((cat) => store.put(cat)));
  await tx.done;

  for (const cat of updated) {
    enqueueSyncEntry(STORES.CATEGORIES, cat.id, 'update', cat as unknown as Record<string, unknown>);
  }
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
  await db.add(STORES.CASH_DENOMINATIONS, record);
  enqueueSyncEntry(STORES.CASH_DENOMINATIONS, id, 'create', record as unknown as Record<string, unknown>);
  return id;
}

/**
 * Delete a cash denomination record by ID.
 */
export async function deleteCashDenomination(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORES.CASH_DENOMINATIONS, id);
  enqueueSyncEntry(STORES.CASH_DENOMINATIONS, id, 'delete', null);
}

/**
 * Delete all cash denomination records for a given date.
 * Used to clear existing records before saving a fresh snapshot.
 */
export async function deleteCashDenominationsByDate(date: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(STORES.CASH_DENOMINATIONS, 'readwrite');
  const store = tx.objectStore(STORES.CASH_DENOMINATIONS);
  const index = store.index('date');
  let cursor = await index.openCursor(date);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
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
  await db.add(STORES.PAYOUTS, record);
  enqueueSyncEntry(STORES.PAYOUTS, id, 'create', record as unknown as Record<string, unknown>);
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
  await db.put(STORES.PAYOUTS, payout);
  enqueueSyncEntry(STORES.PAYOUTS, payout.id, 'update', payout as unknown as Record<string, unknown>);
}

/**
 * Delete a payout record by ID.
 */
export async function deletePayout(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORES.PAYOUTS, id);
  enqueueSyncEntry(STORES.PAYOUTS, id, 'delete', null);
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
  const tx = db.transaction(STORES.BUDGET_TARGETS, 'readwrite');
  const store = tx.objectStore(STORES.BUDGET_TARGETS);
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
      enqueueSyncEntry(STORES.BUDGET_TARGETS, updated.id, 'update', updated as unknown as Record<string, unknown>);
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
  enqueueSyncEntry(STORES.BUDGET_TARGETS, newTarget.id, 'create', newTarget as unknown as Record<string, unknown>);
}

/**
 * Get all budget target records.
 */
export async function getAllBudgetTargets(): Promise<BudgetTarget[]> {
  const db = await getDB();
  return db.getAll(STORES.BUDGET_TARGETS);
}

// ============================================================
// Export / Import
// ============================================================

/** Shape of a full backup JSON. */
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
  };
}

const ALL_STORES = [
  STORES.TRANSACTIONS,
  STORES.ACCOUNTS,
  STORES.CATEGORIES,
  STORES.CASH_DENOMINATIONS,
  STORES.PAYOUTS,
  STORES.BUDGET_TARGETS,
] as const;

/**
 * Export every store as a portable JSON blob you can save to disk.
 * Each store gets a full read — no pagination needed (local-only, small data).
 */
export async function exportAllData(): Promise<BackupData> {
  const db = await getDB();
  const tx = db.transaction(ALL_STORES, 'readonly');
  const [transactions, accounts, categories, cashDenominations, payouts, budgetTargets] =
    await Promise.all([
      tx.objectStore(STORES.TRANSACTIONS).getAll(),
      tx.objectStore(STORES.ACCOUNTS).getAll(),
      tx.objectStore(STORES.CATEGORIES).getAll(),
      tx.objectStore(STORES.CASH_DENOMINATIONS).getAll(),
      tx.objectStore(STORES.PAYOUTS).getAll(),
      tx.objectStore(STORES.BUDGET_TARGETS).getAll(),
    ]);
  await tx.done;
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    data: { transactions, accounts, categories, cashDenominations, payouts, budgetTargets },
  };
}

/**
 * Import a full backup — clears each store then bulk-adds the supplied records.
 * Runs inside a single readwrite transaction so it's atomic.
 */
export async function importAllData(backup: BackupData): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(ALL_STORES, 'readwrite');
  const stores = {
    [STORES.TRANSACTIONS]: tx.objectStore(STORES.TRANSACTIONS),
    [STORES.ACCOUNTS]: tx.objectStore(STORES.ACCOUNTS),
    [STORES.CATEGORIES]: tx.objectStore(STORES.CATEGORIES),
    [STORES.CASH_DENOMINATIONS]: tx.objectStore(STORES.CASH_DENOMINATIONS),
    [STORES.PAYOUTS]: tx.objectStore(STORES.PAYOUTS),
    [STORES.BUDGET_TARGETS]: tx.objectStore(STORES.BUDGET_TARGETS),
  };
  // Clear each store
  for (const s of Object.values(stores)) await s.clear();
  // Bulk-add
  for (const record of backup.data.transactions) await stores[STORES.TRANSACTIONS].add(record);
  for (const record of backup.data.accounts) await stores[STORES.ACCOUNTS].add(record);
  for (const record of backup.data.categories) await stores[STORES.CATEGORIES].add(record);
  for (const record of backup.data.cashDenominations) await stores[STORES.CASH_DENOMINATIONS].add(record);
  for (const record of backup.data.payouts) await stores[STORES.PAYOUTS].add(record);
  for (const record of backup.data.budgetTargets) await stores[STORES.BUDGET_TARGETS].add(record);
  await tx.done;
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
// CSV Import
// ============================================================

/**
 * Parse a CSV string and import all data into IndexedDB atomically.
 *
 * Clears all existing stores, then writes the parsed accounts (with
 * starting balances from carry-overs), categories, and transactions.
 *
 * Returns the parsed data (including any parse errors).
 */
export async function importFromCsv(csvText: string): Promise<ParsedCsv> {
  const parsed = parseCsv(csvText);

  const db = await getDB();
  const tx = db.transaction(
    [STORES.ACCOUNTS, STORES.CATEGORIES, STORES.TRANSACTIONS],
    'readwrite'
  );

  const acctStore = tx.objectStore(STORES.ACCOUNTS);
  const catStore = tx.objectStore(STORES.CATEGORIES);
  const txStore = tx.objectStore(STORES.TRANSACTIONS);

  await acctStore.clear();
  await catStore.clear();
  await txStore.clear();

  const now = Date.now();
  for (const acct of parsed.accounts) {
    await acctStore.add(acct);
  }
  for (const cat of parsed.categories) {
    await catStore.add(cat);
  }
  for (const t of parsed.transactions) {
    await txStore.add({
      ...t,
      id: generateId(),
      createdAt: now,
      updatedAt: now,
    });
  }

  await tx.done;
  return parsed;
}
