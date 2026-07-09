// ============================================================
// useAccounts - Hook for managing accounts
// Fetches from IndexedDB and provides CRUD operations.
// ============================================================

'use client';

import { useState, useEffect, useCallback } from 'react';
import type { Account } from '@/types';
import {
  getAllAccounts,
  addAccount as addAccountToDB,
  updateAccount as updateAccountToDB,
  deleteAccount as deleteAccountFromDB,
  moveAccountTo as moveAccountToInDB,
} from '@/lib/idb';

import { useTransactionContext } from '@/context/TransactionContext';

export function useAccounts() {
  const ctx = useTransactionContext();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    getAllAccounts()
      .then((data) => { if (mounted) setAccounts(data); })
      .catch((err) => {
        const message = err instanceof Error ? err.message : 'Failed to load accounts';
        if (mounted) setError(message);
        console.error('[useAccounts] Error loading accounts:', err);
      })
      .finally(() => { if (mounted) setIsLoading(false); });
    return () => { mounted = false; };
  }, []);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await getAllAccounts();
      setAccounts(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load accounts';
      setError(message);
      console.error('[useAccounts] Error loading accounts:', err);
    }
  }, []);

  const addAccount = useCallback(async (account: Omit<Account, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> => {
    try {
      const id = await addAccountToDB(account);
      await refresh();
      await ctx.refreshTransactions();
      return id;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add account';
      setError(message);
      throw new Error(message);
    }
  }, [refresh, ctx]);

  const updateAccount = useCallback(async (account: Partial<Account> & Pick<Account, 'id'>): Promise<void> => {
    try {
      await updateAccountToDB(account);
      await refresh();
      await ctx.refreshTransactions();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update account';
      setError(message);
      throw new Error(message);
    }
  }, [refresh, ctx]);

  const deleteAccount = useCallback(async (id: string): Promise<void> => {
    try {
      await deleteAccountFromDB(id);
      await refresh();
      await ctx.refreshTransactions();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete account';
      setError(message);
      throw new Error(message);
    }
  }, [refresh, ctx]);

  const moveAccountTo = useCallback(async (id: string, targetIndex: number): Promise<void> => {
    try {
      await moveAccountToInDB(id, targetIndex);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reorder accounts';
      setError(message);
    }
  }, [refresh]);

  return {
    accounts,
    isLoading,
    error,
    refreshAccounts: refresh,
    addAccount,
    updateAccount,
    deleteAccount,
    moveAccountTo,
  };
}
