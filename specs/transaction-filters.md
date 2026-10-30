# Spec: Transaction Filter Persistence

**Status:** ✅ Done (v0.17.5, 2026-10-30)
**Scope:** Keep `/transactions` filter selections across tab navigation while preserving URL-driven filtering.

---

## 1. Why this exists

Filter state on `/transactions` lives in URL search params. The header tab links point at plain `/transactions`, so leaving the tab and returning dropped the query and reset every filter to its default. The URL remains the source of truth for filtering and sharing; a local mirror only restores the last selection when no query is present.

## 2. Behavior contract

1. Changing any filter updates the URL search params, as before.
2. Only month, type, account, category (`cat`), and search (`q`) is mirrored to `localStorage['transactions_filters']`.
3. Navigating to another tab and back to plain `/transactions` restores the mirrored query and the visible selection.
4. A direct URL that already carries a query (`/transactions?month=2026-09&type=expense`) wins over the mirror and replaces it as the new saved state.
5. `Clear all` / `Clear filters` deletes the mirror, so a later return starts from defaults.
6. Removing the last remaining filter individually also deletes the mirror.
7. Sign-out and user switches clear saved filters before the next identity can restore them; same-user reload retains filters.
8. Mirror reads and writes wait until auth is authenticated or offline-disabled; loading and unauthenticated remounts cannot restore or save filters, including PIN sign-out.
9. Storage access is wrapped in `try`/`catch`; browsers that block storage fall back to URL-only behavior.

## 3. Implementation

The list owns restore/save behavior, `src/lib/transaction-filters.ts` selects persistable parameters, and `AuthContext` clears the mirror before publishing sign-out or a changed identity.

| Piece | Role |
|---|---|
| `FILTERS_STORAGE_KEY = 'transactions_filters'` | localStorage key, alongside existing `tab_prefs` / `last_sync_time` keys |
| `filtersInitialized` ref | Runs restore-on-mount once, so React StrictMode's double effect cannot drop a pending restore |
| Persistence effect | Allowlist applied to both saved and restored queries; explicit URL query remains authoritative, even with only view parameters |
| `setParam` | Deletes the stored query when the last filter is removed, even if view parameters remain |
| `clearFilters` | Deletes the stored query before navigating to plain `/transactions` |

Restore uses `router.replace(..., { scroll: false })`, matching the existing filter navigation and keeping the back stack clean.

## 4. Key decisions

| Decision | Rationale |
|---|---|
| URL stays authoritative | Shareable links and explicit navigation must not be overridden by device state. |
| Mirror filters only | Grouping (`group`), pagination (`page`), and unrelated parameters remain URL-only. |
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

Focused regression tests cover filter selection, authentication cleanup, the real list remount after PIN sign-out, blocked loading/unauthenticated persistence, and offline URL restore/precedence.
