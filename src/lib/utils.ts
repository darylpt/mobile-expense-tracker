// ============================================================
// General utility functions for the Expense Tracker
// ============================================================

import type { Transaction, MonthlySummary, CategoryBreakdownItem, AccountBreakdownItem, MonthYear } from '@/types';

/** Generate a UUID v4 via the Web Crypto API. */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Format a Date or ISO string to "YYYY-MM-DD".
 */
export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Get today's date as "YYYY-MM-DD".
 */
export function getToday(): string {
  return formatDate(new Date());
}

/**
 * Get the current month/year object.
 */
export function getCurrentMonthYear(): MonthYear {
  const now = new Date();
  return { month: now.getMonth(), year: now.getFullYear() };
}

/**
 * Get the month/year for the previous month.
 */
export function getPreviousMonthYear(m: MonthYear): MonthYear {
  if (m.month === 0) {
    return { month: 11, year: m.year - 1 };
  }
  return { month: m.month - 1, year: m.year };
}

/**
 * Get the month/year for the next month.
 */
export function getNextMonthYear(m: MonthYear): MonthYear {
  if (m.month === 11) {
    return { month: 0, year: m.year + 1 };
  }
  return { month: m.month + 1, year: m.year };
}

/**
 * Format a MonthYear as a display string (e.g., "June 2026").
 */
export function formatMonthYear(m: MonthYear): string {
  const date = new Date(m.year, m.month, 1);
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/**
 * Format a number as currency (PHP).
 */
export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Short format currency (no decimals for large numbers, or compact).
 */
export function formatCurrencyShort(amount: number): string {
  if (Math.abs(amount) >= 1_000_000) {
    return `₱${(amount / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(amount) >= 1_000) {
    return `₱${(amount / 1_000).toFixed(1)}K`;
  }
  return formatCurrency(amount);
}

/**
 * Filter transactions by month/year.
 */
export function filterTransactionsByMonth(txs: Transaction[], m: MonthYear): Transaction[] {
  return txs.filter((tx) => {
    const d = new Date(tx.date);
    return d.getMonth() === m.month && d.getFullYear() === m.year;
  });
}

/**
 * Sort transactions by date descending (most recent first).
 */
export function sortTransactionsByDate(txs: Transaction[]): Transaction[] {
  return [...txs].sort((a, b) => {
    const dateCmp = b.date.localeCompare(a.date);
    if (dateCmp !== 0) return dateCmp;
    return b.createdAt - a.createdAt;
  });
}

/**
 * Calculate a monthly summary from a list of transactions.
 */
export function calculateMonthlySummary(txs: Transaction[]): MonthlySummary {
  let totalIncome = 0;
  let totalExpenses = 0;
  let totalTransfers = 0;
  let incomeCount = 0;
  let expenseCount = 0;
  let transferCount = 0;

  for (const tx of txs) {
    switch (tx.type) {
      case 'income':
        totalIncome += tx.amount;
        incomeCount++;
        break;
      case 'expense':
        totalExpenses += tx.amount;
        expenseCount++;
        break;
      case 'transaction':
        totalTransfers += tx.amount;
        transferCount++;
        break;
    }
  }

  return {
    totalIncome,
    totalExpenses,
    totalTransfers,
    netBalance: totalIncome - totalExpenses,
    incomeCount,
    expenseCount,
    transferCount,
  };
}

/**
 * Calculate category breakdown from a list of transactions.
 */
export function calculateCategoryBreakdown(txs: Transaction[]): CategoryBreakdownItem[] {
  const grouped = new Map<string, { totalAmount: number; count: number; type: Transaction['type'] }>();

  for (const tx of txs) {
    const existing = grouped.get(tx.category);
    if (existing) {
      existing.totalAmount += tx.amount;
      existing.count++;
    } else {
      grouped.set(tx.category, { totalAmount: tx.amount, count: 1, type: tx.type });
    }
  }

  const totalAmount = txs.reduce((sum, tx) => sum + tx.amount, 0);

  return Array.from(grouped.entries())
    .map(([category, data]) => ({
      category,
      type: data.type,
      totalAmount: data.totalAmount,
      count: data.count,
      percentage: totalAmount > 0 ? (data.totalAmount / totalAmount) * 100 : 0,
    }))
    .sort((a, b) => b.totalAmount - a.totalAmount);
}

/**
 * Calculate account breakdown from a list of transactions.
 * Groups by account, tracking inflows (money in) and outflows (money out).
 * - income → inflow to toAccount
 * - expense → outflow from fromAccount
 * - transaction → outflow from fromAccount + inflow to toAccount
 */
export function calculateAccountBreakdown(txs: Transaction[]): AccountBreakdownItem[] {
  const grouped = new Map<string, { totalIncome: number; totalExpenses: number }>();

  for (const tx of txs) {
    if (tx.type === 'income' && tx.toAccount) {
      const entry = grouped.get(tx.toAccount) ?? { totalIncome: 0, totalExpenses: 0 };
      entry.totalIncome += tx.amount;
      grouped.set(tx.toAccount, entry);
    } else if (tx.type === 'expense' && tx.fromAccount) {
      const entry = grouped.get(tx.fromAccount) ?? { totalIncome: 0, totalExpenses: 0 };
      entry.totalExpenses += tx.amount;
      grouped.set(tx.fromAccount, entry);
      // Savings/Investment expenses may also have a toAccount — treat that as inflow to destination
      if (tx.toAccount) {
        const dest = grouped.get(tx.toAccount) ?? { totalIncome: 0, totalExpenses: 0 };
        dest.totalIncome += tx.amount;
        grouped.set(tx.toAccount, dest);
      }
    } else if (tx.type === 'transaction') {
      if (tx.fromAccount) {
        const src = grouped.get(tx.fromAccount) ?? { totalIncome: 0, totalExpenses: 0 };
        src.totalExpenses += tx.amount;
        grouped.set(tx.fromAccount, src);
      }
      if (tx.toAccount) {
        const dest = grouped.get(tx.toAccount) ?? { totalIncome: 0, totalExpenses: 0 };
        dest.totalIncome += tx.amount;
        grouped.set(tx.toAccount, dest);
      }
    }
  }

  return Array.from(grouped.entries())
    .map(([account, data]) => ({
      account,
      totalIncome: data.totalIncome,
      totalExpenses: data.totalExpenses,
      netFlow: data.totalIncome - data.totalExpenses,
    }))
    .sort((a, b) => b.netFlow - a.netFlow);
}
