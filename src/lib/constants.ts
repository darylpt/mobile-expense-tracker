// ============================================================
// Static constants for the Expense Tracker
// ============================================================

/** IDB database configuration */
export const DB_NAME = 'expense-tracker-db';
export const DB_VERSION = 8;

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
