# Spec: Transaction Filter Persistence

**Status:** ✅ Done (base filter persistence v0.18.3; controller extraction and hydration-safe reload fix v0.19.0, 2026-10-31)
**Scope:** Keep `/transactions` filter selections across tab navigation while preserving URL-driven filtering.

---

## 1. Why this exists

Filter state on `/transactions` lives in URL search params. The header tab links point at plain `/transactions`, so leaving the tab and returning dropped the query and reset every filter to its default. The URL remains the source of truth for filtering and sharing; a local mirror only restores the last selection when no query is present.

## 2. Behavior contract

1. Changing any filter updates the URL search params, as before.
2. Only month, type, account, category (`cat`), and search (`q`) are mirrored to `localStorage['transactions_filters']`.
3. Navigating to another tab and back to plain `/transactions` restores the mirrored query and the visible selection.
4. A direct URL that already carries a query (`/transactions?month=2026-09&type=expense`) wins over the mirror and replaces it as the new saved state.
5. When mirror access is allowed, `Clear all` / `Clear filters` deletes the mirror and replaces the URL with plain `/transactions`; loading and unauthenticated states do not access storage.
6. Removing the last remaining filter individually also deletes the mirror when mirror access is allowed.
7. Sign-out and user switches clear saved filters before the next identity can restore them; a query restored under one identity cannot repopulate another identity's mirror. Same-user reload retains filters.
8. Mirror reads and writes wait until auth is authenticated or offline-disabled; loading and unauthenticated remounts cannot restore or save filters, including PIN sign-out.
9. Storage access is wrapped in `try`/`catch`; browsers that block storage fall back to URL-only behavior.

## 3. Implementation

`src/components/summary/useTransactionFilterState.ts` owns restore/save behavior and every filter-related history write. `TransactionList` derives active-filter state, renders the controls and list, and calls the hook's `setParam`, `clearFilters`, and `normalizePage`. `src/lib/transaction-filters.ts` selects persistable parameters, and `AuthContext` clears the mirror before publishing sign-out or a changed identity.

| Piece | Role |
|---|---|
| `FILTERS_STORAGE_KEY = 'transactions_filters'` | localStorage key, alongside existing `tab_prefs` / `last_sync_time` keys |
| `useTransactionFilterState` | Private controller: hydration-gated capture, canonical query projection, restore transitions and provenance, mirror persistence, explicit writes, revision bump, and page normalization. `params` is the canonical query behind the controls; no caller reads storage, chooses a query source, or touches history directly. |
| `Restore` state | Hook-internal capture of the saved query once after hydration and eligible auth; a pending restore settles only after the browser URL itself has a query—a divergent explicit URL wins immediately, otherwise Next must match the published projection. Stale router params alone cannot settle it. |
| Restore publish | Two-stage publish in the hook: writes the restored query immediately with the current history state, then republishes once Next's history patch is live so `useSearchParams` reflects the restored query |
| Persistence effect | Applies the allowlist to saved and restored queries; explicit URL queries remain authoritative, including view-only queries. It skips storage entirely while the restore decision is `undecided`, so the hydration render cannot delete a saved query from an empty URL before capture reads it. |
| `setParam` | Builds updates from the canonical URL projection, preserves view-only parameters, and deletes the stored query when the last filter is removed |
| `clearFilters` | Deletes the stored query when mirror access is allowed, then replaces the URL with path-only `/transactions` without a document navigation |
| `normalizePage` | Removes `page` for active filters from the canonical projection so stale router params cannot overwrite a pending restore; it does not touch the mirror, restore, or revision state |

Restore-publish evidence for the installed Next.js 16.2.9: the App Router installs its `history.replaceState` patch inside an ancestor `useEffect`, which runs after this hook's mount effects on a full page load. The immediate write therefore runs through whatever implementation is active and keeps the current `window.history.state` so Next's internals survive. The deferred zero-delay write passes `null` because the installed patch returns before dispatching `ACTION_RESTORE` when the data carries Next's internal `__NA` or `_N` marker (`node_modules/next/dist/client/components/app-router.js`, `replaceState` wrapper). Recheck both writes against the installed version's history patch on every Next upgrade; `__NA` is an internal marker, not a public contract.

Query-only filter updates, clearing, page normalization, and restore use Next.js-integrated `history.replaceState`, keeping the back stack clean without fetching static route payloads that can replay the original direct URL query. During mount-time restore, saved filters back the controls; after hydration, the browser URL remains authoritative when router params lag, and an empty URL cannot be displaced by stale router values. Filter updates and page normalization use that same canonical projection, so consecutive writes do not resurrect stale router params.

