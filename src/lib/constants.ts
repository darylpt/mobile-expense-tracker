// ============================================================
// Static constants for the Expense Tracker
// ============================================================

import type { Account, Category, Transaction } from '@/types';

/** Hardcoded list of available accounts (initial seed data) */
export const DEFAULT_ACCOUNTS: Account[] = [
  { id: 'gotyme', name: 'GoTyme', startingBalance: 0 },
  { id: 'gotyme-sona', name: 'GoTyme(Sona)', startingBalance: 0 },
  { id: 'cash', name: 'Cash', startingBalance: 0 },
  { id: 'landbank', name: 'Landbank', startingBalance: 0 },
  { id: 'seabank', name: 'Seabank', startingBalance: 0 },
  { id: 'gcash', name: 'Gcash', startingBalance: 0 },
  { id: 'bpi-banko', name: 'BPI BanKo', startingBalance: 0 },
  { id: 'dragonfi', name: 'DragonFi', startingBalance: 0 },
];

/** Hardcoded list of available categories */
export const DEFAULT_CATEGORIES: Category[] = [
  // Expense categories
  { id: 'food', name: 'Food', type: 'expense' },
  { id: 'home', name: 'Home', type: 'expense' },
  { id: 'personal', name: 'Personal', type: 'expense' },
  { id: 'health', name: 'Health', type: 'expense' },
  { id: 'transportation', name: 'Transportation', type: 'expense' },
  { id: 'savings', name: 'Savings', type: 'expense' },
  { id: 'investment', name: 'Investment', type: 'expense' },
  { id: 'motor-gas', name: 'Motor - Gas', type: 'expense' },
  { id: 'motor-maintenance', name: 'Motor - Maintenance', type: 'expense' },
  { id: 'other-expense', name: 'Other', type: 'expense' },
  { id: 'adjustments-expense', name: 'Adjustments', type: 'expense' },
  // Income categories
  { id: 'paycheck', name: 'Paycheck', type: 'income' },
  { id: 'bonus', name: 'Bonus', type: 'income' },
  { id: 'interest', name: 'Interest', type: 'income' },
  { id: 'cashback', name: 'Cashback', type: 'income' },
  { id: 'dividends', name: 'Dividends', type: 'income' },
  { id: 'other-income', name: 'Other', type: 'income' },
  { id: 'adjustments-income', name: 'Adjustments', type: 'income' },
  // Transaction (transfer) categories
  { id: 'savings-transfer', name: 'Savings Transfer', type: 'transaction' },
  { id: 'cash-in', name: 'Cash In', type: 'transaction' },
  { id: 'cash-out', name: 'Cash Out', type: 'transaction' },
  { id: 'carry-over', name: 'Carry Over', type: 'transaction' },
];

/**
 * Seed transaction data for demo purposes.
 * ~20 transactions spread across May and June 2026 so the month
 * navigation has content in both months on first launch.
 */
export const SEED_TRANSACTIONS: Array<
  Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>
> = [
  // ── June 2026 ──────────────────────────────────────────────
  { amount: 45000, date: '2026-06-01', type: 'income', category: 'Paycheck', fromAccount: null, toAccount: 'gotyme', description: 'Monthly salary' },
  { amount: 185.50, date: '2026-06-02', type: 'expense', category: 'Food', fromAccount: 'gcash', toAccount: null, description: 'Lunch at Mang Inasal' },
  { amount: 150, date: '2026-06-03', type: 'expense', category: 'Transportation', fromAccount: 'cash', toAccount: null, description: 'Jeepney & tricycle fare' },
  { amount: 2500, date: '2026-06-05', type: 'expense', category: 'Home', fromAccount: 'landbank', toAccount: null, description: 'Groceries at Puregold' },
  { amount: 850, date: '2026-06-07', type: 'expense', category: 'Personal', fromAccount: 'gcash', toAccount: null, description: 'Toiletries & skincare' },
  { amount: 499, date: '2026-06-10', type: 'expense', category: 'Health', fromAccount: 'cash', toAccount: null, description: 'Vitamins' },
  { amount: 320, date: '2026-06-12', type: 'expense', category: 'Transportation', fromAccount: 'cash', toAccount: null },
  { amount: 12000, date: '2026-06-15', type: 'income', category: 'Bonus', fromAccount: null, toAccount: 'gotyme', description: 'Mid-year bonus' },
  { amount: 450, date: '2026-06-18', type: 'expense', category: 'Food', fromAccount: 'gcash', toAccount: null, description: 'Cinema snacks' },
  { amount: 3200, date: '2026-06-20', type: 'expense', category: 'Home', fromAccount: 'landbank', toAccount: null, description: 'Electric bill' },
  { amount: 5000, date: '2026-06-22', type: 'transaction', category: 'Savings Transfer', fromAccount: 'gotyme', toAccount: 'landbank', description: 'Savings transfer' },
  { amount: 230, date: '2026-06-25', type: 'expense', category: 'Food', fromAccount: 'cash', toAccount: null },
  { amount: 1500, date: '2026-06-28', type: 'expense', category: 'Investment', fromAccount: 'gotyme', toAccount: 'dragonfi', description: 'Monthly investment' },
  // ── May 2026 ───────────────────────────────────────────────
  { amount: 45000, date: '2026-05-01', type: 'income', category: 'Paycheck', fromAccount: null, toAccount: 'gotyme', description: 'Monthly salary' },
  { amount: 250, date: '2026-05-04', type: 'expense', category: 'Food', fromAccount: 'gcash', toAccount: null, description: 'Lunch at Jollibee' },
  { amount: 120, date: '2026-05-08', type: 'expense', category: 'Transportation', fromAccount: 'cash', toAccount: null },
  { amount: 600, date: '2026-05-11', type: 'expense', category: 'Motor - Gas', fromAccount: 'cash', toAccount: null, description: 'Full tank' },
  { amount: 1500, date: '2026-05-15', type: 'expense', category: 'Investment', fromAccount: 'gotyme', toAccount: 'dragonfi', description: 'Monthly investment' },
  { amount: 750, date: '2026-05-19', type: 'expense', category: 'Food', fromAccount: 'gcash', toAccount: null, description: 'Dinner with friends' },
  { amount: 550, date: '2026-05-22', type: 'expense', category: 'Health', fromAccount: 'cash', toAccount: null, description: 'Check-up' },
  { amount: 1299, date: '2026-05-26', type: 'expense', category: 'Personal', fromAccount: 'gcash', toAccount: null, description: 'New shirt' },
  { amount: 5000, date: '2026-05-30', type: 'transaction', category: 'Savings Transfer', fromAccount: 'gotyme', toAccount: 'landbank', description: 'Savings transfer' },
];

/** Default budget targets (global, no month override) seeded on first launch */
export const DEFAULT_BUDGET_TARGETS: Record<string, number> = {
  Food: 8000,
  Home: 5000,
  Personal: 2000,
  Health: 1000,
  Transportation: 2000,
  Savings: 5000,
  Investment: 1500,
  'Motor - Gas': 1000,
  'Motor - Maintenance': 500,
  Other: 1000,
  Adjustments: 500,
};

/** IDB database configuration */
export const DB_NAME = 'expense-tracker-db';
export const DB_VERSION = 5;

/** Object store names */
export const STORES = {
  TRANSACTIONS: 'transactions',
  ACCOUNTS: 'accounts',
  CATEGORIES: 'categories',
  CASH_DENOMINATIONS: 'cashDenominations',
  PAYOUTS: 'payouts',
  BUDGET_TARGETS: 'budgetTargets',
  SYNC_QUEUE: 'syncQueue',
} as const;
