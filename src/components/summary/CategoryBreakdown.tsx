// ============================================================
// CategoryBreakdown - Displays a breakdown of transactions by category
// Shows both category and account breakdowns.
// ============================================================

'use client';

import React, { useState, useMemo } from 'react';
import { useTransactions } from '@/hooks/useTransactions';
import { useCategories } from '@/hooks/useCategories';
import { useAccounts } from '@/hooks/useAccounts';
import { formatCurrency, formatCurrencyShort } from '@/lib/utils';

type BreakdownTab = 'category' | 'account';

export function CategoryBreakdown() {
  const { categoryBreakdown, accountBreakdown, isLoading } = useTransactions();
  const { categories } = useCategories();
  const { accounts } = useAccounts();
  const [activeTab, setActiveTab] = useState<BreakdownTab>('category');

  // Merge categories with transactions — show every known category, even with ₱0.00
  const enrichedCategoryBreakdown = useMemo(() => {
    const txMap = new Map(categoryBreakdown.map((c) => [c.category, c]));
    const seen = new Set<string>();
    const merged: typeof categoryBreakdown = [];

    // Show income categories first, then expense (matching sortOrder from IndexedDB)
    for (const cat of categories) {
      if (seen.has(cat.name)) continue;
      seen.add(cat.name);
      const existing = txMap.get(cat.name);
      merged.push(existing ?? {
        category: cat.name,
        type: cat.type,
        totalAmount: 0,
        count: 0,
        percentage: 0,
      });
    }

    // Any categories from transactions not in the known list (orphaned data)
    for (const item of categoryBreakdown) {
      if (!seen.has(item.category)) {
        seen.add(item.category);
        merged.push(item);
      }
    }

    return merged;
  }, [categoryBreakdown, categories]);

  // Build account ID → name lookup
  const accountNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts) m.set(a.id, a.name);
    return m;
  }, [accounts]);

  // Map account IDs to human-readable names
  const enrichedAccountBreakdown = useMemo(() => {
    const m = accountNameMap;
    const seen = new Set<string>();
    const merged: typeof accountBreakdown = [];

    // First, show all known accounts with their actual data
    for (const acct of accounts) {
      const existing = accountBreakdown.find((a) => a.account === acct.id);
      seen.add(acct.id);
      merged.push(existing
        ? { ...existing, account: acct.name }
        : { account: acct.name, totalIncome: 0, totalExpenses: 0, netFlow: 0 });
    }

    // Any accounts from transactions not in the known list
    for (const item of accountBreakdown) {
      if (!seen.has(item.account)) {
        seen.add(item.account);
        merged.push({ ...item, account: m.get(item.account) ?? item.account });
      }
    }

    return merged;
  }, [accountBreakdown, accounts, accountNameMap]);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
        <div className="h-6 w-40 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="mt-4 space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          Breakdown
        </h2>
        {/* Tabs */}
        <div className="flex rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-600">
          <button
            onClick={() => setActiveTab('category')}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              activeTab === 'category'
                ? 'bg-blue-600 text-white'
                : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
            }`}
          >
            Category
          </button>
          <button
            onClick={() => setActiveTab('account')}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              activeTab === 'account'
                ? 'bg-blue-600 text-white'
                : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
            }`}
          >
            Account
          </button>
        </div>
      </div>

      {activeTab === 'category' ? (
        <CategoryBreakdownList items={enrichedCategoryBreakdown} />
      ) : (
        <AccountBreakdownList items={enrichedAccountBreakdown} />
      )}
    </div>
  );
}

// ============================================================
// Category breakdown list
// ============================================================

interface BreakdownListProps {
  items: { category: string; totalAmount: number; count: number; percentage: number; type: string }[];
}

type GroupKey = 'income' | 'expense' | 'transfer';
const GROUP_LABEL: Record<GroupKey, string> = { income: 'Income', expense: 'Expenses', transfer: 'Transfers' };
const DOT_CLASS: Record<GroupKey, string> = { income: 'bg-emerald-500', expense: 'bg-red-500', transfer: 'bg-blue-500' };
const BAR_CLASS: Record<GroupKey, string> = { income: 'bg-emerald-500', expense: 'bg-red-500', transfer: 'bg-blue-500' };

function CategoryBreakdownList({ items }: BreakdownListProps) {
  if (items.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
        No transactions this month.
      </p>
    );
  }

  // Group by type, preserve insert order within each group
  const groups = useMemo(() => {
    const g: Record<GroupKey, typeof items> = { income: [], expense: [], transfer: [] };
    for (const item of items) {
      const key = item.type as GroupKey;
      if (g[key]) g[key].push(item);
    }
    return g;
  }, [items]);

  return (
    <div className="space-y-5">
      {(['income', 'expense'] as const).map((type) => {
        const group = groups[type];
        if (group.length === 0) return null;
        const maxAmount = Math.max(...group.map((i) => i.totalAmount));
        return (
          <section key={type}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              {GROUP_LABEL[type]}
            </h3>
            <div className="space-y-2.5">
              {group.map((item) => {
                const isZero = item.totalAmount === 0;
                return (
                  <div key={item.category} className={isZero ? 'opacity-40' : ''}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <span className={`inline-block h-2 w-2 rounded-full ${DOT_CLASS[type]}`} />
                        <span className={`font-medium ${isZero ? 'text-zinc-500 dark:text-zinc-500' : 'text-zinc-800 dark:text-zinc-200'}`}>
                          {item.category}
                        </span>
                      </div>
                      <span className="text-zinc-600 dark:text-zinc-400">
                        {formatCurrencyShort(item.totalAmount)}
                      </span>
                    </div>
                    {/* Progress bar */}
                    <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-700">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${BAR_CLASS[type]}`}
                        style={{ width: `${(item.totalAmount / maxAmount) * 100}%` }}
                      />
                    </div>
                    <div className="mt-0.5 flex justify-between text-xs text-zinc-500 dark:text-zinc-500">
                      <span>{item.count} {item.count === 1 ? 'entry' : 'entries'}</span>
                      <span>{item.percentage.toFixed(1)}% of total</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ============================================================
// Account breakdown list
// ============================================================

function AccountBreakdownList({ items }: { items: { account: string; totalIncome: number; totalExpenses: number; netFlow: number }[] }) {
  if (items.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
        No transactions this month.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <div
          key={item.account}
          className="rounded-lg border border-zinc-100 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/30"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-zinc-800 dark:text-zinc-200">
              {item.account}
            </span>
            <span
              className={`text-sm font-semibold ${
                item.netFlow >= 0
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : 'text-red-700 dark:text-red-400'
              }`}
            >
              {formatCurrencyShort(item.netFlow)}
            </span>
          </div>
          <div className="mt-1.5 flex gap-4 text-xs text-zinc-500 dark:text-zinc-400">
            <span>In: {formatCurrency(item.totalIncome)}</span>
            <span>Out: {formatCurrency(item.totalExpenses)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
