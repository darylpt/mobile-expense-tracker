// ============================================================
// useStocks - Hook for managing stock tickers
// Fetches from IndexedDB and provides CRUD operations.
//
// State is bound to the auth scope it was produced for: auth state,
// user id, auth generation, and transaction-context verification. When
// that descriptor changes, the bucket is reset during render so the
// first render of the new scope can never expose the previous owner's
// data. Each bucket instance carries a unique token, so stale async work
// and retained callbacks stay inert even if a descriptor later becomes
// equal again (A verified -> locked -> A verified).
// ============================================================

'use client';

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import type { Stock } from '@/types';
import {
  getAllStocks,
  addStock as addStockToDB,
  updateStock as updateStockToDB,
  deleteStock as deleteStockFromDB,
  moveStockTo as moveStockToInDB,
} from '@/lib/idb';
import { getAuthGeneration } from '@/lib/auth-scope';
import { useAuth } from '@/context/AuthContext';
import { useTransactionContext } from '@/context/TransactionContext';

/** Identity of one scope instance. Shape is irrelevant; only identity is. */
interface StocksScopeToken {
  readonly kind: 'stocks-scope';
}

interface StocksBucket {
  /** Auth descriptor this bucket belongs to. */
  readonly key: string;
  /** Unique per scope instance; never reused across transitions. */
  readonly token: StocksScopeToken;
  readonly stocks: Stock[];
  readonly isLoading: boolean;
  readonly error: string | null;
}

/**
 * True only while work captured under `token`/`generation` is still the live
 * scope. Every async continuation and retained callback shares this fence.
 */
function isScopeCurrent(
  token: StocksScopeToken,
  generation: number,
  liveToken: StocksScopeToken,
): boolean {
  return getAuthGeneration() === generation && liveToken === token;
}

