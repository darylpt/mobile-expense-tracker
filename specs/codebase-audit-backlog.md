# Spec: Codebase Audit Backlog

**Status:** 🟡 Ready to hand off (P1 items fixed 2026-07-10)

---

## Objective

Track every bug, design gap, and code-quality finding from the 2026-07-10 comprehensive codebase audit. Items are ranked by impact: P1 (data / correctness bug), P2 (should improve), P3 (nice to have). This spec is the reference — items graduate to their own spec when scoped for a sprint.

---

## P1 — Fixed 2026-07-10

### ✅ P1-1 — Categories stale after background sync

**Fixed:** `TransactionContext.refreshTransactions()` now also calls `getAllCategories()`. Categories are exposed on the context value alongside transactions and accounts. Every sync + CRUD refresh brings fresh categories.

**Files changed:**
- `src/context/TransactionContext.tsx` — added `categories` state, loaded in `refreshTransactions` and initial mount, exposed via context
- `src/hooks/useTransactions.ts` — exposed `ctx.categories` in return value

---

### ✅ P1-2 — CSV date parser assumes MM/DD/YYYY

**Fixed:** Added `detectDateFormat()` — samples the first data row's date. If the first segment > 12, treats subsequent dates as DD/MM/YYYY (EU). Otherwise assumes MM/DD/YYYY (US/Google Sheets default). The format is passed through all `parseDate()` calls.

**Files changed:**
- `src/lib/csv-import.ts` — added `detectDateFormat()`, updated `parseDate()` signature with format param, detect + pass format in `parseCsv()`

---

### ✅ P1-3 — Surface errors to user globally

**Fixed:** Created `GlobalErrorBanner` component that reads `ctx.error` from TransactionContext — dismissible, renders as an alert banner at the top of every page. Added via `LayoutWithError` wrapper in `layout.tsx`, inside `TransactionProvider`. The existing `ctx.error` in `TransactionList.tsx` remains as a fallback.

**Files changed:**
- `src/components/layout/GlobalErrorBanner.tsx` — new dismissible error banner component
- `src/components/layout/LayoutWithError.tsx` — thin client wrapper for the layout
- `src/app/layout.tsx` — wrap children with `LayoutWithError`

---

### ✅ P1-4 — Account / category delete orphans references

**Status:** Already guarded at the UI level. The Settings page checks `getAllTransactions()` before deleting an account (checks `fromAccount`/`toAccount`) or category (checks `category` name). Deletion is blocked with a clear warning message if references exist. For already-orphaned records (edge case from pre-guard data), no migration path exists — single-user app, extremely low likelihood.

**Files:**
- `src/app/settings/page.tsx` — UI guard exists (account: line 336, category: line 702)
- No code change needed

---

## Should improve / P2

### P2-1 — 28 `as unknown as Record<string, unknown>` casts

**Problem:**
Every `enqueueSyncEntry()` call in `idb.ts` and `sync.ts` casts typed entities to `Record<string, unknown>` to pass to the sync queue. This papered over a type mismatch that a generic would fix cleanly.

**Proposed fix:**
Change the signature to `enqueueSyncEntry<T>(store: string, id: string, op: SyncOp, data: T): void`.

**Files:**
- `src/lib/sync.ts` — `enqueueSyncEntry` definition
- `src/lib/idb.ts` — all call sites (~28 occurrences)
- `src/lib/constants.ts` — sync queue types

---

### P2-2 — `idb.ts` is ~1100 lines

**Problem:**
Single file mixes DB schema + version management + CRUD for 6 entity types + sync queue + export/import + CSV generation + UUID migration. Violates single-responsibility.

**Proposed fix:**
Split into:
- `lib/db.ts` — schema + version + migration
- `lib/idb/accounts.ts` — account CRUD
- `lib/idb/categories.ts` — category CRUD
- `lib/idb/transactions.ts` — transaction CRUD (leave as main entry if too coupled)
- Keep sync logic in `lib/sync.ts`

