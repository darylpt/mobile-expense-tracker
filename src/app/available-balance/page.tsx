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
import { getBalanceSnapshots, upsertBalanceSnapshot } from '@/lib/idb';
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
  // Persisted to IndexedDB so values sync across devices via Supabase
  const [currentBalances, setCurrentBalances] = useState<Record<string, { value: number; updatedAt: number; useSubSplit?: boolean; subSplits?: { id: string; label: string; amount: number }[] }>>(() => {
    // Will be populated in useEffect below
    return {};
  });
  const [loaded, setLoaded] = useState(false);

  // One-time migration from localStorage + load from IDB
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // First, migrate any old localStorage data into IDB
      try {
        const saved = localStorage.getItem('current_balances');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (typeof parsed === 'object' && parsed !== null) {
            for (const [accountId, entry] of Object.entries(parsed) as [string, { value: number; updatedAt: number; useSubSplit?: boolean; subSplits?: { id: string; label: string; amount: number }[] }][]) {
              if (entry && typeof entry.value === 'number') {
                await upsertBalanceSnapshot(accountId, {
                  value: entry.value,
                  useSubSplit: entry.useSubSplit,
                  subSplits: entry.subSplits,
                });
              }
            }
          }
          // Clear localStorage after successful migration
          localStorage.removeItem('current_balances');
        }
      } catch {
        // migration failed, will try again next mount
      }

      // Load from IDB
      try {
        const loaded = await getBalanceSnapshots();
        if (!cancelled) {
          setCurrentBalances(loaded);
          setLoaded(true);
        }
      } catch {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Persist to IDB on every change (for sync across devices)
  useEffect(() => {
    if (!loaded) return; // don't write during initial load
    // ponytail: upsert all — the overhead is tiny for < 10 accounts
    for (const [accountId, entry] of Object.entries(currentBalances)) {
      upsertBalanceSnapshot(accountId, {
        value: entry.value,
        useSubSplit: entry.useSubSplit,
        subSplits: entry.subSplits,
      }).catch(() => {}); // fire-and-forget, best-effort persistence
    }
  }, [currentBalances, loaded]);
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

  // ponytail: sub-split handlers — stable via useCallback, functional updater avoids closure deps
  const handleSubSplitToggle = useCallback((accountId: string) => {
    setCurrentBalances((prev) => {
      const entry = prev[accountId];
      if (entry?.useSubSplit) {
        // Toggle OFF: keep last computed value, strip sub-split data
        const { useSubSplit, subSplits, ...rest } = entry;
        return { ...prev, [accountId]: rest };
      }
      // Toggle ON: initialize with 3 empty rows, value will be recomputed
      return {
        ...prev,
        [accountId]: {
          ...(entry ?? { value: 0, updatedAt: Date.now() }),
          value: 0,
          updatedAt: Date.now(),
          useSubSplit: true,
          subSplits: [
            { id: crypto.randomUUID(), label: '', amount: 0 },
            { id: crypto.randomUUID(), label: '', amount: 0 },
            { id: crypto.randomUUID(), label: '', amount: 0 },
          ],
        },
      };
    });
  }, []);

  const handleSubSplitChange = useCallback(
    (accountId: string, subId: string, field: 'label' | 'amount', value: string) => {
      setCurrentBalances((prev) => {
        const entry = prev[accountId];
        if (!entry?.useSubSplit || !entry.subSplits) return prev;
        const newSubSplits = entry.subSplits.map((s) =>
          s.id === subId
            ? { ...s, [field]: field === 'amount' ? parseFloat(value) || 0 : value }
            : s
        );
        const sum = newSubSplits.reduce((a, s) => a + s.amount, 0);
        return {
          ...prev,
          [accountId]: { ...entry, subSplits: newSubSplits, value: sum, updatedAt: Date.now() },
        };
      });
    },
    []
  );

  const handleAddSubSplit = useCallback((accountId: string) => {
    setCurrentBalances((prev) => {
      const entry = prev[accountId];
      if (!entry?.useSubSplit) return prev;
      return {
        ...prev,
        [accountId]: {
          ...entry,
          subSplits: [...(entry.subSplits ?? []), { id: crypto.randomUUID(), label: '', amount: 0 }],
          updatedAt: Date.now(),
        },
      };
    });
  }, []);

  const handleRemoveSubSplit = useCallback((accountId: string, subId: string) => {
    setCurrentBalances((prev) => {
      const entry = prev[accountId];
      if (!entry?.useSubSplit || !entry.subSplits) return prev;
      const newSubSplits = entry.subSplits.filter((s) => s.id !== subId);
      const sum = newSubSplits.reduce((a, s) => a + s.amount, 0);
      return {
        ...prev,
        [accountId]: { ...entry, subSplits: newSubSplits, value: sum, updatedAt: Date.now() },
      };
    });
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
                              ) : (() => {
                                const cashEntry = currentBalances[row.accountId];
                                const cashIsSubSplit = cashEntry?.useSubSplit;
                                return (
                                  <>
                                    <div className="flex items-center gap-2">
                                      {cashIsSubSplit ? (
                                        <span className="tabular-nums font-medium text-zinc-900 dark:text-zinc-100">
                                          {formatCurrency(cashEntry!.value)}
                                        </span>
                                      ) : (
                                        <CurrencyInput
                                          value={current}
                                          onChange={(v) => handleCurrentChange(row.accountId, v)}
                                          ariaLabel="Current balance for Cash"
                                        />
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => handleSubSplitToggle(row.accountId)}
                                        className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
                                          cashIsSubSplit
                                            ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                                            : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-300'
                                        }`}
                                        aria-label={cashIsSubSplit ? 'Disable sub-split' : 'Enable sub-split'}
                                      >
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                                          <path d="M3.196 12.87l-.825.483a.75.75 0 000 1.294l7.25 4.25a.75.75 0 00.758 0l7.25-4.25a.75.75 0 000-1.294l-.825-.484-5.666 3.322a2.25 2.25 0 01-2.276 0L3.196 12.87z" />
                                          <path d="M3.196 8.87l-.825.483a.75.75 0 000 1.294l7.25 4.25a.75.75 0 00.758 0l7.25-4.25a.75.75 0 000-1.294l-.825-.484-5.666 3.322a2.25 2.25 0 01-2.276 0L3.196 8.87z" />
                                          <path d="M10.38 1.103a.75.75 0 00-.76 0l-7.25 4.25a.75.75 0 000 1.294l7.25 4.25a.75.75 0 00.76 0l7.25-4.25a.75.75 0 000-1.294l-7.25-4.25z" />
                                        </svg>
                                      </button>
                                    </div>
                                    {cashIsSubSplit && (
                                      <SubSplitEditor
                                        subSplits={cashEntry!.subSplits!}
                                        onSubSplitChange={(subId, field, val) =>
                                          handleSubSplitChange(row.accountId, subId, field, val)
                                        }
                                        onAddSubSplit={() => handleAddSubSplit(row.accountId)}
                                        onRemoveSubSplit={(subId) => handleRemoveSubSplit(row.accountId, subId)}
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
                                  </>
                                );
                              })()}
                            </div>
                          ) : (() => {
                            const ncEntry = currentBalances[row.accountId];
                            const ncIsSubSplit = ncEntry?.useSubSplit;
                            return (
                              <div className="flex flex-col items-end gap-0.5">
                                <div className="flex items-center gap-2">
                                  {ncIsSubSplit ? (
                                    <span className="tabular-nums font-medium text-zinc-900 dark:text-zinc-100">
                                      {formatCurrency(ncEntry!.value)}
                                    </span>
                                  ) : (
                                    <CurrencyInput
                                      value={current}
                                      onChange={(v) => handleCurrentChange(row.accountId, v)}
                                      ariaLabel={`Current balance for ${row.accountName}`}
                                    />
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => handleSubSplitToggle(row.accountId)}
                                    className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
                                      ncIsSubSplit
                                        ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                                        : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-300'
                                    }`}
                                    aria-label={ncIsSubSplit ? 'Disable sub-split' : 'Enable sub-split'}
                                  >
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                                      <path d="M3.196 12.87l-.825.483a.75.75 0 000 1.294l7.25 4.25a.75.75 0 00.758 0l7.25-4.25a.75.75 0 000-1.294l-.825-.484-5.666 3.322a2.25 2.25 0 01-2.276 0L3.196 12.87z" />
                                      <path d="M3.196 8.87l-.825.483a.75.75 0 000 1.294l7.25 4.25a.75.75 0 00.758 0l7.25-4.25a.75.75 0 000-1.294l-.825-.484-5.666 3.322a2.25 2.25 0 01-2.276 0L3.196 8.87z" />
                                      <path d="M10.38 1.103a.75.75 0 00-.76 0l-7.25 4.25a.75.75 0 000 1.294l7.25 4.25a.75.75 0 00.76 0l7.25-4.25a.75.75 0 000-1.294l-7.25-4.25z" />
                                    </svg>
                                  </button>
                                </div>
                                {ncIsSubSplit && (
                                  <SubSplitEditor
                                    subSplits={ncEntry!.subSplits!}
                                    onSubSplitChange={(subId, field, val) =>
                                      handleSubSplitChange(row.accountId, subId, field, val)
                                    }
                                    onAddSubSplit={() => handleAddSubSplit(row.accountId)}
                                    onRemoveSubSplit={(subId) => handleRemoveSubSplit(row.accountId, subId)}
                                  />
                                )}
                                {updatedAt && (
                                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
                                    Updated: {new Date(updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                  </span>
                                )}
                              </div>
                            );
                          })()}
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
                          {(() => {
                            const mEntry = currentBalances[row.accountId];
                            const mIsSubSplit = mEntry?.useSubSplit;
                            return mIsSubSplit ? (
                              <span className="tabular-nums font-medium text-zinc-900 dark:text-zinc-100">
                                {formatCurrency(mEntry!.value)}
                              </span>
                            ) : (
                              <CurrencyInput
                                value={current}
                                onChange={(v) => handleCurrentChange(row.accountId, v)}
                                ariaLabel={`Current balance for ${row.accountName}`}
                              />
                            );
                          })()}
                          <button
                            type="button"
                            onClick={() => handleSubSplitToggle(row.accountId)}
                            className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
                              currentBalances[row.accountId]?.useSubSplit
                                ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                                : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-300'
                            }`}
                            aria-label={
                              currentBalances[row.accountId]?.useSubSplit ? 'Disable sub-split' : 'Enable sub-split'
                            }
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                              <path d="M3.196 12.87l-.825.483a.75.75 0 000 1.294l7.25 4.25a.75.75 0 00.758 0l7.25-4.25a.75.75 0 000-1.294l-.825-.484-5.666 3.322a2.25 2.25 0 01-2.276 0L3.196 12.87z" />
                              <path d="M3.196 8.87l-.825.483a.75.75 0 000 1.294l7.25 4.25a.75.75 0 00.758 0l7.25-4.25a.75.75 0 000-1.294l-.825-.484-5.666 3.322a2.25 2.25 0 01-2.276 0L3.196 8.87z" />
                              <path d="M10.38 1.103a.75.75 0 00-.76 0l-7.25 4.25a.75.75 0 000 1.294l7.25 4.25a.75.75 0 00.76 0l7.25-4.25a.75.75 0 000-1.294l-7.25-4.25z" />
                            </svg>
                          </button>
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
                      {currentBalances[row.accountId]?.useSubSplit && (
                        <div className="mt-1.5">
                          <SubSplitEditor
                            subSplits={currentBalances[row.accountId]!.subSplits!}
                            onSubSplitChange={(subId, field, val) =>
                              handleSubSplitChange(row.accountId, subId, field, val)
                            }
                            onAddSubSplit={() => handleAddSubSplit(row.accountId)}
                            onRemoveSubSplit={(subId) => handleRemoveSubSplit(row.accountId, subId)}
                          />
                        </div>
                      )}
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
// CurrencyInput — number input with ₱ prefix (matches Add Transaction modal)
// ============================================================

function CurrencyInput({ value, onChange, ariaLabel }: { value: number; onChange: (v: string) => void; ariaLabel: string }) {
  return (
    <div className="flex items-center rounded-lg border border-zinc-300 bg-white transition-colors focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20 dark:border-zinc-600 dark:bg-zinc-800 dark:focus-within:border-blue-400 dark:focus-within:ring-blue-400/20">
      <span className="pl-3 text-sm text-zinc-400 dark:text-zinc-500">₱</span>
      <input
        type="number"
        step="any"
        min="0"
        placeholder="0.00"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        className="w-24 bg-transparent px-2 py-1.5 text-right text-sm text-zinc-900 outline-none dark:text-zinc-100"
      />
    </div>
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

// ============================================================
// SubSplitEditor — inline editor for sub-split rows
// ============================================================

function SubSplitEditor({
  subSplits,
  onSubSplitChange,
  onAddSubSplit,
  onRemoveSubSplit,
}: {
  subSplits: { id: string; label: string; amount: number }[];
  onSubSplitChange: (subId: string, field: 'label' | 'amount', value: string) => void;
  onAddSubSplit: () => void;
  onRemoveSubSplit: (subId: string) => void;
}) {
  return (
    <div className="mt-2 space-y-1.5">
      {subSplits.map((ss, i) => (
        <div key={ss.id} className="flex items-center justify-end gap-1.5">
          <input
            type="text"
            placeholder="Label"
            aria-label="Sub-split label"
            value={ss.label}
            onChange={(e) => onSubSplitChange(ss.id, 'label', e.target.value)}
            className="w-20 rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:focus:border-blue-400"
          />
          <div className="flex items-center rounded-lg border border-zinc-300 bg-white transition-colors focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20 dark:border-zinc-600 dark:bg-zinc-800 dark:focus-within:border-blue-400 dark:focus-within:ring-blue-400/20">
            <span className="pl-2 text-xs text-zinc-400 dark:text-zinc-500">₱</span>
            <input
              type="number"
              step="any"
              min="0"
              placeholder="0.00"
              aria-label="Sub-split amount"
              value={ss.amount || ''}
              onChange={(e) => onSubSplitChange(ss.id, 'amount', e.target.value)}
              className="w-16 bg-transparent px-1.5 py-1 text-right text-xs text-zinc-900 outline-none dark:text-zinc-100"
            />
          </div>
          <button
            type="button"
            onClick={() => onRemoveSubSplit(ss.id)}
            className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
            aria-label="Remove sub-split"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
          {i === subSplits.length - 1 && (
            <button
              type="button"
              onClick={onAddSubSplit}
              className="flex h-5 w-5 items-center justify-center rounded text-blue-500 hover:bg-blue-50 hover:text-blue-700 dark:text-blue-400 dark:hover:bg-blue-900/20 dark:hover:text-blue-300"
              aria-label="Add sub-split"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
              </svg>
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
