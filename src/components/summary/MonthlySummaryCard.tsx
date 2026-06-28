// ============================================================
// MonthlySummaryCard - Summary / Dashboard screen
//
// Top row: month navigation + Income / Expenses / Net cards
// Then:    Accounts table, Income Breakdown, Expenses Breakdown
// ============================================================

'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useTransactions } from '@/hooks/useTransactions';
import { useCategories } from '@/hooks/useCategories';
import { getAllBudgetTargets, setBudgetTarget } from '@/lib/idb';
import { calculateExpenseBreakdown } from '@/lib/aggregations';
import {
  formatCurrency,
  formatMonthYear,
  getPreviousMonthYear,
  getNextMonthYear,
} from '@/lib/utils';
import { Button } from '@/components/common/Button';

export function MonthlySummaryCard() {
  const {
    summary,
    monthYear,
    setMonthYear,
    isLoading,
    accountBalances,
    incomeBreakdown,
    monthTransactions,
  } = useTransactions();

  const { getCategoriesByType } = useCategories();
  const [editingBudgets, setEditingBudgets] = useState(false);
  const [budgetEdits, setBudgetEdits] = useState<Record<string, string>>({});

  // ── Budget target persistence ───────────────────────────────
  const [budgetTargets, setBudgetTargets] = useState<Record<string, number>>({});
  // ponytail: bump this counter after save to re-fetch without adding monthStr to deps that don't change
  const [budgetVersion, setBudgetVersion] = useState(0);

  // Format month as "YYYY-MM" for the budget target lookup
  const monthStr = useMemo(() => {
    const m = monthYear.month + 1;
    return `${monthYear.year}-${String(m).padStart(2, '0')}`;
  }, [monthYear]);

  // Fetch budget targets from IndexedDB and resolve effective values
  // ponytail: re-fetches on month change, which is O(n) with n < 200
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const all = await getAllBudgetTargets();
      if (cancelled) return;

      const overrides = new Map<string, number>();
      const globals = new Map<string, number>();
      for (const t of all) {
        if (t.month === monthStr) overrides.set(t.category, t.amount);
        else if (t.month === null) globals.set(t.category, t.amount);
      }

      const cats = getCategoriesByType('expense');
      const map: Record<string, number> = {};
      for (const c of cats) {
        // ponytail: override wins if it exists, otherwise fall back to global
        map[c.name] = overrides.has(c.name) ? overrides.get(c.name)! : (globals.get(c.name) ?? 0);
      }
      setBudgetTargets(map);
    }
    load();
    return () => { cancelled = true; };
  }, [monthStr, getCategoriesByType, budgetVersion]);

  // Compute expense breakdown with resolved budget targets
  const expenseBreakdown = useMemo(
    () => calculateExpenseBreakdown(monthTransactions, budgetTargets),
    [monthTransactions, budgetTargets]
  );

  // ── Editor handlers ─────────────────────────────────────────

  const handleEditBudgets = () => {
    const cats = getCategoriesByType('expense');
    if (cats.length === 0) return;
    const edits: Record<string, string> = {};
    for (const c of cats) {
      edits[c.name] = String(budgetTargets[c.name] ?? 0);
    }
    setBudgetEdits(edits);
    setEditingBudgets(true);
  };

  const handleSaveBudgets = async () => {
    for (const [cat, val] of Object.entries(budgetEdits)) {
      await setBudgetTarget(cat, parseFloat(val) || 0);
    }
    setEditingBudgets(false);
    setBudgetVersion((v) => v + 1); // trigger re-fetch
  };

  const handlePrevMonth = () => setMonthYear(getPreviousMonthYear(monthYear));
  const handleNextMonth = () => setMonthYear(getNextMonthYear(monthYear));

  if (isLoading) {
    return <LoadingSkeleton />;
  }

  return (
    <div className="space-y-6">
      {/* ── lg: grid — Accounts table (left) | Month nav/breakdowns (right) ── */}
      <div className="space-y-6 lg:grid lg:grid-cols-3 lg:gap-6 lg:space-y-0">
        {/* Left column — col-span-2: Accounts table (widest table) */}
        <div className="lg:col-span-2">
          <AccountsTable rows={accountBalances} />
        </div>

        {/* Right column — col-span-1: Month nav + stats + breakdowns */}
        <div className="space-y-6 lg:col-span-1">
          <SummaryHeader
            monthYear={monthYear}
            onPrev={handlePrevMonth}
            onNext={handleNextMonth}
            summary={summary}
          />

          <IncomeBreakdownTable rows={incomeBreakdown} />

          <ExpenseBreakdownTable rows={expenseBreakdown} />
        </div>
      </div>

      {/* ── Budget Targets Editor — full-width below grid ── */}
      {!editingBudgets && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={handleEditBudgets}>
            Edit Budgets
          </Button>
        </div>
      )}

      {editingBudgets && (
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
          <h2 className="mb-4 text-base font-semibold text-zinc-900 dark:text-zinc-100">
            Budget Targets
          </h2>
          <div className="space-y-3">
            {Object.entries(budgetEdits).map(([cat, value]) => (
              <div key={cat} className="flex items-center gap-4">
                <span className="w-36 shrink-0 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  {cat}
                </span>
                <div className="relative max-w-48 flex-1">
                  <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-sm text-zinc-500">
                    ₱
                  </span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={value}
                    onChange={(e) =>
                      setBudgetEdits({ ...budgetEdits, [cat]: e.target.value })
                    }
                    className="w-full rounded-lg border border-zinc-300 bg-white py-1.5 pl-8 pr-3 text-sm text-zinc-900 transition-colors focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:focus:border-blue-400"
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditingBudgets(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleSaveBudgets}>
              Save Budgets
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Loading skeleton
// ============================================================

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
        <div className="h-6 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="mt-4 grid grid-cols-3 gap-4">
          <div className="h-16 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
          <div className="h-16 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
          <div className="h-16 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
        </div>
      </div>
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6"
        >
          <div className="mb-4 h-6 w-40 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
          <div className="h-32 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
        </div>
      ))}
    </div>
  );
}

