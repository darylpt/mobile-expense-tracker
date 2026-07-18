// ============================================================
// Expense Tracker - TypeScript Type Definitions
// ============================================================

/** The type of a financial transaction */
export type TransactionType = 'income' | 'expense' | 'transaction';

/** Represents a single financial transaction record */
export interface Transaction {
  id: string;             // UUID or unique identifier
  amount: number;         // e.g., 50.00
  date: string;           // ISO 8601 string, e.g., "YYYY-MM-DD"
  type: TransactionType;
  category: string;       // e.g., "Food", "Paycheck", "Savings Transfer"
  fromAccount: string | null; // account id; null for pure income
  toAccount: string | null;   // account id; null for pure expense
  description?: string;   // Optional text description
  createdAt: number;      // Timestamp for creation (e.g., Date.now())
  updatedAt: number;      // Timestamp for last update
}

/** Represents a user-defined account */
export interface Account {
  id: string;
  name: string;
  startingBalance: number;
  /** Controls display order (lower = first). Assigned during DB migration v6. */
  sortOrder?: number;
  createdAt: number;      // Timestamp for creation (e.g., Date.now())
  updatedAt: number;      // Timestamp for last update
}

/** Represents a user-defined category */
export interface Category {
  id: string;             // UUID or unique identifier
  name: string;           // e.g., "Food", "Paycheck"
  type: TransactionType;  // Associates category with a transaction type
  /** Controls display order (lower = first). Assigned during DB migration v6. */
  sortOrder?: number;
  /** When true, expense transactions of this category show a "To Account" field. */
  hasDestinationAccount?: boolean;
  createdAt: number;      // Timestamp for creation (e.g., Date.now())
  updatedAt: number;      // Timestamp for last update
}

/** Shape of a monthly summary calculated from transactions */
export interface MonthlySummary {
  totalIncome: number;
  totalExpenses: number;
  netBalance: number;
  incomeCount: number;
  expenseCount: number;
  transferCount: number;
}

/** Shape of a category breakdown item */
export interface CategoryBreakdownItem {
  category: string;
  type: TransactionType;
  totalAmount: number;
  count: number;
  percentage: number;
}

/** Shape of an account breakdown item */
export interface AccountBreakdownItem {
  account: string;
  totalIncome: number;
  totalExpenses: number;
  netFlow: number;
}

/** A row in the Accounts table (per account starting/inflow/outflow/ending). */
export interface AccountBalanceRow {
  accountId: string;
  accountName: string;
  startingBalance: number;
  inflow: number;
  outflow: number;
  endingBalance: number;
}

/** A row in the Income Breakdown table. */
export interface IncomeBreakdownRow {
  category: string;
  amount: number;
  percentage: number;
}

/** A row in the Expenses Breakdown table. */
export interface ExpenseBreakdownRow {
  category: string;
  planned: number;
  amount: number;
  difference: number;
  percentage: number;
}

/** A snapshot of cash denomination counts (for Cash account reconciliation) */
export interface CashDenomination {
  id: string;
  date: string;       // ISO date "YYYY-MM-DD"
  denomination: number; // bill/coin value, e.g. 1000, 500, 100
  count: number;        // how many of that denomination
}

/** A single split in a payout record */
export interface PayoutSplit {
  person: string;
  value: number;     // ₱ amount or % depending on splitMode
}

/** A payout (secondary feature — occasional-use calculator) */
export interface Payout {
  id: string;
  date: string;      // ISO date
  totalAmount: number;
  splitMode: 'amount' | 'percentage';
  splits: PayoutSplit[];
  savingsSubSplit?: {
    emergencyPct: number;  // default 50
    wantsPct: number;      // default 15
    investmentPct: number; // default 20
    motorPct: number;      // default 15
  };
}

/** A budget target (planned spending limit) for a category */
export interface BudgetTarget {
  id: string;
  category: string;      // references an Expense category name
  month: string | null;  // "2026-06" format. null = global default
  amount: number;        // the "Planned" value
  createdAt: number;
  updatedAt: number;
}

/** The current month/year selection for the summary view */
export interface MonthYear {
  /** 0-indexed month (0 = January, 11 = December) */
  month: number;
  year: number;
}

/** A stock ticker tracked in the portfolio */
export interface Stock {
  id: string;              // uuid
  ticker: string;          // bare ticker, e.g. "BDO", "SM" (no .PS)
  type?: 'stock' | 'fund'; // 'stock' = PSE-listed (price-tracked), 'fund' = UITF/mutual fund (manual NAVPU)
  name: string;            // full company name
  currentPrice: number | null;  // from API or manual entry
  priceUpdatedAt: number | null; // Date.now() when price was last set
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** A buy/sell transaction for a stock */
export interface StockTransaction {
  id: string;              // uuid
  stockId: string;         // -> Stock.id
  date: string;            // ISO date "YYYY-MM-DD"
  type: 'buy' | 'sell';
  shares: number;
  pricePerShare: number;
  fees: number;            // default 0
  totalAmount: number;     // shares * pricePerShare + fees (for buys), shares * pricePerShare - fees (for sells)
  notes?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A dividend record for a stock */
export interface Dividend {
  id: string;              // uuid
  stockId: string;         // -> Stock.id
  date: string;            // ISO date "YYYY-MM-DD"
  type: 'cash' | 'stock';
  amount: number;          // cash amount received, or value of stock dividend
  sharesReceived?: number | null;  // only for stock dividends
  notes?: string | null;
  createdAt: number;
  updatedAt: number;
}
