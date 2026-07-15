// ============================================================
// TransactionContext - Global state for transactions
// Provides transactions, loading state, and CRUD operations
// to all consumers in the component tree.
// ============================================================

'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import type { Transaction, Account, Category, MonthYear } from '@/types';
import {
  getAllTransactions,
  getAllAccounts,
  getAllCategories,
  addTransaction as addTransactionToDB,
  updateTransaction as updateTransactionInDB,
  deleteTransaction as deleteTransactionFromDB,
} from '@/lib/idb';
import { backgroundSync } from '@/lib/sync';
import { clearAllLocalData } from '@/lib/idb';
import { getCurrentMonthYear, formatCurrency } from '@/lib/utils';
import { useAuth } from '@/context/AuthContext';

/** localStorage key to track which user's data is cached locally */
const LAST_USER_KEY = 'lastUserId';

// ============================================================
// Context shape
// ============================================================

interface TransactionContextValue {
  /** All transactions from IndexedDB */
  transactions: Transaction[];
  /** All accounts from IndexedDB */
  accounts: Account[];
  /** All categories from IndexedDB */
  categories: Category[];
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
  /** Whether monetary amounts should be hidden (shown as asterisks) */
  hideAmounts: boolean;
  /** Toggle the hide amounts state */
  toggleHideAmounts: () => void;
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
  const { state: authState, user } = useAuth();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [monthYear, setMonthYear] = useState<MonthYear>(getCurrentMonthYear());
  const [hideAmounts, setHideAmounts] = useState(false);
  const toggleHideAmounts = useCallback(() => setHideAmounts((h) => !h), []);

  // Fetch all data from IndexedDB on mount
  const refreshTransactions = useCallback(async () => {
    try {
      setError(null);
      const [txs, accts, cats] = await Promise.all([
        getAllTransactions(),
        getAllAccounts(),
        getAllCategories(),
      ]);
      setTransactions(txs);
      setAccounts(accts);
      setCategories(cats);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load data';
      setError(message);
      console.error('[TransactionContext] Error loading data:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // ponytail: mount-init pattern — refreshTransactions is stable (useCallback([])).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshTransactions();
  }, [refreshTransactions]);

  // Auth lifecycle: manage local cache per user
  useEffect(() => {
    if (authState === 'disabled') {
      // No Supabase configured — app works offline as before
      return;
    }

    if (authState === 'loading') {
      // Still checking session — wait
      return;
    }

    let cancelled = false;

    if (authState === 'unauthenticated') {
      // User signed out or has no session
      const marker = localStorage.getItem(LAST_USER_KEY);
      if (marker) {
        clearAllLocalData().then(() => {
          if (cancelled) return;
          localStorage.removeItem(LAST_USER_KEY);
          refreshTransactions(); // renders empty state
        }).catch(() => {}); // ponytail: fire-and-forget, errors logged inside
      }
      return () => { cancelled = true; };
    }

    // authenticated
    if (authState === 'authenticated' && user) {
      const doSync = async () => {
        const marker = localStorage.getItem(LAST_USER_KEY);
        if (marker && marker !== user.id) {
          // Different user — wipe local cache
          await clearAllLocalData();
        }
        if (cancelled) return;
        localStorage.setItem(LAST_USER_KEY, user.id);
        if (navigator.onLine) {
          await backgroundSync();
        }
        if (cancelled) return;
        await refreshTransactions();
      };
      doSync().catch(() => {}); // ponytail: fire-and-forget, errors handled inside
    }

    return () => { cancelled = true; };
  }, [authState, user, refreshTransactions]);

  // Auth-aware online listener: sync when coming back online
  useEffect(() => {
    const handleOnline = () => {
      if (authState === 'authenticated' && user) {
        backgroundSync().then(() => refreshTransactions()).catch(() => {}); // ponytail: fire-and-forget, errors logged inside backgroundSync
      }
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [authState, user, refreshTransactions]);

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

  // Context value — memoized to prevent unnecessary re-renders of consumers
  const value: TransactionContextValue = useMemo(
    () => ({
      transactions,
      accounts,
      categories,
      isLoading,
      error,
      monthYear,
      setMonthYear,
      addTransaction,
      updateTransaction,
      deleteTransaction,
      refreshTransactions,
      hideAmounts,
      toggleHideAmounts,
    }),
    [transactions, accounts, categories, isLoading, error, monthYear, setMonthYear, addTransaction, updateTransaction, deleteTransaction, refreshTransactions, hideAmounts, toggleHideAmounts]
  );

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

/**
 * Format a monetary amount, respecting the hideAmounts toggle.
 */
export function formatAmount(amount: number, hidden: boolean): string {
  return hidden ? '****' : formatCurrency(amount);
}
