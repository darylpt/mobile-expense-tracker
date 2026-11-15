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

import React, { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { getBalanceSnapshots, upsertBalanceSnapshot } from '@/lib/idb';
import Link from 'next/link';
import { useTransactionContext } from '@/context/TransactionContext';
import { useAuth } from '@/context/AuthContext';
import { getAuthGeneration } from '@/lib/auth-scope';
import { calculateExpectedBalances, type ExpectedBalanceRow } from '@/lib/reconciliation';
import { getToday, formatCurrency } from '@/lib/utils';
import { Header } from '@/components/layout/Header';
import { CashDenominationInput } from '@/components/available-balance/CashDenominationInput';

/** Account ID for Cash — special-cased for denomination input */
const CASH_ACCOUNT_ID = 'cash';

type BalanceSnapshotMap = Awaited<ReturnType<typeof getBalanceSnapshots>>;

/** Identity of one scope instance. Shape is irrelevant; only identity is. */
interface BalanceScopeToken {
  readonly kind: 'available-balance-scope';
}

interface BalanceScopeBucket {
  /** Auth descriptor this bucket belongs to. */
  readonly key: string;
  /** Unique per scope instance; never reused across transitions. */
  readonly token: BalanceScopeToken;
  readonly balances: BalanceSnapshotMap;
  readonly phase: 'locked' | 'loading' | 'ready';
}

/**
 * True only while work captured under `token`/`generation` is still live.
 * Async read, migration, and persistence continuations share this fence.
 */
function isScopeCurrent(
  token: BalanceScopeToken,
  generation: number,
  liveToken: BalanceScopeToken,
): boolean {
  return getAuthGeneration() === generation && liveToken === token;
}

export default function AvailableBalancePage() {
  const { transactions, accounts, isLoading, isScopeVerified } = useTransactionContext();
  const { state: authState, user, authGeneration = 0 } = useAuth();

  const userId = user?.id ?? '';
  // IndexedDB is readable only once the provider verified local ownership.
  // Disabled (no Supabase) mode is local-only, so verification alone owns it.
  const canReadLocalData =
    isScopeVerified &&
    (authState === 'disabled' ||
      (authState === 'authenticated' && userId !== ''));

  // Identity + ownership descriptor for this render. Generation advances on
  // every identity transition; the marker distinguishes verification flips.
  const scopeKey = `${authState}\u0000${userId}\u0000${authGeneration}\u0000${
    isScopeVerified ? 'verified' : 'locked'
  }`;

  // Persisted to IndexedDB so values sync across devices via Supabase.
  // Balances live in a bucket bound to one verified auth scope.
  const [bucketState, setBucketState] = useState<BalanceScopeBucket>(() => ({
    key: scopeKey,
    token: { kind: 'available-balance-scope' },
    balances: {},
    phase: canReadLocalData ? 'loading' : 'locked',
  }));

  // Descriptor change: reset during render and return the safe empty/locked
  // bucket for this very render. No previous-scope balance, timestamp or
  // sub-split is ever observable, even before the passive load effect runs.
  // A fresh token means old continuations cannot regain authority if the
  // descriptor later becomes equal again (A verified -> locked -> A verified).
  let bucket = bucketState;
  if (bucketState.key !== scopeKey) {
    bucket = {
      key: scopeKey,
      token: { kind: 'available-balance-scope' },
      balances: {},
      phase: canReadLocalData ? 'loading' : 'locked',
    };
    setBucketState(bucket);
  }
  const scopeToken = bucket.token;
  const currentBalances = bucket.balances;
  const phase = bucket.phase;

  // Latest committed scope token, readable from async continuations.
  const scopeTokenRef = useRef(scopeToken);
  useLayoutEffect(() => {
    scopeTokenRef.current = scopeToken;
  }, [scopeToken]);

  // A balance update applies only while its bucket is still the live one.
  const updateBucketBalances = useCallback(
    (
      token: BalanceScopeToken,
      updater: (balances: BalanceSnapshotMap) => BalanceSnapshotMap,
    ) => {
      setBucketState((previous) =>
        previous.token === token
          ? { ...previous, balances: updater(previous.balances) }
          : previous,
      );
    },
    [],
  );

  // One-time migration from localStorage + load from IDB for exactly this
  // scope. A result captured for one scope instance may never publish
  // balances or loading for another, nor remove the legacy key.
  useEffect(() => {
    if (!canReadLocalData) return;

    const token = scopeToken;
    const generation = authGeneration;
    let cancelled = false;
    const isCurrent = () =>
      !cancelled &&
      canReadLocalData &&
      isScopeCurrent(token, generation, scopeTokenRef.current);

    (async () => {
      // First, migrate any old localStorage data into IDB
      try {
        if (!isCurrent()) return;
        const saved = localStorage.getItem('current_balances');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (typeof parsed === 'object' && parsed !== null) {
            for (const [accountId, entry] of Object.entries(parsed) as [string, { value: number; updatedAt: number; useSubSplit?: boolean; subSplits?: { id: string; label: string; amount: number }[] }][]) {
              if (!isCurrent()) return;
              if (entry && typeof entry.value === 'number') {
                await upsertBalanceSnapshot(accountId, {
                  value: entry.value,
                  useSubSplit: entry.useSubSplit,
                  subSplits: entry.subSplits,
                });
                if (!isCurrent()) return;
              }
            }
          }
          // Clear localStorage after successful migration
          if (!isCurrent()) return;
          localStorage.removeItem('current_balances');
        }
      } catch {
        // migration failed, will try again next mount
      }

      // A caught migration failure must not bypass the fence before the read.
      if (!isCurrent()) return;

      // Load from IDB
      try {
        const loaded = await getBalanceSnapshots();
        if (!isCurrent()) return;
        setBucketState((previous) =>
          previous.token === token
            ? { ...previous, balances: loaded, phase: 'ready' }
            : previous,
        );
      } catch {
        if (!isCurrent()) return;
        setBucketState((previous) =>
          previous.token === token ? { ...previous, phase: 'ready' } : previous,
        );
      }
    })();

    return () => { cancelled = true; };
  }, [scopeToken, canReadLocalData, authGeneration]);

  // Persist to IDB on every change (for sync across devices). Only a ready,
  // still-authorized bucket may write, and each entry is fenced individually.
  useEffect(() => {
    if (phase !== 'ready' || !canReadLocalData) return; // don't write during initial load
    const token = scopeToken;
    const generation = authGeneration;
    const isCurrent = () =>
      canReadLocalData &&
      isScopeCurrent(token, generation, scopeTokenRef.current);

    if (!isCurrent()) return;
    // ponytail: upsert all — the overhead is tiny for < 10 accounts
    for (const [accountId, entry] of Object.entries(currentBalances)) {
      if (!isCurrent()) return;
      upsertBalanceSnapshot(accountId, {
        value: entry.value,
        useSubSplit: entry.useSubSplit,
        subSplits: entry.subSplits,
      }).catch(() => {}); // fire-and-forget, best-effort persistence
    }
  }, [phase, currentBalances, scopeToken, canReadLocalData, authGeneration]);

  const [cashUseDenominations, setCashUseDenominations] = useState(true);
  // ponytail: toggling plain→denomination mode abandons the plain-number value
  // (denomination grid re-mounts from IDB). Fix: write plain value back to IDB on toggle,
  // or pass it as initial value to the denomination grid.

  // Expected balances are derived from context rows only while the local cache
  // is authorized; retained rows during a locked transition are not ownership
  // proof and must not be turned into financial output.
  const expectedRows = useMemo<ExpectedBalanceRow[]>(
    () =>
      canReadLocalData
        ? calculateExpectedBalances(transactions, accounts, getToday())
        : [],
    [canReadLocalData, transactions, accounts]
  );

  // Shared generation rejects identity-stale callbacks before React rerenders;
  // the bucket token also rejects callbacks captured before verification flips.
  const handleCurrentChange = useCallback((accountId: string, value: string) => {
    if (!canReadLocalData || getAuthGeneration() !== authGeneration) {
      return;
    }
    const num = parseFloat(value);
    updateBucketBalances(scopeToken, (balances) => ({
      ...balances,
      [accountId]: { value: isNaN(num) ? 0 : num, updatedAt: Date.now() },
    }));
  }, [canReadLocalData, scopeToken, authGeneration, updateBucketBalances]);

  const handleCashTotalChange = useCallback((total: number) => {
    if (!canReadLocalData || getAuthGeneration() !== authGeneration) {
      return;
    }
    updateBucketBalances(scopeToken, (balances) => ({
      ...balances,
      [CASH_ACCOUNT_ID]: { value: total, updatedAt: Date.now() },
    }));
  }, [canReadLocalData, scopeToken, authGeneration, updateBucketBalances]);

  // ponytail: sub-split handlers — stable via useCallback, functional updater avoids closure deps
  const handleSubSplitToggle = useCallback((accountId: string) => {
    if (!canReadLocalData || getAuthGeneration() !== authGeneration) {
      return;
    }
    updateBucketBalances(scopeToken, (balances) => {
      const entry = balances[accountId];
      if (entry?.useSubSplit) {
        // Toggle OFF: keep last computed value, strip sub-split data
        const rest = { ...entry };
        delete rest.useSubSplit;
        delete rest.subSplits;
        return { ...balances, [accountId]: rest };
      }
      // Toggle ON: initialize with 3 empty rows, value will be recomputed
      return {
        ...balances,
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
  }, [canReadLocalData, scopeToken, authGeneration, updateBucketBalances]);

  const handleSubSplitChange = useCallback(
    (accountId: string, subId: string, field: 'label' | 'amount', value: string) => {
      if (!canReadLocalData || getAuthGeneration() !== authGeneration) {
        return;
      }
      updateBucketBalances(scopeToken, (balances) => {
        const entry = balances[accountId];
        if (!entry?.useSubSplit || !entry.subSplits) return balances;
        const newSubSplits = entry.subSplits.map((s) =>
          s.id === subId
            ? { ...s, [field]: field === 'amount' ? parseFloat(value) || 0 : value }
            : s
        );
        const sum = newSubSplits.reduce((a, s) => a + s.amount, 0);
        return {
          ...balances,
          [accountId]: { ...entry, subSplits: newSubSplits, value: sum, updatedAt: Date.now() },
        };
      });
    },
    [canReadLocalData, scopeToken, authGeneration, updateBucketBalances]
  );

  const handleAddSubSplit = useCallback((accountId: string) => {
    if (!canReadLocalData || getAuthGeneration() !== authGeneration) {
      return;
    }
    updateBucketBalances(scopeToken, (balances) => {
      const entry = balances[accountId];
      if (!entry?.useSubSplit) return balances;
      return {
        ...balances,
        [accountId]: {
          ...entry,
          subSplits: [...(entry.subSplits ?? []), { id: crypto.randomUUID(), label: '', amount: 0 }],
          updatedAt: Date.now(),
        },
      };
    });
  }, [canReadLocalData, scopeToken, authGeneration, updateBucketBalances]);

  const handleRemoveSubSplit = useCallback((accountId: string, subId: string) => {
    if (!canReadLocalData || getAuthGeneration() !== authGeneration) {
      return;
    }
    updateBucketBalances(scopeToken, (balances) => {
      const entry = balances[accountId];
      if (!entry?.useSubSplit || !entry.subSplits) return balances;
      const newSubSplits = entry.subSplits.filter((s) => s.id !== subId);
      const sum = newSubSplits.reduce((a, s) => a + s.amount, 0);
      return {
        ...balances,
        [accountId]: { ...entry, subSplits: newSubSplits, value: sum, updatedAt: Date.now() },
      };
    });
  }, [canReadLocalData, scopeToken, authGeneration, updateBucketBalances]);

  // While local access is unauthorized, reuse the existing non-financial
  // loading branch: header only, no account rows, amounts or child editors.
  if (isLoading || !canReadLocalData) {
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
        <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col items-center justify-center px-4 pb-20 pt-16 text-center sm:pb-0 sm:pt-16">
          <p className="text-base font-medium text-zinc-900 dark:text-zinc-100">
            No data yet
          </p>
          <p className="mt-2 max-w-md text-sm text-zinc-600 dark:text-zinc-400">
            Add at least one account in Settings to reconcile your balances. To import a Google
            Sheets export, open Settings and choose Data Tools (Import / Export Data on mobile),
            then Import from Google Sheets.
          </p>
          <Link
            href="/settings"
            className="mt-4 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Open Settings
          </Link>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <Header title="Available Balance" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-20 pt-6 sm:px-6 sm:pb-0 sm:pt-8">

        {/* Reconciliation table — desktop. Keyed by scope so no child editor
            instance (denomination input) survives an identity transition. */}
        <div key={`desktop-${scopeKey}`} className="hidden lg:block">
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
                                      <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
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
                                  <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
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
              <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                No accounts configured.
              </p>
            )}
          </div>
        </div>

        {/* Reconciliation cards — mobile. Keyed by scope for the same reason. */}
        <div key={`mobile-${scopeKey}`} className="space-y-3 lg:hidden">
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
                        <span className="block text-right text-[10px] text-zinc-500 dark:text-zinc-400">
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
                        <div className="text-right text-[10px] text-zinc-500 dark:text-zinc-400">
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
            <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
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
      <span className="pl-3 text-sm text-zinc-500 dark:text-zinc-400">₱</span>
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
      {subSplits.map((ss) => (
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
            <span className="pl-2 text-xs text-zinc-500 dark:text-zinc-400">₱</span>
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
        </div>
      ))}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onAddSubSplit}
          className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
        >
          + Add sub-split
        </button>
      </div>
    </div>
  );
}
