// ============================================================
// CategoryBreakdown - Displays a breakdown of transactions by category
// Shows both category and account breakdowns.
// ============================================================

'use client';

import React, { useState } from 'react';
import { useTransactions } from '@/hooks/useTransactions';
import { formatCurrency, formatCurrencyShort } from '@/lib/utils';

type BreakdownTab = 'category' | 'account';

export function CategoryBreakdown() {
  const { categoryBreakdown, accountBreakdown, isLoading } = useTransactions();
  const [activeTab, setActiveTab] = useState<BreakdownTab>('category');

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
        <CategoryBreakdownList items={categoryBreakdown} />
      ) : (
        <AccountBreakdownList items={accountBreakdown} />
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

function CategoryBreakdownList({ items }: BreakdownListProps) {
  if (items.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
        No transactions this month.
      </p>
    );
  }

  // Find max amount for width scaling
  const maxAmount = Math.max(...items.map((i) => i.totalAmount));

  return (
    <div className="space-y-2.5">
      {items.map((item) => (
        <div key={item.category}>
          <div className="mb-1 flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  item.type === 'income'
                    ? 'bg-emerald-500'
                    : item.type === 'expense'
                      ? 'bg-red-500'
                      : 'bg-blue-500'
                }`}
              />
              <span className="font-medium text-zinc-800 dark:text-zinc-200">
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
              className={`h-full rounded-full transition-all duration-300 ${
                item.type === 'income'
                  ? 'bg-emerald-500'
                  : item.type === 'expense'
                    ? 'bg-red-500'
                    : 'bg-blue-500'
              }`}
              style={{ width: `${(item.totalAmount / maxAmount) * 100}%` }}
            />
          </div>
          <div className="mt-0.5 flex justify-between text-xs text-zinc-500 dark:text-zinc-500">
            <span>{item.count} {item.count === 1 ? 'entry' : 'entries'}</span>
            <span>{item.percentage.toFixed(1)}% of total</span>
          </div>
        </div>
      ))}
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
