// ============================================================
// TransactionList - Displays a filterable, scrollable list of
// transactions with edit and delete capability.
// Filter state lives in URL search params (shareable/persistent).
// ============================================================

'use client';

import React, { useState, useMemo, useEffect } from 'react';
import Link from 'next/link';
import { useTransactionContext } from '@/context/TransactionContext';
import { useSearchParams, useRouter } from 'next/navigation';
import { formatCurrency, formatMonthYear, getPreviousMonthYear, getNextMonthYear, getCurrentMonthYear } from '@/lib/utils';
import { Button } from '@/components/common/Button';
import { EditTransactionModal } from '@/components/forms/EditTransactionModal';
import type { Transaction, TransactionType } from '@/types';

export function TransactionList() {
  const ctx = useTransactionContext();
  const searchParams = useSearchParams();
  const router = useRouter();

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);
  const [actionMenuId, setActionMenuId] = useState<string | null>(null);
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
  const getCatParam = () => searchParams.get('cat');
  const getQParam = () => searchParams.get('q');
  const getGroupParam = () => searchParams.get('group');
  const PAGE_SIZE = 50;
  const getPageParam = () => {
    const p = searchParams.get('page');
    return p ? Math.max(1, parseInt(p, 10)) : 1;
  };

  // ==================================================================
  // Derived state
  // ==================================================================

  // Account name lookups
  const accountMap = useMemo(() => new Map(ctx.accounts.map(a => [a.id, a.name])), [ctx.accounts]);

  // Current month displayed in the month selector
  const displayMonthYear = useMemo(() => {
    const monthParam = searchParams.get('month');
    if (monthParam) {
      const [yearStr, monthStr] = monthParam.split('-');
      return { year: parseInt(yearStr, 10), month: parseInt(monthStr, 10) - 1 };
    }
    return getCurrentMonthYear();
  }, [searchParams]);

  // Unique categories derived from transactions (for desktop category filter)
  const uniqueCategories = useMemo(
    () => [...new Set(ctx.transactions.map(tx => tx.category))].sort(),
    [ctx.transactions]
  );

  // Active filter counts
  const activeFilterCount = [getMonthParam(), getAccountParam(), getCatParam(), getQParam()].filter(Boolean).length;
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
    const monthParam = searchParams.get('month');
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
    const typeRaw = searchParams.get('type');
    const selectedTypes = typeRaw ? (typeRaw.split(',').filter(Boolean) as TransactionType[]) : ['income', 'expense', 'transaction'];
    if (selectedTypes.length < 3) {
      result = result.filter(tx => selectedTypes.includes(tx.type));
    }

    // Account filter
    const accountParam = searchParams.get('account');
    if (accountParam) {
      const selectedAccounts = accountParam.split(',');
      result = result.filter(tx =>
        selectedAccounts.includes(tx.fromAccount ?? '') ||
        selectedAccounts.includes(tx.toAccount ?? '')
      );
    }

    // Category filter
    const catParam = searchParams.get('cat');
    if (catParam) {
      result = result.filter(tx => tx.category === catParam);
    }

    // Search text filter
    const qParam = searchParams.get('q');
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
  // Pagination & grouping state
  // ==================================================================

  const hasActiveFilters = useMemo(() => {
    const typeRaw = searchParams.get('type');
    const selectedTypes = typeRaw ? (typeRaw.split(',').filter(Boolean) as TransactionType[]) : ['income', 'expense', 'transaction'];
    return !!searchParams.get('month') || !!searchParams.get('account') || !!searchParams.get('cat') || !!searchParams.get('q') || selectedTypes.length < 3;
  }, [searchParams]);

  const totalPages = hasActiveFilters ? 1 : Math.max(1, Math.ceil(filteredTransactions.length / PAGE_SIZE));
  const page = hasActiveFilters ? 1 : Math.min(getPageParam(), totalPages);

  const pageTransactions = useMemo(() => {
    if (hasActiveFilters) return filteredTransactions;
    const start = (page - 1) * PAGE_SIZE;
    return filteredTransactions.slice(start, start + PAGE_SIZE);
  }, [filteredTransactions, hasActiveFilters, page]);

  const grouped = useMemo(() => {
    if (!searchParams.get('group')) return null;
    const groups: { date: string; displayDate: string; txs: Transaction[] }[] = [];
    let currentDate = '';
    let currentGroup: Transaction[] = [];
    for (const tx of pageTransactions) {
      if (tx.date !== currentDate) {
        if (currentGroup.length > 0) {
          groups.push({ date: currentDate, displayDate: new Date(currentDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }), txs: currentGroup });
        }
        currentDate = tx.date;
        currentGroup = [tx];
      } else {
        currentGroup.push(tx);
      }
    }
    if (currentGroup.length > 0) {
      groups.push({ date: currentDate, displayDate: new Date(currentDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }), txs: currentGroup });
    }
    return groups;
  }, [pageTransactions, searchParams]);

  // Reset page param when filters change
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (params.has('page') && hasActiveFilters) {
      params.delete('page');
      router.replace(`/transactions?${params.toString()}`, { scroll: false });
    }
  }, [hasActiveFilters, router, searchParams]);

  // Summary stats for desktop metric cards (must be after filteredTransactions)
  const summaryStats = useMemo(() => {
    let income = 0, expenses = 0, transfers = 0;
    for (const tx of filteredTransactions) {
      if (tx.type === 'income') income += tx.amount;
      else if (tx.type === 'expense') expenses += tx.amount;
      else transfers += tx.amount;
    }
    return { income, expenses, net: income - expenses, transfers };
  }, [filteredTransactions]);

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

  const handleEdit = (tx: Transaction) => {
    setEditingTx(tx);
  };

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
      {/* Desktop header row — title + count + month nav                   */}
      {/* ================================================================ */}
      <div className="hidden lg:flex lg:items-center lg:justify-between lg:mb-4">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Transactions
          <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-sm font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {filteredTransactions.length}
          </span>
        </h2>
        <div className="flex items-center gap-2">
          <button onClick={goToPrevMonth} className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200" aria-label="Previous month">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <span className="min-w-[140px] text-center text-sm font-medium text-zinc-700 dark:text-zinc-300">
            {formatMonthYear(displayMonthYear)}
          </span>
          <button onClick={goToNextMonth} className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200" aria-label="Next month">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          </button>
        </div>
      </div>

      {/* ================================================================ */}
      {/* Desktop summary stats — 4 metric cards                           */}
      {/* ================================================================ */}
      <div className="hidden lg:grid lg:grid-cols-4 lg:gap-4 lg:mb-4">
        <StatCard label="Income" value={formatCurrency(summaryStats.income)} color="text-emerald-700 dark:text-emerald-400" />
        <StatCard label="Expenses" value={formatCurrency(summaryStats.expenses)} color="text-red-700 dark:text-red-400" />
        <StatCard
          label="Net"
          value={formatCurrency(Math.abs(summaryStats.net))}
          color={summaryStats.net >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}
        />
        <StatCard label="Transfers" value={formatCurrency(summaryStats.transfers)} color="text-zinc-700 dark:text-zinc-300" />
      </div>

      {/* ================================================================ */}
      {/* Filter Bar — mobile vs desktop layouts                           */}
      {/* ================================================================ */}

      {/* ---- Mobile: chips row + toggle + collapsible panel ---- */}
      <div className="lg:hidden mb-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
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

          <button
            onClick={() => setParam('group', getGroupParam() ? null : 'date')}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              getGroupParam()
                ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400'
                : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
            }`}
          >
            {getGroupParam() ? 'Grouped' : 'Group by date'}
          </button>

          <div className="flex-1" />

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
            <svg className={`h-4 w-4 transition-transform ${showFilters ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </Button>
        </div>

        {!showFilters && activeFilterCount > 0 && (
          <FilterPills
            monthParam={getMonthParam()}
            accountParam={getAccountParam()}
            catParam={getCatParam()}
            qParam={getQParam()}
            displayMonthYear={displayMonthYear}
            accountMap={accountMap}
            onRemoveMonth={() => removeParam('month')}
            onRemoveAccount={() => removeParam('account')}
            onRemoveCat={() => removeParam('cat')}
            onRemoveQ={() => removeParam('q')}
          />
        )}

        {totalActiveFilters >= 2 && (
          <button onClick={clearFilters} className="text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300">
            Clear all
          </button>
        )}

        <div className={`grid transition-all duration-200 ${showFilters ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'} lg:grid-rows-[1fr]`}>
          <div className="overflow-hidden min-h-0 space-y-3">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={goToPrevMonth} aria-label="Previous month">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
              </Button>
              <span className="min-w-[140px] text-center text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {formatMonthYear(displayMonthYear)}
              </span>
              <Button variant="ghost" size="sm" onClick={goToNextMonth} aria-label="Next month">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
              </Button>
              <button onClick={() => removeParam('month')} className={`text-xs font-medium ${getMonthParam() ? 'text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300' : 'text-zinc-400 dark:text-zinc-500'}`}>
                All time
              </button>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <select value={getAccountParam() ?? ''} onChange={(e) => setParam('account', e.target.value || null)} className="block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:focus:border-blue-400 sm:w-48">
                <option value="">All accounts</option>
                {ctx.accounts.map(acct => (<option key={acct.id} value={acct.id}>{acct.name}</option>))}
              </select>
              <div className="relative flex-1">
                <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                <input type="text" value={getQParam() ?? ''} onChange={(e) => setParam('q', e.target.value || null)} placeholder="Search description or category..." className="block w-full rounded-lg border border-zinc-300 bg-white py-2 pl-10 pr-3 text-sm text-zinc-900 placeholder-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-500 dark:focus:border-blue-400" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ---- Desktop: single horizontal filter row ---- */}
      <div className="hidden lg:flex lg:items-center lg:gap-3 lg:mb-2">
        {/* Type chips */}
        <div className="flex items-center gap-1 shrink-0">
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

        <span className="h-6 w-px bg-zinc-200 dark:bg-zinc-700" />

        {/* ponytail: view toggle separated from type filters by a divider */}
        <button
          onClick={() => setParam('group', getGroupParam() ? null : 'date')}
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            getGroupParam()
              ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400'
              : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
          }`}
        >
          {getGroupParam() ? 'Grouped' : 'Group by date'}
        </button>

        <span className="h-6 w-px bg-zinc-200 dark:bg-zinc-700" />

        {/* Search input */}
        <div className="relative flex-1 max-w-[260px]">
          <svg className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
          <input type="text" value={getQParam() ?? ''} onChange={(e) => setParam('q', e.target.value || null)} placeholder="Search description…" className="block w-full rounded-lg border border-zinc-300 bg-white py-1.5 pl-8 pr-3 text-sm text-zinc-900 placeholder-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-500 dark:focus:border-blue-400" />
        </div>

        {/* Account dropdown */}
        <select value={getAccountParam() ?? ''} onChange={(e) => setParam('account', e.target.value || null)} className="block w-44 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:focus:border-blue-400">
          <option value="">All accounts</option>
          {ctx.accounts.map(acct => (<option key={acct.id} value={acct.id}>{acct.name}</option>))}
        </select>

        {/* Category dropdown */}
        <select value={getCatParam() ?? ''} onChange={(e) => setParam('cat', e.target.value || null)} className="block w-44 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:focus:border-blue-400">
          <option value="">All categories</option>
          {uniqueCategories.map(cat => (<option key={cat} value={cat}>{cat}</option>))}
        </select>
      </div>

      {/* ---- Desktop active filter pills row ---- */}
      <div className="hidden lg:flex lg:items-center lg:gap-2 lg:mb-4 lg:min-h-[28px]">
        {totalActiveFilters > 0 && (
          <>
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Filters:</span>
            {getTypeParam().length < 3 && getTypeParam().map(t => (
              <span key={t} className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                {t.charAt(0).toUpperCase() + t.slice(1)}
                <button onClick={() => toggleType(t)} aria-label={`Remove ${t} filter`} className="ml-0.5 leading-none hover:text-blue-900 dark:hover:text-blue-200">×</button>
              </span>
            ))}
            {getMonthParam() && (
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                {formatMonthYear(displayMonthYear)}
                <button onClick={() => removeParam('month')} aria-label="Remove month filter" className="ml-0.5 leading-none hover:text-blue-900 dark:hover:text-blue-200">×</button>
              </span>
            )}
            {getAccountParam() && (
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                {getAccountParam()!.split(',').map(id => accountMap.get(id)).filter(Boolean).join(', ')}
                <button onClick={() => removeParam('account')} aria-label="Remove account filter" className="ml-0.5 leading-none hover:text-blue-900 dark:hover:text-blue-200">×</button>
              </span>
            )}
            {getCatParam() && (
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                {getCatParam()}
                <button onClick={() => removeParam('cat')} aria-label="Remove category filter" className="ml-0.5 leading-none hover:text-blue-900 dark:hover:text-blue-200">×</button>
              </span>
            )}
            {getQParam() && (
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                &ldquo;{getQParam()}&rdquo;
                <button onClick={() => removeParam('q')} aria-label="Remove search filter" className="ml-0.5 leading-none hover:text-blue-900 dark:hover:text-blue-200">×</button>
              </span>
            )}
            {totalActiveFilters >= 2 && (
              <button onClick={clearFilters} className="text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300">
                Clear all
              </button>
            )}
          </>
        )}
      </div>

      {/* ================================================================ */}
      {/* Transaction List                                                 */}
      {/* ================================================================ */}

      {ctx.transactions.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            No data yet
          </p>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Import your Google Sheets data to get started.
          </p>
          <Link
            href="/settings"
            className="mt-3 inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Go to Settings → Import
          </Link>
        </div>
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
        <>
          {/* ---- Mobile: card layout ---- */}
          {grouped ? (
            <div className="lg:hidden">
              {grouped.map((group, gi) => (
                <div key={group.date}>
                  <div className={`mb-2 text-xs font-semibold text-zinc-500 dark:text-zinc-400${gi > 0 ? ' mt-4' : ''}`}>
                    {group.displayDate}
                  </div>
                  <div className="divide-y divide-zinc-100 dark:divide-zinc-700">
                    {group.txs.map(tx => (
                      <div
                        key={tx.id}
                        className="flex items-start gap-3 py-2.5 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/30"
                      >
                        <span className={`mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
                          tx.type === 'income' ? 'bg-emerald-500' : tx.type === 'expense' ? 'bg-red-500' : 'bg-blue-500'
                        }`} />

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                              {tx.category}
                            </span>
                            <div className="flex items-center gap-1 shrink-0">
                              <span className={`text-sm font-semibold tabular-nums ${
                                tx.type === 'income' ? 'text-emerald-700 dark:text-emerald-400' :
                                tx.type === 'expense' ? 'text-red-700 dark:text-red-400' :
                                'text-blue-700 dark:text-blue-400'
                              }`}>
                                {formatCurrency(tx.amount)}
                              </span>
                              <div className="relative">
                                <button onClick={() => setActionMenuId(actionMenuId === tx.id ? null : tx.id)}
                                  className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-zinc-300"
                                  aria-label="Transaction actions">
                                  <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                                    <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
                                  </svg>
                                </button>
                                {actionMenuId === tx.id && (
                                  <>
                                    <div className="fixed inset-0 z-10" onClick={() => setActionMenuId(null)} />
                                    <div className="absolute right-0 top-full z-20 mt-1 w-32 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-600 dark:bg-zinc-800">
                                      <button onClick={() => { setActionMenuId(null); handleEdit(tx); }}
                                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700">
                                        Edit
                                      </button>
                                      <button onClick={() => { setActionMenuId(null); handleDelete(tx.id); }}
                                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-600 hover:bg-zinc-100 dark:text-red-400 dark:hover:bg-zinc-700">
                                        Delete
                                      </button>
                                    </div>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                            {tx.type === 'income'
                              ? `→ ${accountMap.get(tx.toAccount ?? '') ?? tx.toAccount ?? ''}`
                              : tx.type === 'expense'
                                ? `${accountMap.get(tx.fromAccount ?? '') ?? tx.fromAccount ?? ''} →`
                                : `${accountMap.get(tx.fromAccount ?? '') ?? tx.fromAccount ?? ''} → ${accountMap.get(tx.toAccount ?? '') ?? tx.toAccount ?? ''}`}
                            <span className="mx-1">·</span>
                            {new Date(tx.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </div>

                          {tx.description && (
                            <div className="mt-0.5 truncate text-xs text-zinc-400 dark:text-zinc-500">
                              {tx.description}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="divide-y divide-zinc-100 dark:divide-zinc-700 lg:hidden">
              {pageTransactions.map((tx) => (
                <div
                  key={tx.id}
                  className="flex items-start gap-3 py-2.5 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/30"
                >
                  <span className={`mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
                    tx.type === 'income' ? 'bg-emerald-500' : tx.type === 'expense' ? 'bg-red-500' : 'bg-blue-500'
                  }`} />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {tx.category}
                      </span>
                      <div className="flex items-center gap-1 shrink-0">
                        <span className={`text-sm font-semibold tabular-nums ${
                          tx.type === 'income' ? 'text-emerald-700 dark:text-emerald-400' :
                          tx.type === 'expense' ? 'text-red-700 dark:text-red-400' :
                          'text-blue-700 dark:text-blue-400'
                        }`}>
                          {formatCurrency(tx.amount)}
                        </span>
                        <div className="relative">
                          <button onClick={() => setActionMenuId(actionMenuId === tx.id ? null : tx.id)}
                            className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-zinc-300"
                            aria-label="Transaction actions">
                            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                              <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
                            </svg>
                          </button>
                          {actionMenuId === tx.id && (
                            <>
                              <div className="fixed inset-0 z-10" onClick={() => setActionMenuId(null)} />
                              <div className="absolute right-0 top-full z-20 mt-1 w-32 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-600 dark:bg-zinc-800">
                                <button onClick={() => { setActionMenuId(null); handleEdit(tx); }}
                                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700">
                                  Edit
                                </button>
                                <button onClick={() => { setActionMenuId(null); handleDelete(tx.id); }}
                                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-600 hover:bg-zinc-100 dark:text-red-400 dark:hover:bg-zinc-700">
                                  Delete
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                      {tx.type === 'income'
                        ? `→ ${accountMap.get(tx.toAccount ?? '') ?? tx.toAccount ?? ''}`
                        : tx.type === 'expense'
                          ? `${accountMap.get(tx.fromAccount ?? '') ?? tx.fromAccount ?? ''} →`
                          : `${accountMap.get(tx.fromAccount ?? '') ?? tx.fromAccount ?? ''} → ${accountMap.get(tx.toAccount ?? '') ?? tx.toAccount ?? ''}`}
                      <span className="mx-1">·</span>
                      {new Date(tx.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </div>

                    {tx.description && (
                      <div className="mt-0.5 truncate text-xs text-zinc-400 dark:text-zinc-500">
                        {tx.description}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ---- Desktop: table layout ---- */}
          <table className="hidden lg:table w-full">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs font-medium uppercase text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                <th className="w-8 pb-2 pr-4" />
                <th className="pb-2 pr-4">Date</th>
                <th className="pb-2 pr-4">Description</th>
                <th className="pb-2 pr-4">Category</th>
                <th className="pb-2 pr-4">Account</th>
                <th className="pb-2 pl-4 text-right">Amount</th>
                <th className="w-20 pb-2 pl-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {grouped ? (
                grouped.flatMap((group) => [
                  <tr key={`hdr-${group.date}`} className="border-b border-zinc-100 dark:border-zinc-700">
                    <td colSpan={7} className="py-1.5 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                      {group.displayDate}
                    </td>
                  </tr>,
                    ...group.txs.map(tx => (
                    <tr key={tx.id} className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-700 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
                      <td className="py-2.5 pr-4">
                        <span className={`block h-2 w-2 rounded-full ${
                          tx.type === 'income' ? 'bg-emerald-500' : tx.type === 'expense' ? 'bg-red-500' : 'bg-blue-500'
                        }`} />
                      </td>
                      <td className="whitespace-nowrap py-2.5 pr-4 text-sm text-zinc-500 dark:text-zinc-400">
                        {new Date(tx.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </td>
                      <td className="py-2.5 pr-4 text-sm text-zinc-500 dark:text-zinc-400">
                        {tx.description || <span className="italic text-zinc-300 dark:text-zinc-600">No description</span>}
                      </td>
                      <td className="py-2.5 pr-4 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {tx.category}
                      </td>
                      <td className="whitespace-nowrap py-2.5 pr-4 text-sm text-zinc-500 dark:text-zinc-400">
                        {tx.type === 'income'
                          ? `→ ${accountMap.get(tx.toAccount ?? '') ?? tx.toAccount ?? ''}`
                          : tx.type === 'expense'
                            ? `${accountMap.get(tx.fromAccount ?? '') ?? tx.fromAccount ?? ''} →`
                            : `${accountMap.get(tx.fromAccount ?? '') ?? tx.fromAccount ?? ''} → ${accountMap.get(tx.toAccount ?? '') ?? tx.toAccount ?? ''}`}
                      </td>
                      <td className={`py-2.5 pl-4 text-right text-sm font-semibold tabular-nums ${
                        tx.type === 'income' ? 'text-emerald-700 dark:text-emerald-400' :
                        tx.type === 'expense' ? 'text-red-700 dark:text-red-400' :
                        'text-zinc-700 dark:text-zinc-300'
                      }`}>
                        {formatCurrency(tx.amount)}
                      </td>
                      <td className="whitespace-nowrap py-2.5 pl-4 text-right">
                        <button
                          onClick={() => handleEdit(tx)}
                          className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-blue-600 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-blue-400"
                          aria-label="Edit transaction"
                        >
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        <button
                          onClick={() => handleDelete(tx.id)}
                          className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-red-600 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-red-400"
                          aria-label="Delete transaction"
                        >
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                        {deletingId === tx.id && (
                          <span className="ml-1 inline-block h-3 w-3 animate-spin rounded-full border-2 border-zinc-300 border-t-transparent dark:border-zinc-600 dark:border-t-transparent" />
                        )}
                      </td>
                    </tr>
                  ))
                ])
              ) : (
                pageTransactions.map(tx => (
                  <tr key={tx.id} className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-700 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
                    <td className="py-2.5 pr-4">
                      <span className={`block h-2 w-2 rounded-full ${
                        tx.type === 'income' ? 'bg-emerald-500' : tx.type === 'expense' ? 'bg-red-500' : 'bg-blue-500'
                      }`} />
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-4 text-sm text-zinc-500 dark:text-zinc-400">
                      {new Date(tx.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    <td className="py-2.5 pr-4 text-sm text-zinc-500 dark:text-zinc-400">
                      {tx.description || <span className="italic text-zinc-300 dark:text-zinc-600">No description</span>}
                    </td>
                    <td className="py-2.5 pr-4 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {tx.category}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-4 text-sm text-zinc-500 dark:text-zinc-400">
                      {tx.type === 'income'
                        ? `→ ${accountMap.get(tx.toAccount ?? '') ?? tx.toAccount ?? ''}`
                        : tx.type === 'expense'
                          ? `${accountMap.get(tx.fromAccount ?? '') ?? tx.fromAccount ?? ''} →`
                          : `${accountMap.get(tx.fromAccount ?? '') ?? tx.fromAccount ?? ''} → ${accountMap.get(tx.toAccount ?? '') ?? tx.toAccount ?? ''}`}
                    </td>
                    <td className={`py-2.5 pl-4 text-right text-sm font-semibold tabular-nums ${
                      tx.type === 'income' ? 'text-emerald-700 dark:text-emerald-400' :
                      tx.type === 'expense' ? 'text-red-700 dark:text-red-400' :
                      'text-zinc-700 dark:text-zinc-300'
                    }`}>
                      {formatCurrency(tx.amount)}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pl-4 text-right">
                      <button
                        onClick={() => handleEdit(tx)}
                        className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-blue-600 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-blue-400"
                        aria-label="Edit transaction"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleDelete(tx.id)}
                        className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-red-600 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-red-400"
                        aria-label="Delete transaction"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                      {deletingId === tx.id && (
                        <span className="ml-1 inline-block h-3 w-3 animate-spin rounded-full border-2 border-zinc-300 border-t-transparent dark:border-zinc-600 dark:border-t-transparent" />
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </>
      )}

      {/* Table footer — counts + pagination */}
      <div className="flex items-center justify-between mt-4">
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          Showing {pageTransactions.length} of {ctx.transactions.length} transaction{ctx.transactions.length !== 1 ? 's' : ''}
        </span>
        {totalPages > 1 && (
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              Page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setParam('page', String(page - 1))}>
                Previous
              </Button>
              <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setParam('page', String(page + 1))}>
                Next
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Edit transaction modal */}
      <EditTransactionModal
        transaction={editingTx}
        onClose={() => setEditingTx(null)}
      />
    </div>
  );
}

// ============================================================
// Sub-components
// ============================================================

function FilterPills({
  monthParam, accountParam, catParam, qParam, displayMonthYear, accountMap,
  onRemoveMonth, onRemoveAccount, onRemoveCat, onRemoveQ,
}: {
  monthParam: string | null;
  accountParam: string | null;
  catParam: string | null;
  qParam: string | null;
  displayMonthYear: { year: number; month: number };
  accountMap: Map<string, string>;
  onRemoveMonth: () => void;
  onRemoveAccount: () => void;
  onRemoveCat: () => void;
  onRemoveQ: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {monthParam && (
        <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
          {formatMonthYear(displayMonthYear)}
          <button onClick={onRemoveMonth} aria-label="Remove month filter" className="ml-0.5 leading-none hover:text-blue-900 dark:hover:text-blue-200">×</button>
        </span>
      )}
      {accountParam && (
        <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
          {accountParam.split(',').map(id => accountMap.get(id)).filter(Boolean).join(', ')}
          <button onClick={onRemoveAccount} aria-label="Remove account filter" className="ml-0.5 leading-none hover:text-blue-900 dark:hover:text-blue-200">×</button>
        </span>
      )}
      {catParam && (
        <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
          {catParam}
          <button onClick={onRemoveCat} aria-label="Remove category filter" className="ml-0.5 leading-none hover:text-blue-900 dark:hover:text-blue-200">×</button>
        </span>
      )}
      {qParam && (
        <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
          &ldquo;{qParam}&rdquo;
          <button onClick={onRemoveQ} aria-label="Remove search filter" className="ml-0.5 leading-none hover:text-blue-900 dark:hover:text-blue-200">×</button>
        </span>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50">
      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className={`mt-1 text-base font-semibold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}
