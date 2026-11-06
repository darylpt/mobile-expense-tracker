// ============================================================
// TransactionContext - Global state for transactions
// Provides transactions, loading state, and CRUD operations
// to all consumers in the component tree.
// ============================================================

'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react';
import type { Transaction, Account, Category, MonthYear } from '@/types';
import {
  getAllTransactions,
  getAllAccounts,
  getAllCategories,
  addTransaction as addTransactionToDB,
  updateTransaction as updateTransactionInDB,
  deleteTransaction as deleteTransactionFromDB,
  hasAnyLocalData,
} from '@/lib/idb';
import { backgroundSync } from '@/lib/sync';
import {
  captureAuthScope,
  getAuthGeneration,
  isAuthScopeCurrent,
  type AuthScope,
} from '@/lib/auth-scope';
import { getCurrentMonthYear, formatCurrency } from '@/lib/utils';
import { LAST_USER_STORAGE_KEY } from '@/lib/constants';
import { useAuth } from '@/context/AuthContext';

/** localStorage key to track which user's data is cached locally */
const LAST_USER_KEY = LAST_USER_STORAGE_KEY;

type AuthStateName = 'disabled' | 'loading' | 'authenticated' | 'unauthenticated';

/** Identity rendered by the provider when a callback was created. */
interface RenderedAuth {
  readonly state: AuthStateName;
  readonly userId: string | null;
  readonly generation: number;
}

/**
 * Authorization captured for a callback invocation. The rendered identity is
 * bound when the callback is created, so a callback retained across an auth
 * transition can never adopt a newer generation as its authority.
 */
interface ReadScope {
  readonly auth: RenderedAuth;
  readonly scope: AuthScope | null;
}

function captureReadScope(auth: RenderedAuth): ReadScope {
  return { auth, scope: captureAuthScope() };
}

/**
 * Generation fence for bootstrap work that must establish ownership before an
 * AuthScope can exist (for example, claiming an empty local cache for a newly
 * signed-in account). It never authorizes private data reads by itself.
 */
interface IdentityToken {
  readonly auth: RenderedAuth;
}

function isIdentityCurrent(token: IdentityToken, live: RenderedAuth): boolean {
  if (getAuthGeneration() !== live.generation) return false;
  if (token.auth.generation !== live.generation) return false;
  if (token.auth.state !== live.state) return false;
  return token.auth.userId === live.userId;
}

/**
 * True only while the callback's creation-time identity still matches the live
 * provider render and the shared auth generation, and the local cache is
 * proven to belong to the active account.
 */
function isReadScopeCurrent(token: ReadScope, live: RenderedAuth): boolean {
  if (getAuthGeneration() !== live.generation) return false;
  if (token.auth.generation !== live.generation) return false;
  if (token.auth.state !== live.state) return false;
  if (token.auth.userId !== live.userId) return false;

  if (live.state === 'authenticated') {
    if (!live.userId) return false;
    if (!token.scope) return false;
    if (token.scope.userId !== live.userId) return false;
    return isAuthScopeCurrent(token.scope);
  }

  if (live.state === 'disabled') {
    // Local-only mode: no authenticated scope and the generation is unchanged.
    return token.scope === null;
  }

  // loading or unauthenticated: account-scoped data is never authorized.
  return false;
}

// ============================================================
// Context shape
// ============================================================

export interface TransactionContextValue {
  /** All transactions from IndexedDB */
  transactions: Transaction[];
  /** All accounts from IndexedDB */
  accounts: Account[];
  /** All categories from IndexedDB */
  categories: Category[];
  /** Whether initial data is still loading */
  isLoading: boolean;
  /**
   * True only when local IndexedDB data is proven to belong to the current
   * scope. Components must not read/write app data while this is false.
   */
  isScopeVerified: boolean;
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
  const { state: authState, user, authGeneration = 0 } = useAuth();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isScopeVerified, setIsScopeVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [monthYear, setMonthYear] = useState<MonthYear>(getCurrentMonthYear());
  const [hideAmounts, setHideAmounts] = useState(false);
  const toggleHideAmounts = useCallback(() => setHideAmounts((h) => !h), []);

  // Identity rendered by this provider. Callbacks capture this object at
  // creation time and compare it with the latest render before reading or
  // publishing, so a stale callback cannot borrow a newer generation.
  const renderedUserId = user?.id ?? null;
  const renderedAuth = useMemo<RenderedAuth>(
    () => ({ state: authState, userId: renderedUserId, generation: authGeneration }),
    [authState, renderedUserId, authGeneration],
  );
  const liveAuthRef = useRef(renderedAuth);
  useEffect(() => {
    liveAuthRef.current = renderedAuth;
  }, [renderedAuth]);

