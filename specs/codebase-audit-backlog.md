# Spec: Codebase Audit Backlog

**Status:** ✅ Done (P1 fixed 2026-07-10, P2 resolved 2026-07-11, P3/critic resolved 2026-07-11)

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

## Should improve / P2 — All resolved 2026-07-11

### ✅ P2-1 — `enqueueSyncEntry<T>` generic (was 28 casts)

**Fixed:** Signature is now `enqueueSyncEntry<T>(storeName, recordId, operation, payload: T | null)`. Two remaining casts in `sync.ts:208,219` are IDB internal `unknown` records — unavoidable without over-engineering.

**Files:**
- `src/lib/idb.ts:346` — generic signature
- `src/lib/idb.ts` — all call sites pass typed entities directly

---

### ⏭️ P2-2 — `idb.ts` ~1155 lines — Won't fix

**Decision:** File is well-organized with clear section comments. Splitting into 6+ modules scatters tightly coupled DB code (schema versioning, migrations, CRUD, sync queue, export/import). Risk of regression in IndexedDB interactions outweighs organizational benefit. Not worth the churn.

---

### ⏭️ P2-3 — `useAccounts`/`useCategories` boilerplate — Won't fix

**Decision:** Hooks look similar but have meaningful differences: `useAccounts` calls `ctx.refreshTransactions()` after every CRUD (categories don't), and `useCategories` has `getCategoriesByType`. A generic hook would need config params for these differences, adding more code than it removes. Two clear 110-line files are easier to follow than one generic + two wrappers.

---

### ✅ P2-4 — Focus trap in `EditTransactionModal`

**Fixed:** Full focus trap implemented with Tab/Shift+Tab cycling between first and last focusable elements, Escape key handler, auto-focus on open.

**Files:**
- `src/components/forms/EditTransactionModal.tsx:60-101`

---

### ✅ P2-5 — `aria-live` for filter results

**Fixed:** `<div aria-live="polite" aria-atomic="true" className="sr-only">` announces filtered transaction count. Shows "No transactions match your filters." when zero results.

**Files:**
- `src/components/summary/TransactionList.tsx:307-311`

---

### ✅ P2-6 — CSV import truncation warning

**Fixed:** `CsvSummary.truncated` flag set when rows exceed `MAX_ROWS` (2000). `CsvImportPreview` renders amber warning: "CSV was capped at X rows (max 2,000). Split your data into smaller files to import everything."

**Files:**
- `src/lib/csv-import.ts:172,44` — `truncated` flag
- `src/components/forms/CsvImportPreview.tsx:78-82` — warning banner

---

## Nice to have / P3 — All resolved 2026-07-11

### ✅ P3-1 — Inline `formatDate()` into `getToday()`

**Fixed:** Already inlined in a prior session. `getToday()` uses inline date logic directly.

**Files:**
- `src/lib/utils.ts`

---

### ✅ P3-2 — `MonthYear.month` is 0-indexed, undocumented

**Fixed:** Added JSDoc comment `/** 0-indexed month (0 = January, 11 = December) */` to the `month` field.

**Files:**
- `src/types/index.d.ts:142`

---

### ⏭️ P3-3 — Payout naming inconsistency — Won't fix

**Decision:** `subSplit` (boolean flag on `SplitRow`) and `savingsSubSplit` (persisted field on `Payout` type) serve different purposes. Renaming would confuse semantics, not clarify them.

---

### ⏭️ P3-4 — eslint-disable suppressions — Won't fix

**Decision:** Only 2 remain: `no-var` in test file (Jest requires `var`), `set-state-in-effect` in `EditTransactionModal` (intentional — modal stays mounted, state update in effect is deliberate). Both are legitimate with explanatory comments.

---

## Full-codebase critic review — All resolved 2026-07-11

Second-pass critic review found 21 issues across the entire codebase. All 21 resolved (18 fixed, 3 won't-fix).

### ✅ CRIT-1 — REVERSE_FIELD_MAP overwrite (critical)

Identity entries in `FIELD_MAP` (`created_at: 'created_at'`) overwrote correct reverse mappings. Pulled Supabase records got key `created_at` instead of `createdAt`, breaking sort, LWW, and all timestamp logic.

**Fix:** Removed identity entries from `FIELD_MAP`. `camelToSnake`/`snakeToCamel` already pass through unmapped keys.

**File:** `src/lib/sync.ts:43-46`

### ✅ CRIT-2 — Supabase API errors silently ignored (critical)

`.upsert()` and `.update()` resolve with `{data, error}` — don't throw on API errors. Failures fell through to `drops.push()`, permanently removing entries from the sync queue.

**Fix:** Capture `{ error }` from both calls and throw, so failures hit the retry path.

**File:** `src/lib/sync.ts:119-133`

### ✅ CRIT-3 — deleteCashDenominationsByDate missing sync entries (high)

Cursor loop deleted records without enqueuing sync entries. Deleted records reappeared from Supabase on next pull (phantom duplicates).

**Fix:** Added `enqueueSyncEntry` inside the cursor loop before `cursor.delete()`.

**File:** `src/lib/idb.ts:676`

### ✅ CRIT-4 — importFromCsv stale sync queue entries (high)

CSV import cleared stores and re-added with new UUIDs, but old sync queue entries remained. Old-ID payloads created ghost records on Supabase.

**Fix:** Clear sync queue entries for ACCOUNTS/CATEGORIES/TRANSACTIONS before re-enqueuing.

**File:** `src/lib/idb.ts:1144-1161`

### ✅ CRIT-5 — Context value not memoized (high)

Context `value` object constructed inline on every render — all consumers re-rendered on any provider state change.

**Fix:** Wrapped in `useMemo` with explicit dependencies.

**File:** `src/context/TransactionContext.tsx:244-259`

### ✅ CRIT-6 — Auth lifecycle race condition (high)

Auth lifecycle effect spawned fire-and-forget async chains with no cancellation guard. Concurrent chains could race during auth state transitions.

**Fix:** Added `cancelled` flag with checks after each async gap.

**File:** `src/context/TransactionContext.tsx:139-173`

### ⏭️ CRIT-7 — Duplicate accounts/categories state (high) — Won't fix

`useAccounts`/`useCategories` maintain independent state from `TransactionContext`. Design choice — hooks are standalone. CRIT-5 (memoization) already addresses the performance concern.

### ✅ CRIT-8 — userScalable: false blocks pinch-to-zoom (high)

WCAG 1.4.4 violation. Users with low vision cannot zoom.

**Fix:** Removed `userScalable: false`, changed `maximumScale: 1` → `maximumScale: 5`.

**File:** `src/app/layout.tsx:25-30`

### ✅ CRIT-9 — Missing aria-labels on available-balance inputs (high)

3 raw `<input type="number">` elements with no label or aria-label.

**Fix:** Added `aria-label` to all 3 inputs.

**File:** `src/app/available-balance/page.tsx:137,156,236`

### ✅ CRIT-10 — Missing aria-labels on TransactionList filters (high)

5 filter controls (2 account selects, 1 category select, 2 search inputs) with no labels.

**Fix:** Added `aria-label` to all 5 controls.

**File:** `src/components/summary/TransactionList.tsx:449,455,503,507,513`

### ✅ CRIT-11 — ensureUuids runs on every sync cycle (medium)

`ensureUuids()` does a full O(accounts+categories) scan every time `backgroundSync()` runs. Since it's a one-shot migration, subsequent runs are pure waste.

**Fix:** Added `localStorage.getItem('uuid_migration_done')` guard at the top of the function. Sets the flag after successful completion.

**File:** `src/lib/idb.ts:969-971, 1051`

### ✅ CRIT-12 — importFromCsv only clears 3 of 6 stores (medium)

CSV import replaced accounts, categories, and transactions but left stale cash denominations, payouts, and budget targets from the previous import.

**Fix:** Expanded the transaction to clear all 6 stores. Sync queue cleanup also expanded to cover entries from all stores.

**File:** `src/lib/idb.ts:1115-1172`

### ✅ CRIT-13 — useAccounts useCallback deps include entire context (medium)

Three `useCallback` hooks depended on `ctx` (the entire context object), which is recreated every render via spread. Caused unnecessary re-renders of consuming components.

**Fix:** Changed dependencies to `[refresh, ctx.refreshTransactions]` — `ctx.refreshTransactions` is a stable `useCallback` reference.

**File:** `src/hooks/useAccounts.ts:63, 75, 87`

### ✅ CRIT-14 — Duplicate fetch logic in TransactionContext (medium)

Mount `useEffect` duplicated the fetch logic in `refreshTransactions` (getAllTransactions + getAllAccounts + getAllCategories + error handling + loading state).

**Fix:** Replaced mount effect with `refreshTransactions()` call. The `useCallback` is stable (empty deps), so the effect runs once on mount.

**File:** `src/context/TransactionContext.tsx:100-102`

### ✅ CRIT-15 — Settings toggle switch has no accessible name (medium)

The `<button role="switch">` inside `ToggleSwitch` had no accessible name. Parent `<label>` wrapping doesn't provide implicit labeling for `<button>` elements (only for form controls).

**Fix:** Added `aria-label={label}` to the switch button.

**File:** `src/app/settings/page.tsx:1043`

### ✅ CRIT-16 — Mobile nav has no aria-current (medium)

The bottom tab bar buttons had no `aria-current="page"` on the active tab.

**Fix:** Added `aria-current={isActive ? 'page' : undefined}` to each tab button.

**File:** `src/components/layout/Header.tsx:308`

### ✅ CRIT-17 — Duplicate h2 headings on desktop (medium)

TransactionList had an unconditional `<h2>Transactions</h2>` (visible on both breakpoints) plus a second `<h2>` inside `hidden lg:flex`. On desktop, both were visible.

**Fix:** Added `lg:hidden` to the first `<h2>`.

**File:** `src/components/summary/TransactionList.tsx:296`

### ✅ CRIT-18 — parseDate allows invalid day-per-month (low)

`parseDate()` used `day > 31` as the only range check. Feb 30, Apr 31, etc. passed validation.

**Fix:** Replaced with `new Date(year, month, 0).getDate()` to get the actual last day of the month.

**File:** `src/lib/csv-import.ts:130-131`

### ✅ CRIT-19 — UUID remap silently keeps raw account names (low)

If an account name in CSV transactions didn't match any existing account, the fallback `?? t.fromAccount` left the raw name in place — silently breaking UUID-based data integrity.

**Fix:** Explicit throw with descriptive error message identifying the problematic account.

**File:** `src/lib/csv-import.ts:359-367`

### ✅ CRIT-20 — Redundant dynamic import in settings export (low)

`handleExportCsv` used `await import('@/lib/idb')` to get `getAllTransactions`, but it was already statically imported at the top of the file.

**Fix:** Removed the redundant dynamic import.

**File:** `src/app/settings/page.tsx:1083-1098`

### ✅ CRIT-21 — Button component has no default type (low)

The `<button>` in `Button.tsx` had no `type` attribute, defaulting to `"submit"` per HTML spec. Could cause accidental form submissions.

**Fix:** Added `type="button"` default. Callers can override via `{...rest}` spread.

**File:** `src/components/common/Button.tsx:47`

---

## Legend

**Status:** ✅ Done · ⏭️ Won't fix · ⚪ Not yet scoped · 🔵 Deferred
**Priority:** P1 = data/correctness bug · P2 = should improve · P3 = nice to have
