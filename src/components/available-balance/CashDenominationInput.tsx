// ============================================================
// CashDenominationInput - Enter cash counts per denomination
//
// Standard PHP denominations: ₱1000, ₱500, ₱200, ₱100, ₱50,
// ₱20, ₱10, ₱5, ₱1.
//
// Loads existing snapshot from IndexedDB for the given date,
// reports total via onTotalChange, and can save a new snapshot.
// ============================================================

'use client';

import React, { useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import { getAllCashDenominations, addCashDenomination, deleteCashDenominationsByDate } from '@/lib/idb';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/common/Button';
import { useTransactionContext } from '@/context/TransactionContext';
import { useAuth } from '@/context/AuthContext';
import { getAuthGeneration } from '@/lib/auth-scope';

/** Standard Philippine peso denominations */
const DENOMINATIONS = [1000, 500, 200, 100, 50, 20, 10, 5, 1];

/** Identity of one scope/date instance. Shape is irrelevant; only identity is. */
interface CashScopeToken {
  readonly kind: 'cash-denomination-scope';
}

interface CashScopeBucket {
  /** Scope + date descriptor this bucket belongs to. */
  readonly key: string;
  /** Unique per scope/date instance; never reused across transitions. */
  readonly token: CashScopeToken;
  readonly counts: Record<number, number>;
  readonly saving: boolean;
  readonly saved: boolean;
}

type CashScopePatch = Partial<
  Pick<CashScopeBucket, 'counts' | 'saving' | 'saved'>
>;

/**
 * True only while work captured under `token`/`generation` is still the live
 * scope. Loads and save continuations share this fence.
 */
function isScopeCurrent(
  token: CashScopeToken,
  generation: number,
  liveToken: CashScopeToken,
): boolean {
  return getAuthGeneration() === generation && liveToken === token;
}


interface CashDenominationInputProps {
  /** ISO date for the snapshot (the Date Check value) */
  date: string;
  /** Called whenever the computed total changes */
  onTotalChange?: (total: number) => void;
}

export function CashDenominationInput({ date, onTotalChange }: CashDenominationInputProps) {
  const { isScopeVerified } = useTransactionContext();
  const { state: authState, user, authGeneration = 0 } = useAuth();

  const userId = user?.id ?? '';
  // IndexedDB is readable only once the provider verified local ownership.
  // Disabled (no Supabase) mode is local-only, so verification alone owns it.
  const canReadLocalData =
    isScopeVerified &&
    (authState === 'disabled' ||
      (authState === 'authenticated' && userId !== ''));

  // Identity + ownership + date descriptor for this render.
  const scopeKey = `${authState}\u0000${userId}\u0000${authGeneration}\u0000${
    isScopeVerified ? 'verified' : 'locked'
  }\u0000${date}`;

  const [bucketState, setBucketState] = useState<CashScopeBucket>(() => ({
    key: scopeKey,
    token: { kind: 'cash-denomination-scope' },
    counts: {},
    saving: false,
    saved: false,
  }));

  // Descriptor change: reset during render and return zeroed/locked state for
  // this very render. A fresh token per transition (including D1 -> D2 -> D1)
  // keeps old loads and saves inert even when the descriptor repeats.
  let bucket = bucketState;
  if (bucketState.key !== scopeKey) {
    bucket = {
      key: scopeKey,
      token: { kind: 'cash-denomination-scope' },
      counts: {},
      saving: false,
      saved: false,
    };
    setBucketState(bucket);
  }
  const scopeToken = bucket.token;
  const counts = bucket.counts;
  const saving = bucket.saving;
  const saved = bucket.saved;

  // Latest committed scope token, readable from async continuations.
  const scopeTokenRef = useRef(scopeToken);
  useLayoutEffect(() => {
    scopeTokenRef.current = scopeToken;
  }, [scopeToken]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // A publication is applied only while its bucket is still the live one.
  const updateBucket = useCallback(
    (token: CashScopeToken, patch: CashScopePatch) => {
      setBucketState((previous) =>
        previous.token === token ? { ...previous, ...patch } : previous,
      );
    },
    [],
  );

  // ponytail: ref keeps the callback fresh without triggering effect re-runs
  const onTotalChangeRef = useRef(onTotalChange);
  useEffect(() => {
    onTotalChangeRef.current = onTotalChange;
  }, [onTotalChange]);

  // Load existing denominations for this date on mount / date change. No read
  // starts while the scope is locked, and a result captured for one scope/date
  // instance may never publish counts for another.
  useEffect(() => {
    if (!canReadLocalData) return;

    const token = scopeToken;
    const generation = authGeneration;
    let cancelled = false;
    const isCurrent = () =>
      !cancelled &&
      mountedRef.current &&
      isScopeCurrent(token, generation, scopeTokenRef.current);

    getAllCashDenominations()
      .then((records) => {
        if (!isCurrent()) return;
        const filtered = records.filter((r) => r.date === date);
        const loaded: Record<number, number> = {};
        // Later saves overwrite earlier ones (most recent snapshot wins)
        for (const r of filtered) {
          loaded[r.denomination] = r.count;
        }
        updateBucket(token, { counts: { ...loaded } });
      })
      .catch(() => {
        // A failed read leaves the zeroed bucket in place.
      });

    return () => {
      cancelled = true;
    };
  }, [date, canReadLocalData, scopeToken, authGeneration, updateBucket]);

  const total = DENOMINATIONS.reduce((sum, d) => sum + d * (counts[d] ?? 0), 0);

  // ponytail: onTotalChange intentionally omitted — ref keeps it current.
  // A locked render reports nothing, so a parent never receives the previous
  // owner's total.
  useEffect(() => {
    if (!canReadLocalData) return;
    onTotalChangeRef.current?.(total);
  }, [total, canReadLocalData]);

  const handleCountChange = useCallback((denomination: number, value: string) => {
    if (!canReadLocalData) return;
    const token = scopeToken;
    const generation = authGeneration;
    if (!mountedRef.current || !isScopeCurrent(token, generation, scopeTokenRef.current)) {
      return;
    }
    const count = Math.max(0, parseInt(value, 10) || 0);
    setBucketState((previous) =>
      previous.token === token
        ? {
            ...previous,
            counts: { ...previous.counts, [denomination]: count },
            saved: false,
          }
        : previous,
    );
  }, [canReadLocalData, scopeToken, authGeneration]);

  const handleSave = async () => {
    if (!canReadLocalData) return;

    const token = scopeToken;
    const generation = authGeneration;
    const saveDate = date;
    const countsSnapshot = counts;
    const isCurrent = () =>
      mountedRef.current &&
      isScopeCurrent(token, generation, scopeTokenRef.current);
    if (!isCurrent()) return;

    updateBucket(token, { saving: true });
    try {
      // ponytail: cleared existing records for this date before save to prevent duplicates
      await deleteCashDenominationsByDate(saveDate);
      if (!isCurrent()) return;
      for (const [denomination, count] of Object.entries(countsSnapshot)) {
        if (!isCurrent()) return;
        if (count > 0) {
          await addCashDenomination({
            date: saveDate,
            denomination: Number(denomination),
            count,
          });
        }
      }
      if (!isCurrent()) return;
      updateBucket(token, { saved: true });
    } finally {
      if (isCurrent()) updateBucket(token, { saving: false });
    }
  };


  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        {DENOMINATIONS.map((denom) => (
          <div key={denom} className="flex items-center justify-between gap-3">
            <label htmlFor={`denom-${denom}`} className="w-20 text-sm font-medium text-zinc-700 dark:text-zinc-300">
              ₱{denom.toLocaleString()}
            </label>
            <input
              id={`denom-${denom}`}
              type="number"
              min={0}
              step={1}
              value={counts[denom] ?? 0}
              onChange={(e) => handleCountChange(denom, e.target.value)}
              disabled={!canReadLocalData}
              className="w-24 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-right text-sm text-zinc-900 transition-colors focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:focus:border-blue-400 dark:focus:ring-blue-400/20"
            />
          </div>
        ))}
      </div>

      {/* Running total */}
      <div className="flex items-center justify-between rounded-lg bg-blue-50 px-3 py-2 dark:bg-blue-900/20">
        <span className="text-sm font-medium text-blue-700 dark:text-blue-400">Total</span>
        <span className="text-base font-bold text-blue-800 dark:text-blue-300">
          {formatCurrency(total)}
        </span>
      </div>

      {/* Save button */}
      <Button
        variant="secondary"
        size="sm"
        onClick={handleSave}
        isLoading={saving}
        disabled={!canReadLocalData}
        className="w-full"
      >
        {saved ? 'Saved!' : 'Save Snapshot'}
      </Button>
    </div>
  );
}
