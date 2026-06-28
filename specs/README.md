# Specs Index

Single source of truth for what's built, what's in progress, and what's next. Update the status column whenever a spec moves stage — don't let this drift out of sync with reality.

| Spec | Status | Notes |
|---|---|---|---|
| [`phase-1-budget-tracker.md`](./phase-1-budget-tracker.md) | ✅ Done | All 9 Phase 1 tasks implemented. |
| [`responsive-layout-pass.md`](./responsive-layout-pass.md) | ✅ Done | Multi-column grids on all 4 routes at `lg:`. Available Balance skipped (cash input embedded in table row). **Manual E2E check 2026-06-28:** Verified clean at 375/768/1280px — all denomination inputs interactable, toggle button works, total/Difference recalculate correctly at all widths. |
| [`budget-target-persistence.md`](./budget-target-persistence.md) | ✅ Done | Hybrid (global defaults + per-month overrides). Store added to IndexedDB, in-memory store removed. 40 tests passing. |
| Settings page accessibility/coding-standards retrofit | ✅ Done | All findings resolved — error handling, aria-labels, aria-live, scope="col", error handling in hooks. PASS on re-review. |
| [`transaction-editing.md`](./transaction-editing.md) | ✅ Done | Edit modal with shared TransactionFormFields. All 40 tests passing. Critic PASS. |
| [`e2e-testing-playwright.md`](./e2e-testing-playwright.md) | ✅ Done | Full Playwright setup: config, deps, 66 tests (4 spec files × 6 projects: Chromium/Firefox/WebKit + mobile/tablet/desktop viewports). Tests: Quick Add→Summary sync (§2.1), Settings delete-blocked (§2.2), Payout calculator (§2.3), viewport-width variants (§2.4), budget target persistence (§2.5). Run with `npm run test:e2e`. |
| Income/Expense breakdowns — show all categories | ⚪ Not yet scoped | Phase 1.5, lower priority. Currently only categories with activity are shown. |
| Subcategory support | ⚪ Not yet scoped | Phase 1.5, lowest priority. |
| `phase-2-investments.md` | 🔵 Deferred | Stock Portfolio Tracker, Dividend Log, DCA Rotation Log. Out of scope until Phase 1.5 wraps. |

**Legend:** ✅ Done · 🟡 Ready to hand off · ⚪ Not yet scoped · 🔵 Deferred

---

## Recommended order

1. ✅ **Responsive layout pass** — done.
2. ✅ **Budget target persistence** — done.
3. ✅ **Settings retrofit** — done.
4. ✅ **Transaction editing** — done.
5. 🟡 **E2E testing (Playwright)** — delegated to Coder.
6. ⚪ **Show all categories in breakdowns** — cosmetic, low priority.
7. ⚪ **Subcategory support** — lowest priority.
8. 🔵 **Phase 2 (investments)** — deferred.
