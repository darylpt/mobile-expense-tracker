// ============================================================
// IndexedDB wrapper using the `idb` library
// Provides CRUD operations for transactions, accounts, categories,
// cash denominations, and payouts.
// ============================================================

import { openDB, type IDBPDatabase } from 'idb';
import type { Transaction, Account, Category, CashDenomination, Payout, BudgetTarget } from '@/types';
import { DB_NAME, DB_VERSION, STORES, DEFAULT_ACCOUNTS, DEFAULT_CATEGORIES, DEFAULT_BUDGET_TARGETS, SEED_TRANSACTIONS } from './constants';
import { generateId } from './utils';

/** Schema type for our IndexedDB database */
interface ExpenseTrackerDB {
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
}

/** Singleton database instance */
let dbInstance: IDBPDatabase<ExpenseTrackerDB> | null = null;

/**
 * Open (or create) the IndexedDB database and initialize stores/indexes.
 */
export async function getDB(): Promise<IDBPDatabase<ExpenseTrackerDB>> {
  if (dbInstance) return dbInstance;

  dbInstance = await openDB<ExpenseTrackerDB>(DB_NAME, DB_VERSION, {
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

      // Seed default data on first creation (oldVersion === 0)
      if (oldVersion === 0) {
        // Seed accounts
        for (const account of DEFAULT_ACCOUNTS) {
          transaction.objectStore(STORES.ACCOUNTS).add(account);
        }
        // Seed categories
        for (const category of DEFAULT_CATEGORIES) {
          transaction.objectStore(STORES.CATEGORIES).add(category);
        }
      }
    },
  });

  return dbInstance;
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
  await db.put(STORES.TRANSACTIONS, {
    ...tx,
    updatedAt: Date.now(),
  });
}

/**
 * Delete a transaction by ID.
 */
export async function deleteTransaction(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORES.TRANSACTIONS, id);
}

// ============================================================
// Account CRUD
// ============================================================

/**
 * Get all accounts.
 */
export async function getAllAccounts(): Promise<Account[]> {
  const db = await getDB();
  return db.getAll(STORES.ACCOUNTS);
}

/**
 * Add a new account.
 */
export async function addAccount(account: Account): Promise<string> {
  const db = await getDB();
  await db.add(STORES.ACCOUNTS, account);
  return account.id;
}

// ============================================================
// Category CRUD
// ============================================================

/**
 * Get all categories.
 */
export async function getAllCategories(): Promise<Category[]> {
  const db = await getDB();
  return db.getAll(STORES.CATEGORIES);
}

/**
 * Add a new category.
 */
export async function addCategory(category: Category): Promise<string> {
  const db = await getDB();
  await db.add(STORES.CATEGORIES, category);
  return category.id;
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
}

/**
 * Delete an account by ID.
 */
export async function deleteAccount(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORES.ACCOUNTS, id);
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
}

/**
 * Delete a category by ID.
 */
export async function deleteCategory(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORES.CATEGORIES, id);
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
  await db.add(STORES.CASH_DENOMINATIONS, { ...cd, id });
  return id;
}

/**
 * Delete a cash denomination record by ID.
 */
export async function deleteCashDenomination(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORES.CASH_DENOMINATIONS, id);
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
  await db.add(STORES.PAYOUTS, { ...payout, id });
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
}

/**
 * Delete a payout record by ID.
 */
export async function deletePayout(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORES.PAYOUTS, id);
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
      await cursor.update({
        ...cursor.value,
        amount,
        updatedAt: now,
      });
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
}

/**
 * Get all budget target records.
 */
export async function getAllBudgetTargets(): Promise<BudgetTarget[]> {
  const db = await getDB();
  return db.getAll(STORES.BUDGET_TARGETS);
}

// ============================================================
// Seeding
// ============================================================

/**
 * Seed the stores with demo data if they are currently empty.
 * Safe to call on every app mount — only seeds when there are zero rows.
 */
export async function seedTransactionsIfEmpty(): Promise<void> {
  const db = await getDB();

  // ── Seed transactions ──
  const txCount = await db.count(STORES.TRANSACTIONS);
  if (txCount === 0) {
    for (const tx of SEED_TRANSACTIONS) {
      await db.add(STORES.TRANSACTIONS, {
        ...tx,
        id: generateId(),
        createdAt: new Date(tx.date).getTime(),
        updatedAt: new Date(tx.date).getTime(),
      });
    }
  }

  // ── Seed budget targets (new install or v3→v4 upgrade) ──
  const btCount = await db.count(STORES.BUDGET_TARGETS);
  if (btCount === 0) {
    const now = Date.now();
    for (const [category, amount] of Object.entries(DEFAULT_BUDGET_TARGETS)) {
      await db.add(STORES.BUDGET_TARGETS, {
        id: generateId(),
        category,
        month: null,
        amount,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
}