// ============================================================
// Summary header
// ============================================================

interface SummaryHeaderProps {
  monthYear: { month: number; year: number };
  onPrev: () => void;
  onNext: () => void;
  summary: {
    totalIncome: number;
    totalExpenses: number;
    netBalance: number;
    incomeCount: number;
    expenseCount: number;
    transferCount: number;
  };
}

function SummaryHeader({ monthYear, onPrev, onNext, summary }: SummaryHeaderProps) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
      {/* Month navigation */}
      <div className="mb-4 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onPrev} aria-label="Previous month">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </Button>
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          {formatMonthYear(monthYear)}
        </h2>
        <Button variant="ghost" size="sm" onClick={onNext} aria-label="Next month">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Button>
      </div>

      {/* Summary grid */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg bg-emerald-50 p-3 dark:bg-emerald-900/20">
          <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Income</p>
          <p className="mt-1 text-lg font-bold text-emerald-800 dark:text-emerald-300">
            {formatCurrency(summary.totalIncome)}
          </p>
          <p className="text-xs text-emerald-600 dark:text-emerald-500">
            {summary.incomeCount} {summary.incomeCount === 1 ? 'entry' : 'entries'}
          </p>
        </div>
        <div className="rounded-lg bg-red-50 p-3 dark:bg-red-900/20">
          <p className="text-xs font-medium text-red-700 dark:text-red-400">Expenses</p>
          <p className="mt-1 text-lg font-bold text-red-800 dark:text-red-300">
            {formatCurrency(summary.totalExpenses)}
          </p>
          <p className="text-xs text-red-600 dark:text-red-500">
            {summary.expenseCount} {summary.expenseCount === 1 ? 'entry' : 'entries'}
          </p>
        </div>
        <div className="rounded-lg bg-blue-50 p-3 dark:bg-blue-900/20">
          <p className="text-xs font-medium text-blue-700 dark:text-blue-400">Net</p>
          <p
            className={`mt-1 text-lg font-bold ${
              summary.netBalance >= 0
                ? 'text-blue-800 dark:text-blue-300'
                : 'text-red-800 dark:text-red-300'
            }`}
          >
            {formatCurrency(summary.netBalance)}
          </p>
          <p className="text-xs text-blue-600 dark:text-blue-500">
            {summary.transferCount > 0
              ? `${summary.transferCount} transfer${summary.transferCount > 1 ? 's' : ''}`
              : 'No transfers'}
          </p>
        </div>
      </div>

      <div className="mt-3 text-center text-xs text-zinc-500 dark:text-zinc-400">
        Total transactions: {summary.incomeCount + summary.expenseCount + summary.transferCount}
      </div>
    </div>
  );
}

// ============================================================
// Accounts table
// ============================================================

interface AccountRow {
  accountId: string;
  accountName: string;
  startingBalance: number;
  inflow: number;
  outflow: number;
  endingBalance: number;
}