  // Monotonic request sequence scoped to this provider. Within one identity
  // generation, only the most recently authorized read may publish: an older
  // read that settles later must not overwrite newer rows or settle loading.
  const readRequestIdRef = useRef(0);

  // Identity whose initial local read has settled. `isScopeVerified` proves
  // cache ownership, not that startup's first read finished: lifecycle events
  // must wait for that read before a sync or refresh may use the cache.
  const initialReadAuthRef = useRef<RenderedAuth | null>(null);

  // Fetch all data from IndexedDB. A read started for one identity generation
  // never publishes rows, errors, or loading state for another, and within a
  // generation only the latest authorized read may publish.
  const refreshTransactions = useCallback(async () => {
    const token = captureReadScope(renderedAuth);
    const isCurrent = () => isReadScopeCurrent(token, liveAuthRef.current);
    // Unauthorized callbacks never join the sequence, so a stale callback
    // cannot supersede a live read.
    if (!isCurrent()) return;
    const requestId = readRequestIdRef.current + 1;
    readRequestIdRef.current = requestId;
    const isLatest = () => readRequestIdRef.current === requestId && isCurrent();
    try {
      if (!isLatest()) return;
      setError(null);
      const [txs, accts, cats] = await Promise.all([
        getAllTransactions(),
        getAllAccounts(),
        getAllCategories(),
      ]);
      if (!isLatest()) return;
      setTransactions(txs);
      setAccounts(accts);
      setCategories(cats);
    } catch (err) {
      if (!isLatest()) return;
      const message = err instanceof Error ? err.message : 'Failed to load data';
      setError(message);
      console.error('[TransactionContext] Error loading data:', err);
    } finally {
      if (isLatest()) setIsLoading(false);
    }
  }, [renderedAuth]);

  // Auth-scoped initialization. Data is loaded only after the local cache
  // owner is verified; it is never cleared on sign-out or account switch.
  // Every continuation also checks the captured identity generation: work
  // begun for a previous generation cannot publish or load for the new one.
  useEffect(() => {
    let cancelled = false;
    const token: IdentityToken = { auth: renderedAuth };
    const isCurrent = () => !cancelled && isIdentityCurrent(token, liveAuthRef.current);
    // A new startup run invalidates the previous run's completion marker.
    initialReadAuthRef.current = null;

    const load = async () => {
      if (authState === 'loading') {
        setIsScopeVerified(false);
        return;
      }

      if (authState === 'disabled') {
        // No Supabase configured — local-only usage is the owner.
        setIsScopeVerified(true);
        await refreshTransactions();
        if (!isCurrent()) return;
        initialReadAuthRef.current = token.auth;
        return;
      }

      if (authState === 'unauthenticated') {
        // Hide cached data from the UI without deleting it from IndexedDB.
        if (!isCurrent()) return;
        setIsScopeVerified(false);
        setTransactions([]);
        setAccounts([]);
        setCategories([]);
        setError(null);
        setIsLoading(false);
        return;
      }

      // Use the rendered identity's primitive user id rather than the user
      // object: a freshly hydrated User object with the same account must not
      // restart startup.
      const userId = renderedAuth.userId;
      if (authState !== 'authenticated' || !userId) return;

      const marker = localStorage.getItem(LAST_USER_KEY);
      if (marker && marker !== userId) {
        // Different account: fail closed. Never expose another account's cache.
        setIsScopeVerified(false);
        setTransactions([]);
        setAccounts([]);
        setCategories([]);
        setError(
          'Local data belongs to a different signed-in account and was not loaded. Nothing has been deleted. Sign back in with the account that owns this data.'
        );
        setIsLoading(false);
        return;
      }

      if (!marker) {
        const hasData = await hasAnyLocalData();
        if (!isCurrent()) return;
        if (hasData) {
          // Legacy/local-only rows cannot be assigned to an account safely.
          setIsScopeVerified(false);
          setTransactions([]);
          setAccounts([]);
          setCategories([]);
          setError(
            'Local data has no verified account owner. It was not loaded or uploaded; nothing has been deleted. Sign back in with the account that owns this data.'
          );
          setIsLoading(false);
          return;
        }
        localStorage.setItem(LAST_USER_KEY, userId);
      }

      if (!isCurrent()) return;
      // Authenticated bootstrap must end with a live shared scope. A null
      // scope here means the shared identity is not authenticated for this
      // account, so local data is never marked verified.
      if (!captureAuthScope()) return;
      setIsScopeVerified(true);

      // Publish the local cache first and settle loading; the network sync must
      // never hold the UI hostage. Ownership is already verified above.
      await refreshTransactions();
      if (!isCurrent()) return;
      initialReadAuthRef.current = token.auth;

      if (!navigator.onLine) return;

      // Reconcile in the background without awaiting it in the startup
      // lifetime. Whichever way it settles, refresh only if this same startup
      // run is still current.
      const syncThenRefresh = () => {
        if (!isCurrent()) return;
        return refreshTransactions();
      };
      backgroundSync().then(syncThenRefresh, syncThenRefresh);
    };

    load().catch((err) => {
      if (!isCurrent()) return;
      setError(err instanceof Error ? err.message : 'Failed to establish local data ownership');
      setIsLoading(false);
    });

    return () => { cancelled = true; };
  }, [authState, renderedAuth, refreshTransactions]);