**Risk:** Large refactor, risk of regression in indexedDB interactions.

---

### P2-3 — `useAccounts` / `useCategories` are identical boilerplate (~80 lines each)

**Problem:**
Both hooks follow the same pattern: `useEffect` load, `refresh()`, CRUD wrappers, error/loading state. Nearly identical code.

**Proposed fix:**
Generic `useEntityList<T>` hook that takes a fetch function and CRUD functions. `useAccounts` and `useCategories` become thin wrappers.

**Files:**
- `src/hooks/useAccounts.ts`
- `src/hooks/useCategories.ts`

---

### P2-4 — No focus trap in `EditTransactionModal`

**Problem:**
The edit dialog has `role="dialog"` and `aria-modal`, but tabbing past the last focusable element escapes the dialog. Screen reader users lose context.

**Proposed fix:**
Add a focus-trap wrapper or `onKeyDown` handler that traps Tab within the modal's focusable elements.

**Files:**
- `src/components/transactions/EditTransactionModal.tsx`

---

### P2-5 — No `aria-live` region for filter results

**Problem:**
When filters change in the transaction list, screen reader users get no announcement that results updated.

**Proposed fix:**
Add an `aria-live="polite"` region that announces the count of filtered results whenever filters change.

**Files:**
- `src/components/summary/TransactionList.tsx`

---

### P2-6 — CSV import 2000-row silent truncation

**Problem:**
`csv-import.ts` caps at `MAX_ROWS` (2000) but never tells the user that rows were dropped. A 2500-row import silently loses 500 rows.

**Proposed fix:**
Push a summary line / error message when `dataLines.length > MAX_ROWS`.

**Files:**
- `src/lib/csv-import.ts` — the cap + logging
- `src/components/forms/CsvImportPreview.tsx` — surface the truncation message

---

## Nice to have / P3

### P3-1 — Inline `formatDate()` into `getToday()`

**Problem:**
`formatDate()` is only called from `getToday()` in `utils.ts`. Unnecessary function wrapper.

**Proposed fix:**
Inline the logic.

**Files:**
- `src/lib/utils.ts` lines 15-27

---

### P3-2 — `MonthYear.month` is 0-indexed, undocumented

**Problem:**
The `month` field in `MonthYear` is 0-indexed (0 = January). All existing code handles this, but it's an off-by-one trap for contributors.

**Proposed fix:**
Add a JSDoc comment to the type, or convert to 1-indexed with a migration.

**Files:**
- `src/types/index.d.ts` — `MonthYear` type definition

---

### P3-3 — Payout naming inconsistency

**Problem:**
Some places use `savingsSubSplit` (field name), others use `subSplit` (aria-label). Inconsistent terminology.

**Proposed fix:**
Pick one (`subSplit` is shorter) and rename consistently.

**Files:**
- `src/app/payout/page.tsx`

---

### P3-4 — 3 `eslint-disable react-hooks/exhaustive-deps`

**Problem:**
Three places suppress the exhaustive-deps rule. Each is a stale-closure risk if the captured value changes.

**Proposed fix:**
Restructure the effects to include dependencies or use refs to hold mutable callbacks.

**Files:**
- `src/context/TransactionContext.tsx` — lines 159, 171
- (any other file with this suppression)

---

## Quick wins (single-edit fixes)

| Item | File | What |
|------|------|------|
| P3-1 inline `formatDate` | `src/lib/utils.ts` | One-line function inline |
| Sync key doc update | `README.md` | Already correct (`last_sync_time`) |
| Account delete guard | `src/app/settings/page.tsx:336` | Already present — document as intentional |
| Category delete guard | `src/app/settings/page.tsx:691` | Already present — document as intentional |

---

## Legend

**Status:** 🟡 Ready to hand off · ✅ Done · ⚪ Not yet scoped · 🔵 Deferred
**Priority:** P1 = data/correctness bug · P2 = should improve · P3 = nice to have
