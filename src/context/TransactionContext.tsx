// ============================================================
// TransactionContext - Global state for transactions
// Provides transactions, loading state, and CRUD operations
// to all consumers in the component tree.
// ============================================================

'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import type { Transaction, Account, MonthYear } from '@/types';
import {
  getAllTransactions,
  getAllAccounts,
  addTransaction as addTransactionToDB,
  updateTransaction as updateTransactionInDB,
  deleteTransaction as deleteTransactionFromDB,
  seedTransactionsIfEmpty,
} from '@/lib/idb';
import { backgroundSync } from '@/lib/sync';
import { getCurrentMonthYear } from '@/lib/utils';

// ============================================================
// Context shape
// ============================================================

interface TransactionContextValue {
  /** All transactions from IndexedDB */
  transactions: Transaction[];
  /** All accounts from IndexedDB */
  accounts: Account[];
  /** Whether initial data is still loading */
  isLoading: boolean;
  /** Error message if something went wrong */
  error: string | null;
  /** Currently selected month/year for the summary */
  monthYear: MonthYear;
  /** Set the currently selected month/year */
  setMonthYear: (m: MonthYear) => void;
  /** Add a new transaction (auto-generates id, timestamps) */
  addTransaction: (tx: Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>) => Promise<string>;
  /** Update an existing transaction */
  updateTransaction: (tx: Transaction) => Promise<void>;
  /** Delete a transaction by ID */
  deleteTransaction: (id: string) => Promise<void>;
  /** Force a refresh of transactions from IndexedDB */
  refreshTransactions: () => Promise<void>;
}

// ============================================================
// Context creation
// ============================================================

const TransactionContext = createContext<TransactionContextValue | null>(null);

// ============================================================
// Provider component
// ============================================================

interface TransactionProviderProps {
  children: ReactNode;
}

export function TransactionProvider({ children }: TransactionProviderProps) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [monthYear, setMonthYear] = useState<MonthYear>(getCurrentMonthYear());

  // Fetch all data from IndexedDB on mount
  const refreshTransactions = useCallback(async () => {
    try {
      setError(null);
      const [txs, accts] = await Promise.all([
        getAllTransactions(),
        getAllAccounts(),
      ]);
      setTransactions(txs);
      setAccounts(accts);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load data';
      setError(message);
      console.error('[TransactionContext] Error loading data:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    seedTransactionsIfEmpty()
      .then(() => refreshTransactions())
      .catch(() => { /* seed failure handled by refresh fallthrough */ });
    // refreshTransactions intentionally excluded — stable callback, first mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Background sync: push local changes + pull remote data on mount
  // Also listen for online/offline transitions
  useEffect(() => {
    if (navigator.onLine) {
      backgroundSync().then(() => refreshTransactions());
    }

    const handleOnline = () => {
      backgroundSync().then(() => refreshTransactions());
    };

    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
    // ponytail: single shot on mount + online events. No periodic polling.
    // Add setInterval polling if real-time sync becomes critical.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Add a transaction
  const addTransaction = useCallback(
    async (tx: Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> => {
      try {
        setError(null);
        const id = await addTransactionToDB(tx);
        // Optimistic update: add the new transaction to local state
        const now = Date.now();
        const newTx: Transaction = {
          ...tx,
          id,
          createdAt: now,
          updatedAt: now,
        };
        setTransactions((prev) => [newTx, ...prev]);
        return id;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to add transaction';
        setError(message);
        console.error('[TransactionContext] Error adding transaction:', err);
        throw err;
      }
    },
    []
  );

  // Update a transaction
  const updateTransaction = useCallback(async (tx: Transaction): Promise<void> => {
    try {
      setError(null);
      await updateTransactionInDB(tx);
      setTransactions((prev) =>
        prev.map((t) => (t.id === tx.id ? { ...tx, updatedAt: Date.now() } : t))
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update transaction';
      setError(message);
      console.error('[TransactionContext] Error updating transaction:', err);
      throw err;
    }
  }, []);

  // Delete a transaction
  const deleteTransaction = useCallback(async (id: string): Promise<void> => {
    try {
      setError(null);
      await deleteTransactionFromDB(id);
      setTransactions((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete transaction';
      setError(message);
      console.error('[TransactionContext] Error deleting transaction:', err);
      throw err;
    }
  }, []);

  // Context value
  const value: TransactionContextValue = {
    transactions,
    accounts,
    isLoading,
    error,
    monthYear,
    setMonthYear,
    addTransaction,
    updateTransaction,
    deleteTransaction,
    refreshTransactions,
  };

  return (
    <TransactionContext.Provider value={value}>
      {children}
    </TransactionContext.Provider>
  );
}

// ============================================================
// Hook for consuming the context
// ============================================================

/**
 * Access the TransactionContext. Must be used within a TransactionProvider.
 */
export function useTransactionContext(): TransactionContextValue {
  const ctx = useContext(TransactionContext);
  if (!ctx) {
    throw new Error(
      'useTransactionContext must be used within a TransactionProvider'
    );
  }
  return ctx;
}
