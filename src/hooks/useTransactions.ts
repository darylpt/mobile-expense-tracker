// ============================================================
// useTransactions - Convenience hook wrapping TransactionContext
// Provides filtered/sorted views for UI components.
// ============================================================

'use client';

import { useMemo } from 'react';
import { useTransactionContext } from '@/context/TransactionContext';
import {
  filterTransactionsByMonth,
  sortTransactionsByDate,
  calculateMonthlySummary,
  calculateCategoryBreakdown,
  calculateAccountBreakdown,
} from '@/lib/utils';
import {
  calculateAccountBalances,
  calculateIncomeBreakdown,
  calculateExpenseBreakdown,
} from '@/lib/aggregations';
import type {
  MonthlySummary,
  CategoryBreakdownItem,
  AccountBreakdownItem,
  AccountBalanceRow,
  IncomeBreakdownRow,
  ExpenseBreakdownRow,
} from '@/types';

// ponytail: default empty — callers that need budget targets pass them in
export function useTransactions(budgetTargets: Record<string, number> = {}) {
  const ctx = useTransactionContext();

  // Transactions filtered by the currently selected month/year
  const monthTransactions = useMemo(
    () => filterTransactionsByMonth(ctx.transactions, ctx.monthYear),
    [ctx.transactions, ctx.monthYear]
  );

  // Sorted version for display
  const sortedTransactions = useMemo(
    () => sortTransactionsByDate(monthTransactions),
    [monthTransactions]
  );

  // Monthly summary calculation
  const summary = useMemo<MonthlySummary>(
    () => calculateMonthlySummary(monthTransactions),
    [monthTransactions]
  );

  // Category breakdown
  const categoryBreakdown = useMemo<CategoryBreakdownItem[]>(
    () => calculateCategoryBreakdown(monthTransactions),
    [monthTransactions]
  );

  // Account breakdown
  const accountBreakdown = useMemo<AccountBreakdownItem[]>(
    () => calculateAccountBreakdown(monthTransactions),
    [monthTransactions]
  );

  // ── New: Summary/Dashboard aggregations (Task 3) ──

  // Account balances table (starting balance, inflow, outflow, ending)
  const accountBalances = useMemo<AccountBalanceRow[]>(
    () => calculateAccountBalances(monthTransactions, ctx.transactions, ctx.accounts, ctx.monthYear),
    [monthTransactions, ctx.transactions, ctx.accounts, ctx.monthYear]
  );

  // Income breakdown by category
  const incomeBreakdown = useMemo<IncomeBreakdownRow[]>(
    () => calculateIncomeBreakdown(monthTransactions),
    [monthTransactions]
  );

  // Expense breakdown by category
  const expenseBreakdown = useMemo(
    () => calculateExpenseBreakdown(monthTransactions, budgetTargets),
    [monthTransactions, budgetTargets]
  );

  return {
    // Raw data from context
    transactions: ctx.transactions,
    monthTransactions,
    sortedTransactions,
    isLoading: ctx.isLoading,
    error: ctx.error,
    monthYear: ctx.monthYear,

    // Computed summaries
    summary,
    categoryBreakdown,
    accountBreakdown,

    // Summary/Dashboard aggregations (Task 3)
    accountBalances,
    incomeBreakdown,
    expenseBreakdown,

    // Actions
    addTransaction: ctx.addTransaction,
    updateTransaction: ctx.updateTransaction,
    deleteTransaction: ctx.deleteTransaction,
    refreshTransactions: ctx.refreshTransactions,
    setMonthYear: ctx.setMonthYear,
  };
}
