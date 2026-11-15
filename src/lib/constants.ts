// ============================================================
// Static constants for the Expense Tracker
// ============================================================

/** IDB database configuration */
export const DB_NAME = 'expense-tracker-db';
export const DB_VERSION = 15;

/** localStorage key identifying which account's data is cached locally. */
export const LAST_USER_STORAGE_KEY = 'lastUserId';

/** Object store names */
export const STORES = {
  TRANSACTIONS: 'transactions',
  ACCOUNTS: 'accounts',
  CATEGORIES: 'categories',
  CASH_DENOMINATIONS: 'cashDenominations',
  PAYOUTS: 'payouts',
  BUDGET_TARGETS: 'budgetTargets',
  DATASET_MARKERS: 'datasetMarkers',
  SYNC_QUEUE: 'syncQueue',
  /** Recoverable snapshots of records removed by a pull or replacement. */
  SYNC_DELETIONS: 'syncDeletions',
  STOCKS: 'stocks',
  STOCK_TRANSACTIONS: 'stockTransactions',
  DIVIDENDS: 'dividends',
  BALANCE_SNAPSHOTS: 'balanceSnapshots',
} as const;
