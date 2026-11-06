'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useSearchParams } from 'next/navigation';
import { FILTERS_STORAGE_KEY, filterQuery } from '@/lib/transaction-filters';

// Owns the /transactions filter query for the list: the hydration-gated restore
// from the localStorage mirror, the canonical query behind the controls, mirror
// persistence, and every filter-related history write. The canonical query comes
// from router params before hydration, a pending restore for as long as it owns
// the controls, or the whole browser query once hydrated, including view-only
// `group` and `page`.
type Restore =
  | { status: 'undecided' }
  | { status: 'idle' }
  | { status: 'active'; filters: string; userId: string | null; pathname: string }
  | { status: 'settled'; filters: string; userId: string | null };

// `active` and `settled` carry the identity that captured the query, and
// `active` also guards its deferred publish with the pathname, so an identity
// switch can never mirror one user's restored query for another.
const RESTORE_UNDECIDED: Restore = { status: 'undecided' };
const RESTORE_IDLE: Restore = { status: 'idle' };

// Server snapshot false, client snapshot true: the mirror is never read during
// hydration or on the server.
const subscribeNothing = () => () => {};
const hydratedSnapshot = () => true;
const serverHydratedSnapshot = () => false;

// The whole browser query, view-only params included. The mirror projection
// drops them.
function readBrowserQuery(): string {
  return window.location.search.replace(/^\?/, '');
}

// Precedence: pending restore, then the browser query once hydrated whenever it
// differs from the router's projection, then the router. Callers pass an empty
// browser query before hydration so the server path never reads `window`.
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

// One-time capture. Any query in the browser URL is explicit and wins, so only
// a query-less URL may restore the mirror. The router projection is ignored
// because on the first render it can still report a query the URL no longer has.
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

  // Hydration or auth can finish after mount; make the one-time decision then.
  if (restore.status === 'undecided' && isHydrated && canMirror) {
    setRestore(captureRestore(userId));
  }

  // A local write owns the URL from then on; the deferred publish must not
  // overwrite it or undo a clear that lands before the timer fires.
  const explicitUrlWrite = useRef(false);

  // Settle only once the browser URL carries a query. A divergent query is a
  // newer explicit choice; a matching allowlisted projection means the publish
  // landed. An empty URL is the pre-publish window, so stale router params
  // cannot settle it: that would hand the controls an empty URL and let the
  // mirror effect clear the saved query.
  if (restore.status === 'active') {
    const currentQuery = readBrowserQuery();
    if (currentQuery && currentQuery !== restore.filters) {
      setRestore({ status: 'settled', filters: filterQuery(currentQuery), userId: restore.userId });
    } else if (currentQuery && filterQuery(routerParams.toString()) === restore.filters) {
      setRestore({ status: 'settled', filters: restore.filters, userId: restore.userId });
    }
  }

  // A pending restore only backs the controls for the identity that captured it.
  const activeRestore =
    restore.status === 'active' && canMirror && userId === restore.userId
      ? restore
      : null;

  // Local writes replace the URL synchronously while the router can keep the
  // query it had before. This render bump makes the projection re-read the URL.
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

  // Router params only trigger this rerun. The mirror is always projected from
  // the browser URL, and a restored query owned by another identity is skipped
  // so an identity switch cannot write it back.
  useEffect(() => {
    if (!canMirror) return;
    // A full page load renders once with the server hydration snapshot, when
    // the restore decision is still undecided. That empty URL is not a clear,
    // so the mirror must survive until the decision lands.
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

  // Read every render: a local write moves the URL before the router does, and
  // this dependency makes the projection re-read it after a revision bump.
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
      try { localStorage.removeItem(FILTERS_STORAGE_KEY); } catch { /* ignore storage failures */ }
    }
    explicitUrlWrite.current = true;
    window.history.replaceState(null, '', window.location.pathname);
    bumpUrlRevision(n => n + 1);
  };

  // Resolve at call time so consecutive writes start from the latest URL and
  // cannot resurrect stale router params or drop view-only params.
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
      } catch { /* ignore storage failures */ }
    }
    setRestore(RESTORE_IDLE);
    explicitUrlWrite.current = true;
    window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
    bumpUrlRevision(n => n + 1);
  };

  // Page reset is not a filter write: it removes `page` from the canonical
  // query and leaves the mirror, restore, and revision state untouched.
  const normalizePage = useCallback((hasActiveFilters: boolean) => {
    if (!hasActiveFilters) return;
    const next = new URLSearchParams(params);
    if (!next.has('page')) return;
    next.delete('page');
    window.history.replaceState(null, '', `?${next.toString()}`);
  }, [params]);

  return { params, setParam, clearFilters, normalizePage };
}
