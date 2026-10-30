# Spec: Transaction Filter Persistence

**Status:** ✅ Done (v0.17.3, 2026-10-30)
**Scope:** Keep `/transactions` filter selections across tab navigation while preserving URL-driven filtering.

---

## 1. Why this exists

Filter state on `/transactions` lives in URL search params. The header tab links point at plain `/transactions`, so leaving the tab and returning dropped the query and reset every filter to its default. The URL remains the source of truth for filtering and sharing; a local mirror only restores the last selection when no query is present.

## 2. Behavior contract

1. Changing any filter updates the URL search params, as before.
2. Every non-empty filter query is mirrored to `localStorage['transactions_filters']`.
3. Navigating to another tab and back to plain `/transactions` restores the mirrored query and the visible selection.
4. A direct URL that already carries a query (`/transactions?month=2026-09&type=expense`) wins over the mirror and replaces it as the new saved state.
5. `Clear all` / `Clear filters` deletes the mirror, so a later return starts from defaults.
6. Removing the last remaining filter individually also deletes the mirror.
7. Storage access is wrapped in `try`/`catch`; browsers that block storage fall back to URL-only behavior.

## 3. Implementation

All behavior lives in `src/components/summary/TransactionList.tsx`.

| Piece | Role |
|---|---|
| `FILTERS_STORAGE_KEY = 'transactions_filters'` | localStorage key, alongside existing `tab_prefs` / `last_sync_time` keys |
| `filtersInitialized` ref | Runs restore-on-mount once, so React StrictMode's double effect cannot drop a pending restore |
| Persistence effect | Reads `searchParams.toString()`; restores the stored query when the mount URL is empty, otherwise stores the current query |
| `setParam` | Deletes the stored query when the last param is removed |
| `clearFilters` | Deletes the stored query before navigating to plain `/transactions` |

Restore uses `router.replace(..., { scroll: false })`, matching the existing filter navigation and keeping the back stack clean.

## 4. Key decisions

| Decision | Rationale |
|---|---|
| URL stays authoritative | Shareable links and explicit navigation must not be overridden by device state. |
| Mirror whole query string | One key, no per-filter schema, no migration. View flags (`group`, `page`) ride along. |
| Restore inside `TransactionList` | Keeps filter logic in one file; header links stay plain and route-agnostic. |
| Delete on clear, not on empty effect | A mount at plain `/transactions` must not erase the state it is about to restore; explicit clears own deletion. |

## 5. Files

| File | Change |
|---|---|
| `src/components/summary/TransactionList.tsx` | localStorage mirror, mount restore, clear-on-empty behavior |
| `specs/transaction-filters.md` | **New** — this spec |
| `specs/project-spec.md`, `specs/README.md` | Route description, decisions, index entry |

## 6. Verification

Browser smoke on `/transactions`:

1. Select a month and type filter; note the URL query.
2. Open another tab (Summary) and return via the Transactions tab.
3. Confirm the URL query and selected pills are the same.
4. Paste an explicit filtered URL and confirm it overrides the stored selection.
5. Click `Clear all`, leave the tab, return, and confirm default filters.

No dedicated unit test: the behavior is a route-transition effect over `useSearchParams`/`router`, not a pure function. The existing behavior seam is browser navigation.
