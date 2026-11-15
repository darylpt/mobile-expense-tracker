// ============================================================
// useAccounts - Hook for managing accounts
// Fetches from IndexedDB and provides CRUD operations.
//
// State is bound to the auth scope it was produced for: auth state,
// user id, auth generation, and transaction-context verification. When
// that key changes, the bucket is reset during render so the first
// render of the new scope can never expose the previous owner's data.
// Async work captures the key and generation it started under and may
// not publish rows, errors, or start further reads once they no longer
// match.
// ============================================================

'use client';

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import type { Account } from '@/types';
import {
  getAllAccounts,
  addAccount as addAccountToDB,
  updateAccount as updateAccountToDB,
  deleteAccount as deleteAccountFromDB,
  moveAccountTo as moveAccountToInDB,
} from '@/lib/idb';

import { getAuthGeneration } from '@/lib/auth-scope';
import { useAuth } from '@/context/AuthContext';
import { useTransactionContext } from '@/context/TransactionContext';

/** Identity of one scope instance. Shape is irrelevant; only identity is. */
interface AccountsScopeToken {
  readonly kind: 'accounts-scope';
}

interface AccountsBucket {
  /** Auth descriptor this bucket belongs to. */
  readonly key: string;
  /** Unique per scope instance; never reused across transitions. */
  readonly token: AccountsScopeToken;
  readonly accounts: Account[];
  readonly isLoading: boolean;
  readonly error: string | null;
}

/**
 * True only while work captured under `token`/`generation` is still the live
 * scope. Every async continuation and read path shares this fence.
 */
function isScopeCurrent(
  token: AccountsScopeToken,
  generation: number,
  liveToken: AccountsScopeToken,
): boolean {
  return getAuthGeneration() === generation && liveToken === token;
}