function AccountsTable({ rows }: { rows: AccountRow[] }) {
  if (rows.length === 0) {
    return (
      <SectionCard title="Accounts">
        <p className="py-4 text-center text-sm text-zinc-500">No accounts configured.</p>
      </SectionCard>
    );
  }

  // Separate data rows from the TOTAL row
  const dataRows = rows.filter((r) => r.accountId !== 'TOTAL');
  const totalRow = rows.find((r) => r.accountId === 'TOTAL');

  return (
    <SectionCard title="Accounts">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-xs uppercase text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              <th className="py-2 pr-4 font-medium">Account</th>
              <th className="py-2 px-2 text-right font-medium">Starting Balance</th>
              <th className="py-2 px-2 text-right font-medium">Inflow</th>
              <th className="py-2 px-2 text-right font-medium">Outflow</th>
              <th className="py-2 pl-2 text-right font-medium">Ending Balance</th>
            </tr>
          </thead>
          <tbody>
            {dataRows.map((row) => (
              <tr
                key={row.accountId}
                className="border-b border-zinc-100 text-zinc-800 last:border-0 dark:border-zinc-800 dark:text-zinc-200"
              >
                <td className="py-2 pr-4 font-medium">{row.accountName}</td>
                <td className="py-2 px-2 text-right tabular-nums">{formatCurrency(row.startingBalance)}</td>
                <td className="py-2 px-2 text-right tabular-nums text-emerald-700 dark:text-emerald-400">
                  {formatCurrency(row.inflow)}
                </td>
                <td className="py-2 px-2 text-right tabular-nums text-red-700 dark:text-red-400">
                  {formatCurrency(row.outflow)}
                </td>
                <td className="py-2 pl-2 text-right tabular-nums font-semibold">
                  {formatCurrency(row.endingBalance)}
                </td>
              </tr>
            ))}
            {totalRow && (
              <tr className="border-t-2 border-zinc-300 bg-zinc-50 font-semibold dark:border-zinc-600 dark:bg-zinc-800/40">
                <td className="py-2.5 pr-4 text-sm text-zinc-900 dark:text-zinc-100">TOTAL</td>
                <td className="py-2.5 px-2 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                  {formatCurrency(totalRow.startingBalance)}
                </td>
                <td className="py-2.5 px-2 text-right tabular-nums text-emerald-700 dark:text-emerald-400">
                  {formatCurrency(totalRow.inflow)}
                </td>
                <td className="py-2.5 px-2 text-right tabular-nums text-red-700 dark:text-red-400">
                  {formatCurrency(totalRow.outflow)}
                </td>
                <td className="py-2.5 pl-2 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                  {formatCurrency(totalRow.endingBalance)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ============================================================
// Income Breakdown table
// ============================================================

interface IncomeRow {
  category: string;
  amount: number;
  percentage: number;
}

function IncomeBreakdownTable({ rows }: { rows: IncomeRow[] }) {
  return (
    <SectionCard title="Income Breakdown">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-xs uppercase text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              <th className="py-2 pr-4 font-medium">Category</th>
              <th className="py-2 px-2 text-right font-medium">Amount</th>
              <th className="py-2 pl-2 text-right font-medium">% of Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isTotal = row.category === 'Total';
              return (
                <tr
                  key={row.category}
                  className={
                    isTotal
                      ? 'border-t-2 border-zinc-300 bg-zinc-50 font-semibold dark:border-zinc-600 dark:bg-zinc-800/40'
                      : 'border-b border-zinc-100 text-zinc-800 last:border-0 dark:border-zinc-800 dark:text-zinc-200'
                  }
                >
                  <td
                    className={`py-2 pr-4 ${isTotal ? 'text-zinc-900 dark:text-zinc-100' : ''}`}
                  >
                    {row.category}
                  </td>
                  <td
                    className={`py-2 px-2 text-right tabular-nums ${
                      isTotal
                        ? 'text-zinc-900 dark:text-zinc-100'
                        : 'text-emerald-700 dark:text-emerald-400'
                    }`}
                  >
                    {formatCurrency(row.amount)}
                  </td>
                  <td className="py-2 pl-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                    {row.percentage.toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ============================================================
// Expenses Breakdown table
// ============================================================

interface ExpenseRow {
  category: string;
  planned: number;
  amount: number;
  difference: number;
  percentage: number;
}

function ExpenseBreakdownTable({ rows }: { rows: ExpenseRow[] }) {
  return (
    <SectionCard title="Expenses Breakdown">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-xs uppercase text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              <th className="py-2 pr-3 font-medium">Category</th>
              <th className="py-2 px-2 text-right font-medium">Planned</th>
              <th className="py-2 px-2 text-right font-medium">Amount</th>
              <th className="py-2 px-2 text-right font-medium">Difference</th>
              <th className="py-2 pl-2 text-right font-medium">% of Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isTotal = row.category === 'Total';
              return (
                <tr
                  key={row.category}
                  className={
                    isTotal
                      ? 'border-t-2 border-zinc-300 bg-zinc-50 font-semibold dark:border-zinc-600 dark:bg-zinc-800/40'
                      : 'border-b border-zinc-100 text-zinc-800 last:border-0 dark:border-zinc-800 dark:text-zinc-200'
                  }
                >
                  <td
                    className={`py-2 pr-3 ${isTotal ? 'text-zinc-900 dark:text-zinc-100' : ''}`}
                  >
                    {row.category}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                    {formatCurrency(row.planned)}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums text-red-700 dark:text-red-400">
                    {formatCurrency(row.amount)}
                  </td>
                  <td
                    className={`py-2 px-2 text-right tabular-nums ${
                      row.difference >= 0
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-red-700 dark:text-red-400'
                    }`}
                  >
                    {row.difference >= 0 ? '+' : ''}
                    {formatCurrency(row.difference)}
                  </td>
                  <td className="py-2 pl-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                    {row.percentage.toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ============================================================
// Shared section card wrapper
// ============================================================

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
      <h2 className="mb-4 text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
      {children}
    </div>
  );
}
