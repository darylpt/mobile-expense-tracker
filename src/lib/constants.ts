// ============================================================
// Static constants for the Expense Tracker
// ============================================================

/** IDB database configuration */
export const DB_NAME = 'expense-tracker-db';
export const DB_VERSION = 14;

/** Object store names */
export const STORES = {
  TRANSACTIONS: 'transactions',
  ACCOUNTS: 'accounts',
  CATEGORIES: 'categories',
  CASH_DENOMINATIONS: 'cashDenominations',
  PAYOUTS: 'payouts',
  BUDGET_TARGETS: 'budgetTargets',
  SYNC_QUEUE: 'syncQueue',
  STOCKS: 'stocks',
  STOCK_TRANSACTIONS: 'stockTransactions',
  DIVIDENDS: 'dividends',
  BALANCE_SNAPSHOTS: 'balanceSnapshots',
  // ── Phase 3A sync safety metadata ──
  /** Per-record remote baselines / conflict snapshots. */
  SYNC_META: 'syncMeta',
  /** Durable archives of locally deleted records. */
  SYNC_DELETIONS: 'syncDeletions',
} as const;

/**
 * All stores that hold user financial data and participate in sync.
 * Order is dependency-friendly: parents before children.
 */
export const DATA_STORES = [
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

/** localStorage key identifying which account's data is cached locally. */
export const LAST_USER_STORAGE_KEY = 'lastUserId';

/**
 * Number of failed attempts before an outbox entry is paused. The entry is
 * never deleted; it stays on disk with its payload and error history until a
 * user explicitly retries or resolves it.
 */
export const SYNC_RETRY_PAUSE_THRESHOLD = 5;
