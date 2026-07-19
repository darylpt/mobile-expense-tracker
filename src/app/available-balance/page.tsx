// ============================================================
// Available Balance (Cash Reconciliation) screen
//
// Mirrors the "Available Balance" sheet tab — shows expected vs
// current balance per account as of today.
//
// This is a reconciliation tool only — no adjusting transactions
// are created.
// ============================================================

'use client';

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useTransactionContext } from '@/context/TransactionContext';
import { calculateExpectedBalances, type ExpectedBalanceRow } from '@/lib/reconciliation';
import { getToday, formatCurrency } from '@/lib/utils';
import { Header } from '@/components/layout/Header';
import { CashDenominationInput } from '@/components/available-balance/CashDenominationInput';

/** Account ID for Cash — special-cased for denomination input */
const CASH_ACCOUNT_ID = 'cash';

export default function AvailableBalancePage() {
  const { transactions, accounts, isLoading } = useTransactionContext();
  // Persisted to localStorage so values survive tab switches
  const [currentBalances, setCurrentBalances] = useState<Record<string, { value: number; updatedAt: number }>>(() => {
    try {
      const saved = localStorage.getItem('current_balances');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed === 'object' && parsed !== null) return parsed;
      }
    } catch {
      // corrupt data, start fresh
    }
    return {};
  });
  // Sync to localStorage on every change
  useEffect(() => {
    try {
      localStorage.setItem('current_balances', JSON.stringify(currentBalances));
    } catch {
      // storage full, silently fail
    }
  }, [currentBalances]);
  const [cashUseDenominations, setCashUseDenominations] = useState(true);
  // ponytail: toggling plain→denomination mode abandons the plain-number value
  // (denomination grid re-mounts from IDB). Fix: write plain value back to IDB on toggle,
  // or pass it as initial value to the denomination grid.

  const expectedRows = useMemo<ExpectedBalanceRow[]>(
    () => calculateExpectedBalances(transactions, accounts, getToday()),
    [transactions, accounts]
  );

  // ponytail: stable callbacks via useCallback — functional updater avoids closure deps
  const handleCurrentChange = useCallback((accountId: string, value: string) => {
    const num = parseFloat(value);
    setCurrentBalances((prev) => ({
      ...prev,
      [accountId]: { value: isNaN(num) ? 0 : num, updatedAt: Date.now() },
    }));
  }, []);

  const handleCashTotalChange = useCallback((total: number) => {
    setCurrentBalances((prev) => ({
      ...prev,
      [CASH_ACCOUNT_ID]: { value: total, updatedAt: Date.now() },
    }));
  }, []);

  if (isLoading) {
    return (
      <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
        <Header title="Available Balance" />
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-20 pt-6 sm:px-6 sm:pb-0 sm:pt-8">
          <LoadingSkeleton />
        </main>
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
        <Header title="Available Balance" />
        <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col items-center justify-center px-4 pb-20 pt-16 sm:pb-0 sm:pt-16">
          <p className="text-base font-medium text-zinc-900 dark:text-zinc-100">
            No data yet
          </p>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            Import your Google Sheets data to get started.
          </p>
          <Link
            href="/settings"
            className="mt-4 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Go to Settings → Import
          </Link>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <Header title="Available Balance" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-20 pt-6 sm:px-6 sm:pb-0 sm:pt-8">

        {/* Reconciliation table — desktop */}
        <div className="hidden lg:block">
          <div className="rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-xs uppercase text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                    <th className="py-3 pl-4 pr-4 font-medium sm:pl-6">Account</th>
                    <th className="py-3 px-2 text-right font-medium">Expected</th>
                    <th className="py-3 px-2 text-right font-medium">Current</th>
                    <th className="py-3 pr-4 pl-2 text-right font-medium sm:pr-6">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {expectedRows.map((row) => {
                    const current = currentBalances[row.accountId]?.value ?? 0;
                    const difference = row.expected - current;
                    const updatedAt = currentBalances[row.accountId]?.updatedAt;

                    return (
                      <tr
                        key={row.accountId}
                        className="border-b border-zinc-100 text-zinc-800 last:border-0 dark:border-zinc-800 dark:text-zinc-200"
                      >
                        <td className="py-3 pl-4 pr-4 font-medium sm:pl-6">
                          {row.accountName}
                        </td>
                        <td className="py-3 px-2 text-right tabular-nums">
                          {formatCurrency(row.expected)}
                        </td>
                        <td className="py-3 px-2 text-right">
                          {row.accountId === CASH_ACCOUNT_ID ? (
                            <div className="flex flex-col items-end gap-1">
                              {cashUseDenominations ? (
                                <CashDenominationInput
                                  date={getToday()}
                                  onTotalChange={handleCashTotalChange}
                                />
                              ) : (
                                <CurrencyInput
                                  value={current}
                                  onChange={(v) => handleCurrentChange(row.accountId, v)}
                                  ariaLabel="Current balance for Cash"
                                />
                              )}
                              {updatedAt && (
                                <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
                                  Updated: {new Date(updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                </span>
                              )}
                              <button
                                type="button"
                                onClick={() => setCashUseDenominations((v) => !v)}
                                className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                              >
                                {cashUseDenominations ? 'Enter total instead' : 'Use denominations'}
                              </button>
                            </div>
                          ) : (
                            <div className="flex flex-col items-end gap-0.5">
                              <CurrencyInput
                                value={current}
                                onChange={(v) => handleCurrentChange(row.accountId, v)}
                                ariaLabel={`Current balance for ${row.accountName}`}
                              />
                              {updatedAt && (
                                <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
                                  Updated: {new Date(updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td
                          className={`py-3 pr-4 pl-2 text-right tabular-nums font-medium sm:pr-6 ${
                            difference >= 0
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-red-700 dark:text-red-400'
                          }`}
                        >
                          {formatCurrency(Math.abs(difference))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {expectedRows.length === 0 && (
              <p className="py-8 text-center text-sm text-zinc-500">
                No accounts configured.
              </p>
            )}
          </div>
        </div>

        {/* Reconciliation cards — mobile */}
        <div className="space-y-3 lg:hidden">
          {expectedRows.map((row) => {
            const current = currentBalances[row.accountId]?.value ?? 0;
            const difference = row.expected - current;
            const updatedAt = currentBalances[row.accountId]?.updatedAt;

            return (
              <div
                key={row.accountId}
                className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50"
              >
                {/* Account name */}
                <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {row.accountName}
                </div>

                <div className="mt-3 space-y-1.5">
                  {/* Expected */}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-zinc-500 dark:text-zinc-400">Expected</span>
                    <span className="tabular-nums text-zinc-800 dark:text-zinc-200">
                      {formatCurrency(row.expected)}
                    </span>
                  </div>

                  {/* Current */}
                  {row.accountId === CASH_ACCOUNT_ID && cashUseDenominations ? (
                    <div className="space-y-2">
                      <div className="text-sm text-zinc-500 dark:text-zinc-400">Current</div>
                      <CashDenominationInput
                        date={getToday()}
                        onTotalChange={handleCashTotalChange}
                      />
                      {updatedAt && (
                        <span className="block text-right text-[10px] text-zinc-400 dark:text-zinc-500">
                          Updated: {new Date(updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => setCashUseDenominations((v) => !v)}
                        className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                      >
                        Enter total instead
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="shrink-0 text-zinc-500 dark:text-zinc-400">Current</span>
                        <div className="flex items-center gap-2">
                          <CurrencyInput
                            value={current}
                            onChange={(v) => handleCurrentChange(row.accountId, v)}
                            ariaLabel={`Current balance for ${row.accountName}`}
                          />
                          {row.accountId === CASH_ACCOUNT_ID && (
                            <button
                              type="button"
                              onClick={() => setCashUseDenominations((v) => !v)}
                              className="whitespace-nowrap text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                            >
                              Use denominations
                            </button>
                          )}
                        </div>
                      </div>
                      {updatedAt && (
                        <div className="text-right text-[10px] text-zinc-400 dark:text-zinc-500">
                          Updated: {new Date(updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </div>
                      )}
                    </>
                  )}

                  {/* Divider */}
                  <div className="border-t border-zinc-100 dark:border-zinc-700" />

                  {/* Difference */}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-zinc-500 dark:text-zinc-400">Difference</span>
                    <span
                      className={`tabular-nums font-medium ${
                        difference >= 0
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : 'text-red-700 dark:text-red-400'
                      }`}
                    >
                      {difference >= 0 ? '' : '-'}
                      {formatCurrency(Math.abs(difference))}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}

          {expectedRows.length === 0 && (
            <p className="py-8 text-center text-sm text-zinc-500">
              No accounts configured.
            </p>
          )}
        </div>

        {/* Footer note */}
        <p className="mt-4 text-center text-xs text-zinc-500 dark:text-zinc-400">
          This is a reconciliation tool. No adjusting transactions are created.
        </p>
      </main>
    </div>
  );
}

// ============================================================
// CurrencyInput — editable field with formatted display
// Shows ₱X,XXX.XX when blurred, raw number when focused.
// ============================================================

function CurrencyInput({ value, onChange, ariaLabel }: { value: number; onChange: (v: string) => void; ariaLabel: string }) {
  const [focused, setFocused] = useState(false);
  const display = focused ? (isNaN(value) ? '' : value.toString()) : formatCurrency(value);

  return (
    <input
      type="text"
      inputMode="decimal"
      value={display}
      onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      aria-label={ariaLabel}
      className="w-28 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-right text-sm text-zinc-900 transition-colors focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:focus:border-blue-400 dark:focus:ring-blue-400/20"
    />
  );
}

// ============================================================
// Loading skeleton
// ============================================================

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-8 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
        <div className="h-8 w-full animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="mt-3 h-6 w-full animate-pulse rounded bg-zinc-100 dark:bg-zinc-800"
          />
        ))}
      </div>
    </div>
  );
}