## 4. Key decisions

| Decision | Rationale |
|---|---|
| URL stays authoritative | Shareable links and explicit navigation must not be overridden by device state. |
| Mirror filters only | Grouping (`group`), pagination (`page`), and unrelated parameters remain URL-only. |
| Private transaction filter hook | `useTransactionFilterState` owns the three-source canonical query, restore publication, and mirror writes; `TransactionList` keeps only filter derivation and rendering. No generic URL hook: there is no second consumer, and the policy depends on auth identity and one-time restore. Transactions tabs still use plain document navigation so the static router cannot replay a previous direct query. |
| No deletion during a pending restore | A plain `/transactions` mount must preserve the query it is about to restore; explicit queries, including view-only queries, own the mirror, while clear/last-filter removal explicitly delete it. |
| No storage access before the restore decision | A full page load renders once with the hydration snapshot while the restore is `undecided`, and that render's empty URL is not evidence of a clear. Reading or removing the mirror there would delete the saved query before capture can restore it, so the persistence effect waits for `idle`, `active`, or `settled`. |

## 5. Files

| File | Change |
|---|---|
| `src/components/summary/useTransactionFilterState.ts` | Private controller: hydration-gated capture, canonical query projection, restore publication and provenance, mirror persistence, explicit writes, revision bump, and page normalization |
| `src/components/summary/TransactionList.tsx` | Consumes the controller; filter derivation, search draft, page-reset condition, and rendering |
| `src/components/layout/Header.tsx` | Plain document navigation to Transactions on desktop and mobile |
| `src/lib/transaction-filters.ts` | Persistable filter allowlist and storage key |
| `src/context/AuthContext.tsx` | Clear saved selections at identity boundaries |
| `src/components/summary/TransactionList.test.tsx`, `src/context/AuthContext.test.tsx`, `src/lib/transaction-filters.test.ts` | StrictMode restore/settlement, empty-URL/stale-router settlement, restored controls, stale-router clear/update and page normalization, view-only URL precedence, consecutive writes, auth gating and identity isolation, remount, offline restore, and allowlist regression coverage |
| `e2e/transaction-filter-persistence.spec.ts` | UI selection, direct-URL, clearing, tab-return, and full-load/reload restore regression tests |
| `playwright.prod.config.ts`, `e2e/serve-static.mjs` | Builds `out/` and serves the static export for the filter suite |
| `package.json`, `package-lock.json` | Production-export Playwright command and package version |
| `.gitignore` | Excludes generated Playwright test results from the working tree |
| `src/lib/version.ts`, `specs/state.yaml` | Synchronized app version and observed validation metrics |
| `README.md` | Filter behavior and development/production E2E commands |
| `specs/e2e-testing-playwright.md`, `specs/user-data-isolation.md` | Production-export coverage and identity-bound filter isolation |
| `specs/transaction-editing.md` | Clarifies that committed search queries are mirrored by the filter persistence contract |
| `specs/project-spec.md`, `specs/README.md` | Route description, test inventory, project facts, and index entry |
| `specs/transaction-filters.md` | This spec |

## 6. Verification

Hydration coverage queries Expense buttons by their exact accessible name using Testing Library's supported role-query options.

Browser smoke on `/transactions`:

1. Select a month and type filter; note the URL query.
2. Open another tab (Summary) and return via the Transactions tab.
3. Confirm the URL query and selected pills are the same.
4. Paste an explicit filtered URL and confirm it overrides the stored selection.
5. Click `Clear all`, leave the tab, return, and confirm default filters.

Focused regression tests cover restoring the mirror and visible selection through server-rendered markup hydration before persistence can clear it, filter selection, StrictMode restore without clobbering the saved mirror, stale-router settlement and control projection, rejection of stale-router settlement while the browser URL is empty, explicit URL and view-only query precedence, consecutive updates before router catch-up, stale-page normalization, clear/filter updates, identity-switch provenance, authentication cleanup, the real list remount after PIN sign-out, loading/unauthenticated persistence gates, and offline URL restore/precedence. The controller extraction moves this behavior without changing it, so the component-level suite covers the hook through the list and no hook-specific test seam was added.

`npm run test:e2e` runs all specs under `e2e/` against `next dev`, including this filter suite. `npm run test:e2e:prod` builds the static export, serves `out/` with `e2e/serve-static.mjs`, and runs only this suite in Chromium against `playwright.prod.config.ts`. The filter suite covers a visible type-filter selection mirrored to storage and restored after Settings → Transactions, direct-URL clearing, removing the last search pill, a saved-mirror full page load plus plain-URL reload, and tab returns with view-only parameters excluded.
