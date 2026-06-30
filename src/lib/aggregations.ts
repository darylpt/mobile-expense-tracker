// ============================================================
// aggregations.ts — Pure aggregation functions for the Summary screen
//
// All functions are side-effect free.  Exported so they can be
// unit-tested without React or IndexedDB.
// ============================================================

import type {
  Transaction,
  Account,
  MonthYear,
  AccountBalanceRow,
  IncomeBreakdownRow,
  ExpenseBreakdownRow,
} from '@/types';

// ============================================================
// Helpers
// ============================================================

/**
 * Return the ISO string for the first day of the given month/year.
 * e.g. {month: 5, year: 2026} → "2026-06-01"
 */
function firstDayOfMonth(my: MonthYear): string {
  const m = my.month + 1; // 1-indexed
  return `${my.year}-${String(m).padStart(2, '0')}-01`;
}

/**
 * Return a lookup map from account id → account name.
 */
function accountNameMap(accounts: Account[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of accounts) m.set(a.id, a.name);
  return m;
}

// ============================================================
// Account balances
// ============================================================

/**
 * Compute per-account Starting Balance, Inflow, Outflow, and Ending Balance
 * for the given month.
 *
 * - **Starting Balance** = account's `startingBalance` + net flow from ALL
 *   transactions *before* the selected month.
 * - **Inflow** = sum of amounts where the account receives money in the
 *   current month (income's toAccount, expense's toAccount, transaction's toAccount).
 * - **Outflow** = sum of amounts where the account sends money in the
 *   current month (expense's fromAccount, transaction's fromAccount).
 * - **Ending Balance** = Starting Balance + Inflow − Outflow.
 *
 * Only accounts that have activity OR a non-zero starting balance are
 * included (zero-balance dormant accounts are skipped).
 *
 * A **TOTAL** row is appended at the end.
 */
export function calculateAccountBalances(
  transactions: Transaction[],       // current-month transactions
  allTransactions: Transaction[],    // all transactions in the DB
  accounts: Account[],
  monthYear: MonthYear
): AccountBalanceRow[] {
  const firstDay = firstDayOfMonth(monthYear);
  const names = accountNameMap(accounts);

  // ---- Prior-period transactions (date < first day of month) ----
  const priorTxs = allTransactions.filter((tx) => tx.date < firstDay);

  // Compute the net prior flow per account
  // (what the account gained/lost before this month)
  const priorNet = new Map<string, number>();
  function addPrior(acc: string | null, amount: number) {
    if (!acc) return;
    priorNet.set(acc, (priorNet.get(acc) ?? 0) + amount);
  }
  for (const tx of priorTxs) {
    switch (tx.type) {
      case 'income':
        addPrior(tx.toAccount, tx.amount);
        break;
      case 'expense':
        addPrior(tx.fromAccount, -tx.amount);
        addPrior(tx.toAccount, tx.amount);
        break;
      case 'transaction':
        addPrior(tx.fromAccount, -tx.amount);
        addPrior(tx.toAccount, tx.amount);
        break;
    }
  }

  // Starting balance = account.startingBalance + prior net flow
  const startBalance = new Map<string, number>();
  const accountStartingBalance = new Map<string, number>();
  for (const acct of accounts) {
    const prior = priorNet.get(acct.id) ?? 0;
    const sb = acct.startingBalance + prior;
    startBalance.set(acct.id, sb);
    accountStartingBalance.set(acct.id, acct.startingBalance);
  }

  // ---- Current-month transactions ----
  const inflow = new Map<string, number>();
  const outflow = new Map<string, number>();

  function addInflow(acc: string | null, amount: number) {
    if (!acc) return;
    inflow.set(acc, (inflow.get(acc) ?? 0) + amount);
  }
  function addOutflow(acc: string | null, amount: number) {
    if (!acc) return;
    outflow.set(acc, (outflow.get(acc) ?? 0) + amount);
  }

  for (const tx of transactions) {
    switch (tx.type) {
      case 'income':
        // Income: money goes to toAccount
        addInflow(tx.toAccount, tx.amount);
        break;
      case 'expense':
        // Expense: money leaves fromAccount; if toAccount exists (Savings/Investment), it also receives
        addOutflow(tx.fromAccount, tx.amount);
        addInflow(tx.toAccount, tx.amount);
        break;
      case 'transaction':
        // Transfer: leaves fromAccount, arrives toAccount
        addOutflow(tx.fromAccount, tx.amount);
        addInflow(tx.toAccount, tx.amount);
        break;
    }
  }

  // ---- Build result rows ----
  const rows: AccountBalanceRow[] = [];

  // Collect all accounts — show everything, user decides what to keep via Settings
  const accountIds = new Set(accounts.map((a) => a.id));

  // Sort by name for consistent output
  const sortedIds = [...accountIds].sort((a, b) =>
    (names.get(a) ?? a).localeCompare(names.get(b) ?? b)
  );

  let totalStarting = 0;
  let totalInflow = 0;
  let totalOutflow = 0;

  for (const id of sortedIds) {
    const sb = startBalance.get(id) ?? 0;
    const i = inflow.get(id) ?? 0;
    const o = outflow.get(id) ?? 0;
    const eb = sb + i - o;

    totalStarting += sb;
    totalInflow += i;
    totalOutflow += o;

    rows.push({
      accountId: id,
      accountName: names.get(id) ?? id,
      startingBalance: sb,
      inflow: i,
      outflow: o,
      endingBalance: eb,
    });
  }

  // TOTAL row
  const totalEnding = totalStarting + totalInflow - totalOutflow;
  rows.push({
    accountId: 'TOTAL',
    accountName: 'TOTAL',
    startingBalance: totalStarting,
    inflow: totalInflow,
    outflow: totalOutflow,
    endingBalance: totalEnding,
  });

  return rows;
}

