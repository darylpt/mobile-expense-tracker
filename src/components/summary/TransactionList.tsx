// ============================================================
// TransactionList - Displays a filterable, scrollable list of
// transactions with edit and delete capability.
// Filter state lives in URL search params (shareable/persistent).
// ============================================================

'use client';

import React, { useState, useMemo } from 'react';
import { useTransactionContext } from '@/context/TransactionContext';
import { useSearchParams, useRouter } from 'next/navigation';
import { formatCurrency, formatDate, formatMonthYear, getPreviousMonthYear, getNextMonthYear, getCurrentMonthYear } from '@/lib/utils';
import { Button } from '@/components/common/Button';
import { EditTransactionModal } from '@/components/forms/EditTransactionModal';
import type { Transaction, TransactionType } from '@/types';

export function TransactionList() {
  const ctx = useTransactionContext();
  const searchParams = useSearchParams();
  const router = useRouter();

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);
  const editButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  // ==================================================================
  // URL search param helpers
  // ==================================================================

  const setParam = (name: string, value: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === null || value === '') {
      params.delete(name);
    } else {
      params.set(name, value);
    }
    router.replace(`/transactions?${params.toString()}`, { scroll: false });
  };

  const removeParam = (name: string) => setParam(name, null);

  const clearFilters = () => {
    router.replace('/transactions', { scroll: false });
  };

  const getMonthParam = () => searchParams.get('month');
  const getTypeParam = (): TransactionType[] => {
    const p = searchParams.get('type');
    return p ? (p.split(',').filter(Boolean) as TransactionType[]) : ['income', 'expense', 'transaction'];
  };
  const getAccountParam = () => searchParams.get('account');
  const getQParam = () => searchParams.get('q');

  // ==================================================================
  // Derived state
  // ==================================================================

  // Account name lookups
  const accountMap = useMemo(() => new Map(ctx.accounts.map(a => [a.id, a.name])), [ctx.accounts]);

  // Current month displayed in the month selector
  const displayMonthYear = useMemo(() => {
    const monthParam = getMonthParam();
    if (monthParam) {
      const [yearStr, monthStr] = monthParam.split('-');
      return { year: parseInt(yearStr, 10), month: parseInt(monthStr, 10) - 1 };
    }
    return getCurrentMonthYear();
  }, [searchParams]);

  // Active filter counts
  const activeFilterCount = [getMonthParam(), getAccountParam(), getQParam()].filter(Boolean).length;
  const typeFilterActive = getTypeParam().length < 3;
  const totalActiveFilters = activeFilterCount + (typeFilterActive ? 1 : 0);

  // Type toggle handler
  const toggleType = (type: TransactionType) => {
    const current = getTypeParam();
    if (current.includes(type)) {
      const next = current.filter(t => t !== type);
      setParam('type', next.length > 0 && next.length < 3 ? next.join(',') : null);
    } else {
      setParam('type', [...current, type].join(','));
    }
  };

  // Month navigation
  const goToPrevMonth = () => {
    const prev = getPreviousMonthYear(displayMonthYear);
    setParam('month', `${prev.year}-${String(prev.month + 1).padStart(2, '0')}`);
  };
  const goToNextMonth = () => {
    const next = getNextMonthYear(displayMonthYear);
    setParam('month', `${next.year}-${String(next.month + 1).padStart(2, '0')}`);
  };

  // ==================================================================
  // Filter logic
  // ==================================================================

  const filteredTransactions = useMemo(() => {
    let result = ctx.transactions;

    // Month filter
    const monthParam = getMonthParam();
    if (monthParam) {
      const [yearStr, monthStr] = monthParam.split('-');
      const year = parseInt(yearStr, 10);
      const month = parseInt(monthStr, 10) - 1;
      result = result.filter(tx => {
        const d = new Date(tx.date);
        return d.getFullYear() === year && d.getMonth() === month;
      });
    }

    // Type filter
    const selectedTypes = getTypeParam();
    if (selectedTypes.length < 3) {
      result = result.filter(tx => selectedTypes.includes(tx.type));
    }

    // Account filter
    const accountParam = getAccountParam();
    if (accountParam) {
      const selectedAccounts = accountParam.split(',');
      result = result.filter(tx =>
        selectedAccounts.includes(tx.fromAccount ?? '') ||
        selectedAccounts.includes(tx.toAccount ?? '')
      );
    }

    // Search text filter
    const qParam = getQParam();
    if (qParam) {
      const lower = qParam.toLowerCase();
      result = result.filter(tx =>
        (tx.description ?? '').toLowerCase().includes(lower) ||
        tx.category.toLowerCase().includes(lower)
      );
    }

    // Sort by date descending (newest first)
    return [...result].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [ctx.transactions, searchParams]);

  // ==================================================================
  // Edit / Delete handlers
  // ==================================================================

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this transaction?')) return;
    setDeletingId(id);
    try {
      await ctx.deleteTransaction(id);
    } catch {
      // Error is handled in context
    } finally {
      setDeletingId(null);
    }
  };

  const handleEdit = (tx: Transaction, buttonEl: HTMLButtonElement) => {
    editButtonRef.current = buttonEl;
    setEditingTx(tx);
  };

  // Restore focus to the Edit button when the modal closes
  React.useEffect(() => {
    if (!editingTx && editButtonRef.current) {
      editButtonRef.current.focus();
      editButtonRef.current = null;
    }
  }, [editingTx]);

  // ==================================================================
  // Type chip config
  // ==================================================================

  const typeChips: { type: TransactionType; label: string; dotColor: string; activeClass: string; inactiveClass: string }[] = [
    {
      type: 'income',
      label: 'Income',
      dotColor: 'bg-emerald-500',
      activeClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
      inactiveClass: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
    },
    {
      type: 'expense',
      label: 'Expense',
      dotColor: 'bg-red-500',
      activeClass: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
      inactiveClass: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
    },
    {
      type: 'transaction',
      label: 'Transfer',
      dotColor: 'bg-blue-500',
      activeClass: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
      inactiveClass: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
    },
  ];

  // ==================================================================
  // Render
  // ==================================================================

  if (ctx.isLoading) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
        <div className="h-6 w-36 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="mt-4 space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
      <h2 className="mb-4 text-base font-semibold text-zinc-900 dark:text-zinc-100">
        Transactions
      </h2>

      {ctx.error && (
        <div className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-400">
          {ctx.error}
        </div>
      )}

      {/* ================================================================ */}
      {/* Filter Bar                                                       */}
      {/* ================================================================ */}
      <div className="mb-4 space-y-3">
        {/* ---- Row 1: Type chips + Filters toggle + active chips ---- */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Type filter chips */}
          <div className="flex items-center gap-1">
            {typeChips.map(({ type, label, dotColor, activeClass, inactiveClass }) => {
              const isActive = getTypeParam().includes(type);
              return (
                <button
                  key={type}
                  onClick={() => toggleType(type)}
                  aria-pressed={isActive}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    isActive ? activeClass : inactiveClass
                  }`}
                >
                  <span className={`inline-block h-2 w-2 rounded-full ${isActive ? dotColor : 'bg-zinc-300 dark:bg-zinc-600'}`} />
                  {label}
                </button>
              );
            })}
          </div>

          <div className="flex-1" />

          {/* Filters toggle button — hidden on lg+ since panel is always expanded */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowFilters(!showFilters)}
            aria-expanded={showFilters}
            className="relative gap-1 lg:hidden"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
            Filters
            {activeFilterCount > 0 && (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1.5 text-xs font-medium text-white">
                {activeFilterCount}
              </span>
            )}
            <svg
              className={`h-4 w-4 transition-transform ${showFilters ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </Button>
        </div>

        {/* Active filter chips (collapsed mobile view) */}
        {!showFilters && activeFilterCount > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 lg:hidden">
            {getMonthParam() && (
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                {formatMonthYear(displayMonthYear)}
                <button
                  onClick={() => removeParam('month')}
                  aria-label="Remove month filter"
                  className="ml-0.5 leading-none hover:text-blue-900 dark:hover:text-blue-200"
                >
                  ×
                </button>
              </span>
            )}
            {getAccountParam() && (
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                {getAccountParam()!.split(',').map(id => accountMap.get(id)).filter(Boolean).join(', ')}
                <button
                  onClick={() => removeParam('account')}
                  aria-label="Remove account filter"
                  className="ml-0.5 leading-none hover:text-blue-900 dark:hover:text-blue-200"
                >
                  ×
                </button>
              </span>
            )}
            {getQParam() && (
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                &ldquo;{getQParam()}&rdquo;
                <button
                  onClick={() => removeParam('q')}
                  aria-label="Remove search filter"
                  className="ml-0.5 leading-none hover:text-blue-900 dark:hover:text-blue-200"
                >
                  ×
                </button>
              </span>
            )}
          </div>
        )}

        {/* Clear all link */}
        {totalActiveFilters >= 2 && (
          <button onClick={clearFilters} className="text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300">
            Clear all
          </button>
        )}

        {/* ---- Row 2: Collapsible filter panel ---- */}
        <div
          className={`grid transition-all duration-200 ${
            showFilters ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
          } lg:grid-rows-[1fr]`}
        >
          <div className="overflow-hidden min-h-0 space-y-3">
          {/* Month selector */}
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={goToPrevMonth} aria-label="Previous month">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </Button>
            <span className="min-w-[140px] text-center text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {formatMonthYear(displayMonthYear)}
            </span>
            <Button variant="ghost" size="sm" onClick={goToNextMonth} aria-label="Next month">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Button>
            <button
              onClick={() => removeParam('month')}
              className={`text-xs font-medium ${
                getMonthParam()
                  ? 'text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300'
                  : 'text-zinc-400 dark:text-zinc-500'
              }`}
            >
              All time
            </button>
          </div>

          {/* Account + Search row */}
          <div className="flex flex-col gap-3 sm:flex-row">
            <select
              value={getAccountParam() ?? ''}
              onChange={(e) => setParam('account', e.target.value || null)}
              className="block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:focus:border-blue-400 sm:w-48"
            >
              <option value="">All accounts</option>
              {ctx.accounts.map(acct => (
                <option key={acct.id} value={acct.id}>
                  {acct.name}
                </option>
              ))}
            </select>

            <div className="relative flex-1">
              <svg
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={getQParam() ?? ''}
                onChange={(e) => setParam('q', e.target.value || null)}
                placeholder="Search description or category..."
                className="block w-full rounded-lg border border-zinc-300 bg-white py-2 pl-10 pr-3 text-sm text-zinc-900 placeholder-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-500 dark:focus:border-blue-400"
              />
            </div>
          </div>
          </div>{/* /overflow-hidden */}
        </div>{/* /grid transition */}
      </div>

      {/* ================================================================ */}
      {/* Transaction List                                                 */}
      {/* ================================================================ */}

      {ctx.transactions.length === 0 ? (
        <p className="py-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
          No transactions yet. Add one from the Summary page!
        </p>
      ) : filteredTransactions.length === 0 ? (
        <div className="py-4 text-center">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No transactions match your filters.
          </p>
          <button
            onClick={clearFilters}
            className="mt-2 text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-700">
          {filteredTransactions.map((tx) => (
            <div
              key={tx.id}
              className="flex items-center gap-3 py-2.5 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/30"
            >
              {/* Type indicator dot */}
              <span
                className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
                  tx.type === 'income'
                    ? 'bg-emerald-500'
                    : tx.type === 'expense'
                      ? 'bg-red-500'
                      : 'bg-blue-500'
                }`}
              />

              {/* Details */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {tx.category}
                  </span>
                  <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                    {tx.type === 'income'
                      ? `→ ${tx.toAccount ?? ''}`
                      : tx.type === 'expense'
                        ? `${tx.fromAccount ?? ''} →`
                        : `${tx.fromAccount ?? ''} → ${tx.toAccount ?? ''}`}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <span>{formatDate(tx.date)}</span>
                  {tx.description && (
                    <>
                      <span>·</span>
                      <span className="truncate">{tx.description}</span>
                    </>
                  )}
                </div>
              </div>

              {/* Amount + edit + delete */}
              <div className="flex items-center gap-2">
                <span
                  className={`text-sm font-semibold ${
                    tx.type === 'income'
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : tx.type === 'expense'
                        ? 'text-red-700 dark:text-red-400'
                        : 'text-blue-700 dark:text-blue-400'
                  }`}
                >
                  {tx.type === 'expense' ? '-' : '+'}
                  {formatCurrency(tx.amount)}
                </span>
                {/* Edit button */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => handleEdit(tx, e.currentTarget)}
                  aria-label="Edit transaction"
                  className="text-zinc-400 hover:text-blue-600 dark:text-zinc-500 dark:hover:text-blue-400"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                    />
                  </svg>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  isLoading={deletingId === tx.id}
                  onClick={() => handleDelete(tx.id)}
                  aria-label="Delete transaction"
                  className="text-zinc-400 hover:text-red-600 dark:text-zinc-500 dark:hover:text-red-400"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                    />
                  </svg>
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Edit transaction modal */}
      <EditTransactionModal
        transaction={editingTx}
        onClose={() => setEditingTx(null)}
      />
    </div>
  );
}