export function useAccounts() {
  const { refreshTransactions, isScopeVerified } = useTransactionContext();
  const { state: authState, user, authGeneration = 0 } = useAuth();

  const userId = user?.id ?? '';
  // IndexedDB is readable only once the provider verified local ownership.
  // Disabled (no Supabase) mode is local-only, so verification alone owns it.
  const canReadLocalData =
    isScopeVerified &&
    (authState === 'disabled' ||
      (authState === 'authenticated' && userId !== ''));

  // Identity + ownership key for this render. Generation advances on every
  // identity transition; the marker distinguishes verification flips.
  const scopeKey = `${authState}\u0000${userId}\u0000${authGeneration}\u0000${
    isScopeVerified ? 'verified' : 'locked'
  }`;

  const [bucketState, setBucketState] = useState<AccountsBucket>(() => ({
    key: scopeKey,
    token: { kind: 'accounts-scope' },
    accounts: [],
    isLoading: canReadLocalData,
    error: null,
  }));

  // Scope-key change: reset during render and return the safe empty/locked
  // bucket for this very render. A fresh token prevents stale work regaining
  // authority if verification later restores the same descriptor.
  let bucket = bucketState;
  if (bucketState.key !== scopeKey) {
    bucket = {
      key: scopeKey,
      token: { kind: 'accounts-scope' },
      accounts: [],
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
      token: AccountsScopeToken,
      patch: Partial<Pick<AccountsBucket, 'accounts' | 'isLoading' | 'error'>>,
    ) => {
      setBucketState((previous) =>
        previous.token === token ? { ...previous, ...patch } : previous,
      );
    },
    [],
  );

  // Initial load for exactly this scope instance. A result captured for one
  // scope may never publish rows, errors, or loading into another.
  useEffect(() => {
    if (!canReadLocalData) return;

    const token = scopeToken;
    const generation = authGeneration;
    let cancelled = false;
    const isCurrent = () =>
      !cancelled &&
      isScopeCurrent(token, generation, scopeTokenRef.current);

    getAllAccounts()
      .then((data) => {
        if (!isCurrent()) return;
        updateBucket(token, { accounts: data, isLoading: false, error: null });
      })
      .catch((err) => {
        if (!isCurrent()) return;
        const message =
          err instanceof Error ? err.message : 'Failed to load accounts';
        updateBucket(token, { error: message, isLoading: false });
        console.error('[useAccounts] Error loading accounts:', err);
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
      const data = await getAllAccounts();
      if (!isCurrent()) return;
      updateBucket(scopeToken, { accounts: data, isLoading: false, error: null });
    } catch (err) {
      if (!isCurrent()) return;
      const message =
        err instanceof Error ? err.message : 'Failed to load accounts';
      updateBucket(scopeToken, { error: message });
      console.error('[useAccounts] Error loading accounts:', err);
    }
  }, [scopeToken, canReadLocalData, authGeneration, updateBucket]);

  const addAccount = useCallback(
    async (
      account: Omit<Account, 'id' | 'createdAt' | 'updatedAt'>,
    ): Promise<string> => {
      const generation = authGeneration;
      const isCurrent = () =>
        isScopeCurrent(scopeToken, generation, scopeTokenRef.current);
      try {
        if (!canReadLocalData || !isCurrent()) {
          throw new Error('Local data is locked to another account');
        }
        // Admission is scope-gated; an IndexedDB write already started may
        // finish after revocation, but its later publications are fenced.
        const id = await addAccountToDB(account);
        if (!isCurrent()) return id;
        await refresh();
        if (!isCurrent()) return id;
        await refreshTransactions();
        return id;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to add account';
        if (isCurrent()) updateBucket(scopeToken, { error: message });
        throw new Error(message);
      }
    },
    [
      scopeToken,
      canReadLocalData,
      authGeneration,
      refresh,
      refreshTransactions,
      updateBucket,
    ],
  );

  const updateAccount = useCallback(
    async (
      account: Partial<Account> & Pick<Account, 'id'>,
    ): Promise<void> => {
      const generation = authGeneration;
      const isCurrent = () =>
        isScopeCurrent(scopeToken, generation, scopeTokenRef.current);
      try {
        if (!canReadLocalData || !isCurrent()) {
          throw new Error('Local data is locked to another account');
        }
        await updateAccountToDB(account);
        if (!isCurrent()) return;
        await refresh();
        if (!isCurrent()) return;
        await refreshTransactions();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to update account';
        if (isCurrent()) updateBucket(scopeToken, { error: message });
        throw new Error(message);
      }
    },
    [
      scopeToken,
      canReadLocalData,
      authGeneration,
      refresh,
      refreshTransactions,
      updateBucket,
    ],
  );

  const deleteAccount = useCallback(
    async (id: string): Promise<void> => {
      const generation = authGeneration;
      const isCurrent = () =>
        isScopeCurrent(scopeToken, generation, scopeTokenRef.current);
      try {
        if (!canReadLocalData || !isCurrent()) {
          throw new Error('Local data is locked to another account');
        }
        await deleteAccountFromDB(id);
        if (!isCurrent()) return;
        await refresh();
        if (!isCurrent()) return;
        await refreshTransactions();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to delete account';
        if (isCurrent()) updateBucket(scopeToken, { error: message });
        throw new Error(message);
      }
    },
    [
      scopeToken,
      canReadLocalData,
      authGeneration,
      refresh,
      refreshTransactions,
      updateBucket,
    ],
  );

  const moveAccountTo = useCallback(
    async (id: string, targetIndex: number): Promise<void> => {
      const generation = authGeneration;
      const isCurrent = () =>
        isScopeCurrent(scopeToken, generation, scopeTokenRef.current);
      try {
        if (!canReadLocalData || !isCurrent()) {
          throw new Error('Local data is locked to another account');
        }
        await moveAccountToInDB(id, targetIndex);
        if (!isCurrent()) return;
        await refresh();
        if (!isCurrent()) return;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to reorder accounts';
        if (isCurrent()) updateBucket(scopeToken, { error: message });
      }
    },
    [scopeToken, canReadLocalData, authGeneration, refresh, updateBucket],
  );

  return {
    accounts: bucket.accounts,
    isLoading: bucket.isLoading,
    error: bucket.error,
    refreshAccounts: refresh,
    addAccount,
    updateAccount,
    deleteAccount,
    moveAccountTo,
  };

}