// ============================================================
// Income breakdown
// ============================================================

/**
 * Build an income breakdown for the given month's transactions.
 * Only `type === 'income'` transactions are included.
 *
 * Returns rows sorted by amount descending, with a TOTAL row appended.
 */
export function calculateIncomeBreakdown(
  transactions: Transaction[],
  allCategories: string[] = []
): IncomeBreakdownRow[] {
  const incomeTxs = transactions.filter((tx) => tx.type === 'income');
  const totalIncome = incomeTxs.reduce((sum, tx) => sum + tx.amount, 0);

  // Group by category
  const byCategory = new Map<string, number>();
  for (const tx of incomeTxs) {
    byCategory.set(tx.category, (byCategory.get(tx.category) ?? 0) + tx.amount);
  }

  // Include categories with no activity (zero amount)
  for (const cat of allCategories) {
    if (!byCategory.has(cat)) {
      byCategory.set(cat, 0);
    }
  }

  const rows: IncomeBreakdownRow[] = [...byCategory.entries()]
    .map(([category, amount]) => ({
      category,
      amount,
      percentage: totalIncome > 0 ? (amount / totalIncome) * 100 : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  // TOTAL row
  rows.push({
    category: 'Total',
    amount: totalIncome,
    percentage: 100,
  });

  return rows;
}

// ============================================================
// Expenses breakdown
// ============================================================

/**
 * Build an expenses breakdown for the given month's transactions.
 * Only `type === 'expense'` transactions are included.
 *
 * Returns rows sorted by amount descending, with a TOTAL row appended.
 *
 * "Planned" comes from the provided budget targets map (category → amount).
 * "Difference" = Planned − Amount  (positive = under budget).
 */
export function calculateExpenseBreakdown(
  transactions: Transaction[],
  budgetTargets: Record<string, number> = {},
  allCategories: string[] = []
): ExpenseBreakdownRow[] {
  const expenseTxs = transactions.filter((tx) => tx.type === 'expense');
  const totalExpenses = expenseTxs.reduce((sum, tx) => sum + tx.amount, 0);

  // Group by category
  const byCategory = new Map<string, number>();
  for (const tx of expenseTxs) {
    byCategory.set(tx.category, (byCategory.get(tx.category) ?? 0) + tx.amount);
  }

  // Include categories with no activity (zero amount)
  for (const cat of allCategories) {
    if (!byCategory.has(cat)) {
      byCategory.set(cat, 0);
    }
  }

  const rows: ExpenseBreakdownRow[] = [...byCategory.entries()]
    .map(([category, amount]) => {
      const planned = budgetTargets[category] ?? 0;
      return {
        category,
        planned,
        amount,
        difference: planned - amount,
        percentage: totalExpenses > 0 ? (amount / totalExpenses) * 100 : 0,
      };
    })
    .sort((a, b) => b.amount - a.amount);

  // TOTAL row
  const totalPlanned = rows.reduce((s, r) => s + r.planned, 0);
  rows.push({
    category: 'Total',
    planned: totalPlanned,
    amount: totalExpenses,
    difference: totalPlanned - totalExpenses,
    percentage: 100,
  });

  return rows;
}

// ============================================================
// Re-export types so consumers can import from either location
// ============================================================

export type { AccountBalanceRow, IncomeBreakdownRow, ExpenseBreakdownRow };
