# Specs Index

Single source of truth for what's built, what's in progress, and what's next. Update the status column whenever a spec moves stage — don't let this drift out of sync with reality.

| Spec | Status | Notes |
|---|---|---|---|---|
| [`phase-1-budget-tracker.md`](./phase-1-budget-tracker.md) | ✅ Done | All 9 Phase 1 tasks implemented. |
| [`responsive-layout-pass.md`](./responsive-layout-pass.md) | ✅ Done | Multi-column grids on all 4 routes at `lg:`. Available Balance skipped (cash input embedded in table row). **Manual E2E check 2026-06-28:** Verified clean at 375/768/1280px. |
| [`local-first-sync-supabase.md`](./local-first-sync-supabase.md) | ✅ Done | Local-first sync with Supabase. Outbox pattern, soft-delete ghost-record prevention, LWW DB trigger, offline-first. Per-user isolation via user_id. 3-phase processSyncQueue (read/network/write). Monotonic counter for FIFO ordering. resyncAll recovery. Auto-sync debounced after every CRUD. |
| [`budget-target-persistence.md`](./budget-target-persistence.md) | ✅ Done | Hybrid (global defaults + per-month overrides). Store added to IndexedDB, in-memory store removed. |
| Settings page accessibility/coding-standards retrofit | ✅ Done | Error handling, aria-labels, aria-live, scope="col". PASS on re-review. |
| [`transaction-editing.md`](./transaction-editing.md) | ✅ Done | Edit modal with shared TransactionFormFields. Critic PASS. |
| [`e2e-testing-playwright.md`](./e2e-testing-playwright.md) | ✅ Done | Full Playwright setup: 66 tests, 6 projects (Chromium/Firefox/WebKit × mobile/tablet/desktop). |
| Show all categories in breakdowns | ✅ Done | Income/Expense tables now include zero-amount rows. |
| Ponytail-audit cleanup | ✅ Done | Shared validation (`validateTransactionForm`), shared test fixture (`tx()`), removed `totalTransfers` dead field, inlined `toLocaleString` → `formatCurrency`. Net -50 lines. |
| Summary card layout restructure | ✅ Done | Month nav pulled out to full-width above cards. Stats converted from 3-column grid to vertical list. Total count in pill badge. |
| Budget targets seed data | ✅ Done | Removed with seed data cleanup. Budget targets are set manually or imported via CSV import. |
| Transactions tab | ✅ Done | `/transactions` route created, tab added to Header nav, removed from dashboard. |
| SonarQube code quality fixes | ✅ Done | 0 ESLint errors, 0 TS errors, 42/42 tests passing. |
| [`backup-restore.md`](./backup-restore.md) | ✅ Done | JSON export/import of all 6 stores + CSV transaction export. Settings UI. |
| [`csv-import.md`](./csv-import.md) | ✅ Done | CSV import from Google Sheets. Parse, validate, preview, bulk-insert accounts/categories/transactions. Removed hardcoded seed data. Empty-state onboarding on all pages. |
| Empty state / onboarding flow | ✅ Done | All pages show "No data yet → Go to Settings → Import" when no transactions exist. Payout (standalone) excluded. |
| Seed data removal | ✅ Done | `DEFAULT_ACCOUNTS`, `DEFAULT_CATEGORIES`, `SEED_TRANSACTIONS`, `DEFAULT_BUDGET_TARGETS` removed from constants. `seedTransactionsIfEmpty()` deleted. App starts clean — user imports their own data. |
| README rewrite | ✅ Done | Boilerplate Next.js README replaced with full project docs: architecture, routes, data model, scripts, backup guidance, cloud sync setup. |
| Category reordering | ✅ Done | `sortOrder` field on Category, DB v6 migration, up/down buttons in Settings. |
| [`magic-link-auth.md`](./magic-link-auth.md) | ✅ Done | Magic-link login page + route guard. Invite-only (no public signup). No auth when Supabase not configured. Auth guard uses useEffect + router.replace() instead of inline redirect() to avoid Next.js Router hooks crash. Sign-out flow tries backgroundSync() first, warns if queue non-empty. User email in header. |
| [`user-data-isolation.md`](./user-data-isolation.md) | ✅ Done | Per-user `user_id` on all tables, new RLS, local cache wipe on user switch. Wipes existing shared data. localStorage marker (lastUserId) prevents unnecessary cache wipe on same-user refresh. Sync queue discarded on user switch (intentional). |
| Sync ordering fix (monotonic counter) | ✅ Done | Monotonic counter (`++syncSeqCounter`) in `enqueueSyncEntry()` replaces `Date.now()` to preserve FIFO ordering during bulk import. 23503 FK error resolved by ordering accounts/categories before transactions. |
| `resyncAll()` recovery | ✅ Done | Clears queue, re-enqueues all local data in dependency order (accounts → categories → … → transactions). "Re-sync all" button in Settings with confirmation dialog. |
| `ensureUuids()` slug migration | ✅ Done | Called at start of `backgroundSync()`. Converts legacy slug IDs to UUIDs in IDB. `crypto.randomUUID()` used for new records. |
| Auto-sync after CRUD | ✅ Done | Debounced `requestSync()` from `enqueueSyncEntry()` (2s debounce, dynamic import to avoid circular dep). Sync fires automatically after every local change. |
| Auth redirect fix (hooks crash) | ✅ Done | `AuthGuard` replaced `redirect()` (throws mid-render) with `useRouter().replace()` in `useEffect`, preventing "Rendered more hooks than during the previous render" crash on sign-out. |
| Migration 003 (sort_order column) | ✅ Done | `supabase/migrations/003_add_sort_order.sql` adds `sort_order INTEGER` to accounts and categories tables. Must be run on Supabase before sync will work. |
| Subcategory support | ⚪ Not yet scoped | Phase 1.5, lowest priority. |
| `phase-2-investments.md` | 🔵 Deferred | Stock Portfolio Tracker, Dividend Log, DCA Rotation Log. Out of scope until Phase 1.5 wraps. |

**Legend:** ✅ Done · 🟡 Ready to hand off · ⚪ Not yet scoped · 🔵 Deferred
