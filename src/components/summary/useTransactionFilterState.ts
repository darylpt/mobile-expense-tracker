'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useSearchParams } from 'next/navigation';
import { FILTERS_STORAGE_KEY, filterQuery } from '@/lib/transaction-filters';

type Restore =
  | { status: 'undecided' }
  | { status: 'idle' }
  | { status: 'active'; filters: string; userId: string | null; pathname: string }
  | { status: 'settled'; filters: string; userId: string | null };

const RESTORE_UNDECIDED: Restore = { status: 'undecided' };
const RESTORE_IDLE: Restore = { status: 'idle' };

const subscribeNothing = () => () => {};
const hydratedSnapshot = () => true;
const serverHydratedSnapshot = () => false;

function readBrowserQuery(): string {
  return window.location.search.replace(/^\?/, '');
}

function canonicalFilterParams(
  hydrated: boolean,
  routerParams: URLSearchParams,
  browserQuery: string,
  restoreFilters: string | null
): URLSearchParams {
  if (restoreFilters !== null) return new URLSearchParams(restoreFilters);
  if (hydrated) {
    const browserParams = new URLSearchParams(browserQuery);
    if (browserParams.toString() !== routerParams.toString()) return browserParams;
  }
  return routerParams;
}

function captureRestore(userId: string | null): Restore {
  if (readBrowserQuery()) return RESTORE_IDLE;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(FILTERS_STORAGE_KEY);
  } catch {
    saved = null;
  }
  const filters = filterQuery(saved ?? '');
  if (!filters) return RESTORE_IDLE;
  return { status: 'active', filters, userId, pathname: window.location.pathname };
}

type TransactionFilterState = {
  params: URLSearchParams;
  setParam(name: string, value: string | null): void;
  clearFilters(): void;
  normalizePage(hasActiveFilters: boolean): void;
};

export function useTransactionFilterState(input: {
  canMirror: boolean;
  userId: string | null;
}): TransactionFilterState {
  const { canMirror, userId } = input;
  const routerParams = useSearchParams();

  const isHydrated = useSyncExternalStore(subscribeNothing, hydratedSnapshot, serverHydratedSnapshot);

  const [restore, setRestore] = useState<Restore>(
    () => (isHydrated && canMirror ? captureRestore(userId) : RESTORE_UNDECIDED)
  );

  if (restore.status === 'undecided' && isHydrated && canMirror) {
    setRestore(captureRestore(userId));
  }

  const explicitUrlWrite = useRef(false);

  if (restore.status === 'active') {
    const currentQuery = readBrowserQuery();
    if (currentQuery && currentQuery !== restore.filters) {
      setRestore({ status: 'settled', filters: filterQuery(currentQuery), userId: restore.userId });
    } else if (currentQuery && filterQuery(routerParams.toString()) === restore.filters) {
      setRestore({ status: 'settled', filters: restore.filters, userId: restore.userId });
    }
  }

  const activeRestore =
    restore.status === 'active' && canMirror && userId === restore.userId
      ? restore
      : null;

  const [, bumpUrlRevision] = useState(0);

  // Both writes are required. The first publishes the restored query
  // immediately with the current history state; Next installs its history patch
  // in an ancestor effect that runs after this one. The deferred write
  // republishes once that patch is live and must pass `null`, because Next
  // bypasses ACTION_RESTORE for an entry carrying its `__NA` marker. See
  // specs/transaction-filters.md.
  useEffect(() => {
    if (!activeRestore) return;
    window.history.replaceState(window.history.state, '', `?${activeRestore.filters}`);
  }, [activeRestore]);

  useEffect(() => {
    if (!activeRestore) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      if (
        explicitUrlWrite.current ||
        window.location.pathname !== activeRestore.pathname ||
        (window.location.search !== '' && window.location.search !== `?${activeRestore.filters}`)
      ) {
        return;
      }
      window.history.replaceState(null, '', `?${activeRestore.filters}`);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeRestore]);

  useEffect(() => {
    if (!canMirror) return;
    if (restore.status === 'undecided') return;
    if (restore.status === 'active' && userId !== restore.userId) return;
    const filters = filterQuery(readBrowserQuery());
    if (restore.status === 'settled' && userId !== restore.userId && filters === restore.filters) {
      return;
    }
    if (!filters && activeRestore) return;
    try {
      if (filters) localStorage.setItem(FILTERS_STORAGE_KEY, filters);
      else localStorage.removeItem(FILTERS_STORAGE_KEY);
    } catch {}
  }, [routerParams, canMirror, userId, restore, activeRestore]);

  const browserQuery = isHydrated ? readBrowserQuery() : '';
  const params = useMemo(
    () =>
      canonicalFilterParams(
        isHydrated,
        routerParams,
        browserQuery,
        activeRestore ? activeRestore.filters : null
      ),
    [activeRestore, isHydrated, routerParams, browserQuery]
  );

  const clearFilters = () => {
    setRestore(RESTORE_IDLE);
    if (canMirror) {
      try { localStorage.removeItem(FILTERS_STORAGE_KEY); } catch {}
    }
    explicitUrlWrite.current = true;
    window.history.replaceState(null, '', window.location.pathname);
    bumpUrlRevision(n => n + 1);
  };

  const setParam = (name: string, value: string | null) => {
    const next = new URLSearchParams(
      canonicalFilterParams(
        isHydrated,
        routerParams,
        isHydrated ? readBrowserQuery() : '',
        activeRestore ? activeRestore.filters : null
      )
    );
    if (value === null || value === '') {
      next.delete(name);
    } else {
      next.set(name, value);
    }
    const query = next.toString();
    if (canMirror) {
      const filters = filterQuery(query);
      try {
        if (filters) localStorage.setItem(FILTERS_STORAGE_KEY, filters);
        else localStorage.removeItem(FILTERS_STORAGE_KEY);
      } catch {}
    }
    setRestore(RESTORE_IDLE);
    explicitUrlWrite.current = true;
    window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
    bumpUrlRevision(n => n + 1);
  };

  const normalizePage = useCallback((hasActiveFilters: boolean) => {
    if (!hasActiveFilters) return;
    const next = new URLSearchParams(params);
    if (!next.has('page')) return;
    next.delete('page');
    window.history.replaceState(null, '', `?${next.toString()}`);
  }, [params]);

  return { params, setParam, clearFilters, normalizePage };
}
