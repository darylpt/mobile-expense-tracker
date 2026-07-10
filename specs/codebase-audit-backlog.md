# Spec: Codebase Audit Backlog

**Status:** 🟡 Ready to hand off (actionable findings)

---

## Objective

Track every bug, design gap, and code-quality finding from the 2026-07-10 comprehensive codebase audit. Items are ranked by impact: P1 (data / correctness bug), P2 (should improve), P3 (nice to have). This spec is the reference — items graduate to their own spec when scoped for a sprint.

---

## What to fix before production / P1

### P1-1 — Categories stale after background sync

**Problem:**
`TransactionContext.tsx:166` syncs only transactions + accounts after `backgroundSync()`. Categories are independently managed by `useCategories` hook. If remote categories are created/modified/deleted, the UI won't reflect changes until Settings page remounts.

**Proposed fix:**
Add a `refreshCategories` callback to `TransactionContext`, or include `getAllCategories()` in the `refreshTransactions()` call chain.

**Files:**
- `src/context/TransactionContext.tsx` — add categories to refresh
- `src/hooks/useCategories.ts` — consume the refreshed list

---

### P1-2 — CSV date parser assumes MM/DD/YYYY

**Problem:**
`csv-import.ts:107` splits date strings on `/` and hardcodes month / day positions (`parts[0]` = month, `parts[1]` = day). A user whose bank or locale exports DD/MM/YYYY gets silently swapped dates.

**Proposed fix:**
Detect format from the first parseable row: if first segment > 12 then treat as DD/MM/YYYY, else treat as MM/DD/YYYY. Alternatively, add a format hint dropdown in the CSV upload UI.

**Files:**
- `src/lib/csv-import.ts` ~line 107 — date parsing logic
- `src/components/forms/CsvImportPreview.tsx` — optional format selector

---

### P1-3 — 13 `console.error` calls, only 1 reaches the user

**Problem:**
Errors from `useAccounts`, `useCategories`, `TransactionContext`, and IDB operations are logged to console but never surfaced to the user. Only `TransactionList.tsx` renders `ctx.error`. Users have no feedback when save/delete/sync fails.

**Proposed fix:**
Surface errors globally — either a toast component or an inline error banner in the layout that reads from a shared error state (React context or a lightweight event emitter).

**Files:**
- `src/context/TransactionContext.tsx` — error always in context but not rendered
- `src/hooks/useAccounts.ts` — errors logged, never shown
- `src/hooks/useCategories.ts` — same
- `src/app/layout.tsx` — possible insertion point for global error banner

---

### P1-4 — Account / category delete orphans references

**Problem:**
Deleting an account or category does NOT update transactions that reference it. `fromAccount`, `toAccount`, and `category` fields become dangling IDs/strings. The Settings UI does check `getAllTransactions()` before deleting (accounts line 336, categories line 691) and blocks deletion if references exist, but no migration path exists for already-orphaned records.

**Proposed fix (minimal):**
Document that the Settings UI already prevents deletion of referenced entities. For already-orphaned records, add a one-shot migration script.

**Files:**
- `src/app/settings/page.tsx` — UI guard exists (lines 336, 691)
- `src/lib/idb.ts` — no referential integrity enforcement

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
