// ============================================================
// Shared test fixtures and seed helpers for E2E tests
// ============================================================

import { type Page } from '@playwright/test';

// ── Seed data types ────────────────────────────────────────────

export interface SeedAccount {
  id: string;
  name: string;
  startingBalance: number;
}

export interface SeedCategory {
  id: string;
  name: string;
  type: string;
}

export interface SeedTransaction {
  amount: number;
  date: string;
  type: string;
  category: string;
  fromAccount: string | null;
  toAccount: string | null;
  description?: string;
}

export interface SeedData {
  accounts: SeedAccount[];
  categories: SeedCategory[];
  transactions: SeedTransaction[];
}

// ── Default seed data ──────────────────────────────────────────

export const DEFAULT_SEED: SeedData = {
  accounts: [
    { id: 'bank-a', name: 'Bank A', startingBalance: 10000 },
    { id: 'bank-b', name: 'Bank B', startingBalance: 5000 },
    { id: 'cash', name: 'Cash', startingBalance: 2000 },
    // Unreferenced — for delete-succeeds test
    { id: 'gcash', name: 'Gcash', startingBalance: 0 },
  ],
  categories: [
    { id: 'food', name: 'Food', type: 'expense' },
    { id: 'paycheck', name: 'Paycheck', type: 'income' },
    { id: 'savings-transfer', name: 'Savings Transfer', type: 'transaction' },
    // Unreferenced — for delete-succeeds test
    { id: 'bonus', name: 'Bonus', type: 'income' },
  ],
  transactions: [
    {
      amount: 50000,
      date: '2026-06-01',
      type: 'income',
      category: 'Paycheck',
      fromAccount: null,
      toAccount: 'bank-a',
    },
    {
      amount: 1500,
      date: '2026-06-02',
      type: 'expense',
      category: 'Food',
      fromAccount: 'cash',
      toAccount: null,
    },
    {
      amount: 5000,
      date: '2026-06-03',
      type: 'transaction',
      category: 'Savings Transfer',
      fromAccount: 'bank-a',
      toAccount: 'bank-b',
    },
  ],
};

// ── IndexedDB seed helper ──────────────────────────────────────

/**
 * Wipes all IndexedDB data and re-seeds with the given data.
 * Call this in `beforeEach` so tests start from a known state.
 */
export async function seedIndexedDB(page: Page, data: SeedData): Promise<void> {
  await page.evaluate(async (seedData) => {
    const dName = 'expense-tracker-db';
    const dVer = 4;

    // Open (or create) the database, ensuring all stores exist
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dName, dVer);
      req.onupgradeneeded = (ev) => {
        const d = (ev.target as IDBOpenDBRequest).result;
        if (!d.objectStoreNames.contains('transactions')) {
          const s = d.createObjectStore('transactions', { keyPath: 'id' });
          s.createIndex('date', 'date', { unique: false });
          s.createIndex('type', 'type', { unique: false });
          s.createIndex('category', 'category', { unique: false });
          s.createIndex('account', 'account', { unique: false });
          s.createIndex('fromAccount', 'fromAccount', { unique: false });
          s.createIndex('toAccount', 'toAccount', { unique: false });
        }
        if (!d.objectStoreNames.contains('accounts')) {
          const s = d.createObjectStore('accounts', { keyPath: 'id' });
          s.createIndex('name', 'name', { unique: true });
        }
        if (!d.objectStoreNames.contains('categories')) {
          const s = d.createObjectStore('categories', { keyPath: 'id' });
          s.createIndex('name', 'name', { unique: false });
          s.createIndex('type', 'type', { unique: false });
        }
        if (!d.objectStoreNames.contains('cashDenominations')) {
          d.createObjectStore('cashDenominations', { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains('payouts')) {
          d.createObjectStore('payouts', { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains('budgetTargets')) {
          d.createObjectStore('budgetTargets', { keyPath: 'id' });
        }
      };
      req.onsuccess = (ev) => resolve((ev.target as IDBOpenDBRequest).result);
      req.onerror = () => reject(req.error);
    });

    // Clear all stores in one readwrite transaction
    const storeNames = Array.from(db.objectStoreNames);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeNames, 'readwrite');
      for (const name of storeNames) {
        tx.objectStore(name).clear();
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Seed accounts, categories, transactions
    const now = Date.now();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['accounts', 'categories', 'transactions'], 'readwrite');
      for (const a of seedData.accounts) {
        tx.objectStore('accounts').add(a);
      }
      for (const c of seedData.categories) {
        tx.objectStore('categories').add(c);
      }
      for (const t of seedData.transactions) {
        tx.objectStore('transactions').add({
          ...t,
          id: 'seed-' + Math.random().toString(36).slice(2, 10),
          createdAt: now,
          updatedAt: now,
        });
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }, data);
}

// ── Currency parser helper ─────────────────────────────────────

/** Parse a `₱1,234.56` formatted string back to a number. */
export function parseCurrency(text: string): number {
  return parseFloat(text.replace(/[₱$,]/g, ''));
}
