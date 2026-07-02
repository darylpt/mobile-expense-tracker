# Specs Index

Single source of truth for what's built, what's in progress, and what's next. Update the status column whenever a spec moves stage — don't let this drift out of sync with reality.

| Spec | Status | Notes |
|---|---|---|---|---|
| [`phase-1-budget-tracker.md`](./phase-1-budget-tracker.md) | ✅ Done | All 9 Phase 1 tasks implemented. |
| [`responsive-layout-pass.md`](./responsive-layout-pass.md) | ✅ Done | Multi-column grids on all 4 routes at `lg:`. Available Balance skipped (cash input embedded in table row). **Manual E2E check 2026-06-28:** Verified clean at 375/768/1280px. |
| [`local-first-sync-supabase.md`](./local-first-sync-supabase.md) | ✅ Done | Local-first sync with Supabase. Outbox pattern, soft-delete ghost-record prevention, LWW DB trigger, offline-first. 42/42 tests passing, 0 TS errors. |
| [`budget-target-persistence.md`](./budget-target-persistence.md) | ✅ Done | Hybrid (global defaults + per-month overrides). Store added to IndexedDB, in-memory store removed. |
| Settings page accessibility/coding-standards retrofit | ✅ Done | Error handling, aria-labels, aria-live, scope="col". PASS on re-review. |
| [`transaction-editing.md`](./transaction-editing.md) | ✅ Done | Edit modal with shared TransactionFormFields. Critic PASS. |
| [`e2e-testing-playwright.md`](./e2e-testing-playwright.md) | ✅ Done | Full Playwright setup: 66 tests, 6 projects (Chromium/Firefox/WebKit × mobile/tablet/desktop). |
| Show all categories in breakdowns | ✅ Done | Income/Expense tables now include zero-amount rows. |
| Ponytail-audit cleanup | ✅ Done | Shared validation (`validateTransactionForm`), shared test fixture (`tx()`), removed `totalTransfers` dead field, inlined `toLocaleString` → `formatCurrency`. Net -50 lines. |
| Summary card layout restructure | ✅ Done | Month nav pulled out to full-width above cards. Stats converted from 3-column grid to vertical list. Total count in pill badge. |
| Budget targets seed data | ✅ Done | `DEFAULT_BUDGET_TARGETS` in constants, seeded via `seedTransactionsIfEmpty` on fresh install/v3→v4 upgrade. |
| Transactions tab | ✅ Done | `/transactions` route created, tab added to Header nav, removed from dashboard. |
| SonarQube code quality fixes | ✅ Done | 0 ESLint errors, 0 TS errors, 42/42 tests passing. |
| [`backup-restore.md`](./backup-restore.md) | ✅ Done | JSON export/import of all 6 stores + CSV transaction export. Settings UI. |
| Subcategory support | ⚪ Not yet scoped | Phase 1.5, lowest priority. |
| `phase-2-investments.md` | 🔵 Deferred | Stock Portfolio Tracker, Dividend Log, DCA Rotation Log. Out of scope until Phase 1.5 wraps. |

**Legend:** ✅ Done · 🟡 Ready to hand off · ⚪ Not yet scoped · 🔵 Deferred