export function useStocks() {
  const { isScopeVerified } = useTransactionContext();
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

  const [bucketState, setBucketState] = useState<StocksBucket>(() => ({
    key: scopeKey,
    token: { kind: 'stocks-scope' },
    stocks: [],
    isLoading: canReadLocalData,
    error: null,
  }));

  // Descriptor change: reset during render and return the safe empty/locked
  // bucket for this very render. No previous-scope row, error or loading is
  // ever observable, even before the passive load effect runs. A fresh token
  // means old continuations cannot regain authority if the descriptor later
  // becomes equal again (A verified -> locked -> A verified).
  let bucket = bucketState;
  if (bucketState.key !== scopeKey) {
    bucket = {
      key: scopeKey,
      token: { kind: 'stocks-scope' },
      stocks: [],
      isLoading: canReadLocalData,
      error: null,
    };
    setBucketState(bucket);
  }
  const scopeToken = bucket.token;

  // Latest committed scope token, readable from async continuations. Declared
  // before the loading effect so it is always current when that effect starts.
  const scopeTokenRef = useRef(scopeToken);
  useLayoutEffect(() => {
    scopeTokenRef.current = scopeToken;
  }, [scopeToken]);

  // A publication is applied only while its bucket is still the live one.
  const updateBucket = useCallback(
    (
      token: StocksScopeToken,
      patch: Partial<Pick<StocksBucket, 'stocks' | 'isLoading' | 'error'>>,
    ) => {
      setBucketState((previous) =>
        previous.token === token ? { ...previous, ...patch } : previous,
      );
    },
    [],
  );

  // Initial load for exactly this scope. A result captured for one scope
  // instance may never publish rows, errors, or loading for another.
  useEffect(() => {
    if (!canReadLocalData) return;

    const token = scopeToken;
    const generation = authGeneration;
    let cancelled = false;
    const isCurrent = () =>
      !cancelled && isScopeCurrent(token, generation, scopeTokenRef.current);

    getAllStocks()
      .then((data) => {
        if (!isCurrent()) return;
        updateBucket(token, {
          stocks: data,
          isLoading: false,
          error: null,
        });
      })
      .catch((err) => {
        if (!isCurrent()) return;
        const message =
          err instanceof Error ? err.message : 'Failed to load stocks';
        updateBucket(token, { error: message, isLoading: false });
        console.error('[useStocks] Error loading stocks:', err);
      });

    return () => {
      cancelled = true;
    };
  }, [scopeToken, canReadLocalData, authGeneration, updateBucket]);

  const refresh = useCallback(async () => {
    const isCurrent = () =>
      isScopeCurrent(scopeToken, authGeneration, scopeTokenRef.current);

    // A saved callback from an older scope is inert: it must not read or
    // publish into the current scope.
    if (!canReadLocalData || !isCurrent()) return;

    try {
      updateBucket(scopeToken, { error: null });
      const data = await getAllStocks();
      if (!isCurrent()) return;
      updateBucket(scopeToken, { stocks: data, error: null });
    } catch (err) {
      if (!isCurrent()) return;
      const message =
        err instanceof Error ? err.message : 'Failed to load stocks';
      updateBucket(scopeToken, { error: message });
      console.error('[useStocks] Error loading stocks:', err);
    }
  }, [scopeToken, canReadLocalData, authGeneration, updateBucket]);

  const addStock = useCallback(
    async (
      stock: Omit<Stock, 'id' | 'createdAt' | 'updatedAt'>,
    ): Promise<string> => {
      const isCurrent = () =>
        isScopeCurrent(scopeToken, authGeneration, scopeTokenRef.current);
      try {
        if (!canReadLocalData || !isCurrent()) {
          throw new Error('Local data is locked to another account');
        }
        const id = await addStockToDB(stock);
        if (!isCurrent()) return id;
        await refresh();
        return id;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to add stock';
        if (isCurrent()) updateBucket(scopeToken, { error: message });
        throw new Error(message);
      }
    },
    [scopeToken, canReadLocalData, authGeneration, refresh, updateBucket],
  );

  const updateStock = useCallback(
    async (
      stock: Partial<Stock> & Pick<Stock, 'id'>,
    ): Promise<void> => {
      const isCurrent = () =>
        isScopeCurrent(scopeToken, authGeneration, scopeTokenRef.current);
      try {
        if (!canReadLocalData || !isCurrent()) {
          throw new Error('Local data is locked to another account');
        }
        await updateStockToDB(stock);
        if (!isCurrent()) return;
        await refresh();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to update stock';
        if (isCurrent()) updateBucket(scopeToken, { error: message });
        throw new Error(message);
      }
    },
    [scopeToken, canReadLocalData, authGeneration, refresh, updateBucket],
  );

  const deleteStock = useCallback(
    async (id: string): Promise<void> => {
      const isCurrent = () =>
        isScopeCurrent(scopeToken, authGeneration, scopeTokenRef.current);
      try {
        if (!canReadLocalData || !isCurrent()) {
          throw new Error('Local data is locked to another account');
        }
        await deleteStockFromDB(id);
        if (!isCurrent()) return;
        await refresh();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to delete stock';
        if (isCurrent()) updateBucket(scopeToken, { error: message });
        throw new Error(message);
      }
    },
    [scopeToken, canReadLocalData, authGeneration, refresh, updateBucket],
  );

  const moveStockTo = useCallback(
    async (id: string, targetIndex: number): Promise<void> => {
      const isCurrent = () =>
        isScopeCurrent(scopeToken, authGeneration, scopeTokenRef.current);
      try {
        if (!canReadLocalData || !isCurrent()) {
          throw new Error('Local data is locked to another account');
        }
        await moveStockToInDB(id, targetIndex);
        if (!isCurrent()) return;
        await refresh();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to reorder stocks';
        if (isCurrent()) updateBucket(scopeToken, { error: message });
      }
    },
    [scopeToken, canReadLocalData, authGeneration, refresh, updateBucket],
  );

  return {
    stocks: bucket.stocks,
    isLoading: bucket.isLoading,
    error: bucket.error,
    refreshStocks: refresh,
    addStock,
    updateStock,
    deleteStock,
    moveStockTo,
  };
}