  // Refresh/sync lifecycle: online, foreground, and successful reconciliation.
  // Callbacks are bound to the generation that registered them so a cycle or
  // event that finishes after a transition cannot trigger a stale refresh.
  useEffect(() => {
    let cancelled = false;
    const token = captureReadScope(renderedAuth);
    const isCurrent = () => !cancelled && isReadScopeCurrent(token, liveAuthRef.current);

    const canSync = () =>
      isScopeVerified &&
      // Ownership alone is not enough: the startup read for this exact
      // identity must have settled before a lifecycle event may sync.
      initialReadAuthRef.current === renderedAuth &&
      isCurrent() &&
      (authState === 'disabled' ||
        (authState === 'authenticated' &&
          !!user &&
          localStorage.getItem(LAST_USER_KEY) === user.id));

    const syncAndRefresh = () => {
      if (!canSync()) return;
      const cycle = captureReadScope(renderedAuth);
      backgroundSync()
        .then(() => {
          if (!isReadScopeCurrent(cycle, liveAuthRef.current)) return;
          return refreshTransactions();
        })
        .catch(() => {});
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') syncAndRefresh();
    };
    const handleSyncComplete = () => {
      if (canSync()) refreshTransactions();
    };

    window.addEventListener('online', syncAndRefresh);
    window.addEventListener('sync-complete', handleSyncComplete);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      cancelled = true;
      window.removeEventListener('online', syncAndRefresh);
      window.removeEventListener('sync-complete', handleSyncComplete);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [authState, user, authGeneration, renderedAuth, isScopeVerified, refreshTransactions]);

  // Add a transaction
  const addTransaction = useCallback(
    async (tx: Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> => {
      const token = captureReadScope(renderedAuth);
      const isCurrent = () => isReadScopeCurrent(token, liveAuthRef.current);
      try {
        // A stale callback keeps its creation-time token, so it cannot borrow
        // the current generation's authority after a transition.
        if (!isScopeVerified || !isCurrent()) {
          throw new Error('Local data is locked to another account');
        }
        setError(null);
        const id = await addTransactionToDB(tx);
        if (!isCurrent()) return id;
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
        if (isCurrent()) setError(message);
        console.error('[TransactionContext] Error adding transaction:', err);
        throw err;
      }
    },
    [isScopeVerified, renderedAuth]
  );

  // Update a transaction
  const updateTransaction = useCallback(async (tx: Transaction): Promise<void> => {
    const token = captureReadScope(renderedAuth);
    const isCurrent = () => isReadScopeCurrent(token, liveAuthRef.current);
    try {
      if (!isScopeVerified || !isCurrent()) {
        throw new Error('Local data is locked to another account');
      }
      setError(null);
      await updateTransactionInDB(tx);
      if (!isCurrent()) return;
      setTransactions((prev) =>
        prev.map((t) => (t.id === tx.id ? { ...tx, updatedAt: Date.now() } : t))
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update transaction';
      if (isCurrent()) setError(message);
      console.error('[TransactionContext] Error updating transaction:', err);
      throw err;
    }
  }, [isScopeVerified, renderedAuth]);

  // Delete a transaction
  const deleteTransaction = useCallback(async (id: string): Promise<void> => {
    const token = captureReadScope(renderedAuth);
    const isCurrent = () => isReadScopeCurrent(token, liveAuthRef.current);
    try {
      if (!isScopeVerified || !isCurrent()) {
        throw new Error('Local data is locked to another account');
      }
      setError(null);
      await deleteTransactionFromDB(id);
      if (!isCurrent()) return;
      setTransactions((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete transaction';
      if (isCurrent()) setError(message);
      console.error('[TransactionContext] Error deleting transaction:', err);
      throw err;
    }
  }, [isScopeVerified, renderedAuth]);

  // Context value — memoized to prevent unnecessary re-renders of consumers
  const value: TransactionContextValue = useMemo(
    () => ({
      transactions,
      accounts,
      categories,
      isLoading,
      isScopeVerified,
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
    [transactions, accounts, categories, isLoading, isScopeVerified, error, monthYear, setMonthYear, addTransaction, updateTransaction, deleteTransaction, refreshTransactions, hideAmounts, toggleHideAmounts]
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
