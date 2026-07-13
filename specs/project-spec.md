# Unified Project Spec — mobile-expense-tracker v2.0

> Merged from 12 individual spec files. Single source of truth.
> Compiled: 2026-07-13. Status: all Phase 1 features done. Phase 2 deferred.

---

## 1. What This Is

A **local-first personal finance PWA** that replaces a Google Sheets budget tracker. Data lives in IndexedDB on-device (works fully offline). Optional Supabase cloud sync for cross-device use. **v0.2.15**, actively used since June 2026.

---

## 2. Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16.2.9 (App Router) |
| UI | React 19.2.4, Tailwind CSS 4 |
| Storage | IndexedDB via `idb` v8 |
| Cloud Sync | Supabase (Postgres + Auth + REST) |
| Auth | Supabase Auth (magic link, invite-only) |
| Language | TypeScript strict |
| Unit Tests | Jest 30 + ts-jest + jsdom + fake-indexeddb |
| E2E Tests | Playwright 1.61 (3 browsers × 3 viewports = 6 projects) |
| Linting | ESLint 9 + eslint-config-next |

**Zero server-side code.** Every component is `'use client'`. No API routes, no server components, no server actions.

---

## 3. Data Model

### 3.1 IndexedDB Stores (7 total)

| Store | Key | Purpose |
|---|---|---|
| `transactions` | UUID | Income, expense, and transfer records |
| `accounts` | UUID | Named accounts with starting balance + sort order |
| `categories` | UUID | Categorized by type (income/expense/transaction) + sort order |
| `cashDenominations` | UUID | Per-date snapshots of cash on hand by denomination |
| `payouts` | UUID | Saved payout calculations |
| `budgetTargets` | UUID | Per-category planned amounts (global default or per-month override) |
| `syncQueue` | auto-increment | Pending outbound sync entries (FIFO by monotonic counter) |

**DB version:** 9 (current). Migrations v2→v9 handled in `idb.ts` upgrade callback.

### 3.2 Transaction Record

| Field | Type | Notes |
|---|---|---|
| id | string (uuid) | |
| date | ISO date | |
| amount | number (decimal-safe) | |
| description | string | |
| type | `'income' \| 'expense' \| 'transaction'` | Renamed from legacy 'Transfer' |
| category | string | References income/expense/transfer list |
| fromAccount | string \| null | Account id; null for pure income |
| toAccount | string \| null | Account id; null for pure expense |
| createdAt, updatedAt | number | Timestamps |

**Validation rules:**
- `type = income` → `toAccount` required, `fromAccount` null, `category` from income list
- `type = expense` → `fromAccount` required, `toAccount` optional (set for Savings/Investment categories)
- `type = transaction` → both `fromAccount` and `toAccount` required, must differ

### 3.3 Account Record

| Field | Type |
|---|---|
| id | string |
| name | string |
| startingBalance | number |
| sortOrder | integer |
| createdAt, updatedAt | number |

### 3.4 Category Record

| Field | Type |
|---|---|
| id | string |
| name | string |
| type | `'income' \| 'expense' \| 'transaction'` |
| sortOrder | integer |
| createdAt, updatedAt | number |

### 3.5 CashDenomination Snapshot

| Field | Type |
|---|---|
| id | string |
| date | ISO date |
| denomination | number (bill/coin value) |
| count | number |

### 3.6 Payout Record

| Field | Type |
|---|---|
| id | string |
| date | ISO date |
| totalAmount | number |
| splitMode | `'amount' \| 'percentage'` |
| splits | `{ person: string, value: number }[]` |
| savingsSubSplit | `{ emergencyPct, wantsPct, investmentPct, motorPct }` |

### 3.7 BudgetTarget Record

| Field | Type | Notes |
|---|---|---|
| id | string (uuid) | |
| category | string | References an Expense category |
| month | string \| null | `"YYYY-MM"` or `null` for global default |
| amount | number | The "Planned" value |
| createdAt, updatedAt | number | |

**Lookup logic (category + month):**
1. Look for `category = cat AND month = targetMonth`
2. If not found, look for `category = cat AND month IS NULL`
3. If neither found, return 0

---

## 4. Supabase Schema

All 6 data stores map 1:1 to Supabase Postgres tables. Each has:
- `user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE`
- `created_at TIMESTAMPTZ`
- `updated_at TIMESTAMPTZ` (with LWW trigger)
- `deleted_at TIMESTAMPTZ` (soft-delete)
- Per-user RLS policies (SELECT/INSERT/UPDATE/DELETE gated on `auth.uid() = user_id`)

### LWW Trigger (all tables with updated_at)

```sql
CREATE OR REPLACE FUNCTION prevent_older_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.updated_at <= OLD.updated_at THEN RETURN NULL; END IF;
  RETURN NEW;
END;
$$;
```

### Migrations (run sequentially on Supabase)

1. `001_schema.sql` — tables, LWW trigger, initial RLS
2. `002_user_isolation.sql` — TRUNCATE, user_id column, per-user RLS
3. `003_add_sort_order.sql` — sort_order on accounts + categories

---

## 5. Sync Architecture (Outbox Pattern)

1. Every local CRUD **atomically** enqueues a sync entry inside the same IDB transaction
2. Monotonic counter (`syncSeqCounter`) ensures strict FIFO ordering
3. Background sync runs in 3 phases: Read → Network → Write
4. Auto-sync fires 2 seconds after every CRUD (debounced `requestSync()`)
5. Conflict resolution: Last-Writer-Wins by `updated_at` (LWW trigger on Supabase)
6. Soft-delete: "Delete" sets `deleted_at`, never hard-deletes from REST API
7. `resyncAll()` recovery: clears queue, re-enqueues in dependency order
8. `ensureUuids()`: one-shot migration from legacy slug IDs to `crypto.randomUUID()`
9. `syncInFlight` guard prevents concurrent sync cycles

---

## 6. Auth Lifecycle

- Supabase not configured → `state = 'disabled'`, app works fully offline
- Authenticated → `lastUserId` localStorage marker prevents unnecessary cache wipe on same-user refresh
- User switch detected → `clearAllLocalData()` + discard sync queue + re-pull
- Sign-out → tries `backgroundSync()` first, warns if queue non-empty
- Route guard uses `useRouter().replace()` in `useEffect` (not `redirect()` mid-render)

### UX Flow

```
User opens app
  ├─ Supabase not configured? → No auth. App works as today.
  └─ Supabase configured?
       ├─ Has valid session? → Dashboard
       └─ No session → /login page
            ├─ Enter email → "Send magic link"
            ├─ Email sent → "Check your inbox"
            └─ Click magic link → PKCE exchange → redirected back → session → dashboard
```

Invite-only model — no sign-up form. Users invited via Supabase dashboard.

---

## 7. Routes / Screens

| Route | Purpose | Key Features |
|---|---|---|
| `/login` | Magic-link sign-in | Invite-only, disabled when Supabase not configured |
| `/` | Summary / Dashboard | Month nav, 4 metric cards, Accounts table, Income/Expenses breakdowns with budget targets, Category/Account breakdown charts. Mobile: grouped CategoryBreakdown with progress bars, collapsed Quick Add |
| `/transactions` | Transaction List | URL search-param filtering (type, month, account, category, text), date grouping toggle, pagination (50/page), edit modal, inline delete. Mobile: card layout. Desktop: table layout |
| `/available-balance` | Cash Reconciliation | Per-account expected balance to user-selected date. Cash: denomination breakdown grid (₱1000→₱1). Difference column. Read-only |
| `/payout` | Payout Calculator | Standalone calc (no ledger writes). Percentage/flat-amount mode. Savings sub-split. Saves to IDB |
| `/settings` | Settings | Accounts CRUD + reorder, Categories CRUD + reorder, Tab Visibility toggle, Cloud Sync controls, Sign-out, Backup & Restore (JSON export/import, CSV export, CSV import from Google Sheets) |

### Responsive Layout

- **Mobile (<768px):** Single column, fixed bottom tab bar (5 tabs, z-20, safe-area-inset), card layouts for Settings, collapsible Quick Add
- **Tablet (md: 768px+):** Light adjustments (side-by-side fields)
- **Desktop (lg: 1024px+):** Multi-column grids, wider max-width container (`max-w-7xl mx-auto`)

---

## 8. CSV Import

### Input Format

```
Date,Amount,Description,Type,Category,From Account,To Account
```

- Date: `M/D/YYYY` (US format, auto-detected EU if day > 12)
- Amount: `₱1,234.56` or plain number
- Type: `Income`, `Expense`, `Transfer` (for transaction-type rows)

### Mapping Logic

- **Carry Over rows** → account starting balances (one-time, first month only)
- **Regular rows** → transactions (type mapped from CSV Type column)
- **Account creation** from unique names, slug-based IDs
- **Category creation** with auto-detected type from CSV Type values

---

## 9. Backup / Restore

- **JSON export** — all 6 stores as single portable file
- **CSV export** — transactions only, for spreadsheet analysis
- **JSON import** — full restore from previously exported file (clear-and-replace)
- **CSV import** — from Google Sheets format (see §8)

---

## 10. Test Structure

### Unit Tests (Jest)

| File | Focus |
|---|---|
| `src/lib/aggregations.test.ts` | Account balance computation, income/expense breakdowns |
| `src/lib/idb.test.ts` | IDB CRUD operations, sync queue, migrations |
| `src/lib/csv-import.test.ts` | CSV parsing, date detection, amount parsing, carry-over logic |
| `src/lib/reconciliation.test.ts` | Expected balance computation |
| `src/hooks/useTransactions.test.ts` | Derived view hooks |

### E2E Tests (Playwright)

| File | Focus |
|---|---|
| `e2e/quick-add-summary.spec.ts` | Quick Add → Summary sync |
| `e2e/settings-delete-blocked.spec.ts` | Delete-blocked-if-in-use |
| `e2e/payout-calculator.spec.ts` | Payout calculator flows |
| `e2e/budget-target-persistence.spec.ts` | Budget target reload persistence |

**42/42 unit tests passing. 0 ESLint errors, 0 TS errors.**

---

## 11. Spec Status

### Completed (all done)

| Spec | Status |
|---|---|
| Phase 1 Budget Tracker | ✅ All 9 tasks |
| Responsive Layout Pass | ✅ Multi-column grids on all 4 routes |
| Local-First Sync (Supabase) | ✅ Outbox pattern, LWW, per-user isolation |
| Budget Target Persistence | ✅ Hybrid global defaults + per-month overrides |
| Transaction Editing | ✅ Edit modal with shared TransactionFormFields |
| E2E Testing (Playwright) | ✅ 66 tests, 6 projects |
| Magic-Link Auth | ✅ Invite-only, useEffect-based route guard |
| User Data Isolation | ✅ user_id on all tables, RLS, cache wipe on user switch |
| Backup & Restore | ✅ JSON export/import, CSV export/import |
| CSV Import | ✅ Google Sheets format, carry-over→starting balance |
| Codebase Audit | ✅ 21 findings resolved |
| Empty State / Onboarding | ✅ All pages show import guidance when empty |
| Seed Data Removal | ✅ App starts clean |
| Category Reordering | ✅ sortOrder field, DB v6 migration |
| Bottom Tab Bar | ✅ Mobile fixed bottom nav |

### Deferred

| Spec | Status |
|---|---|
| Phase 2 — Stock Portfolio Tracker | 🔵 Deferred (ticker, shares, cost basis, DCA rotation log) |

---

## 12. Known Design Decisions

| Decision | Rationale |
|---|---|
| `idb.ts` unsplit (~1155 lines) | DB code is tightly coupled. Splitting scatters without benefit. |
| `useAccounts`/`useCategories` not generic | Meaningful differences between them. Generic adds more code than it saves. |
| `redirect()` replaced with `router.replace()` | Next.js 16 throws mid-render, corrupts hooks ordering. |
| Payout doesn't create ledger transactions | Calculator only. Phase 1 scope. User confirmed. |
| Sync queue discarded on user switch | Intentional: unsynced offline changes from another user should not pollute new user's queue. |
| `lastUserId` localStorage marker | Prevents full cache wipe + re-pull on same-user page refresh. |
| Monotonic counter for sync ordering | `Date.now()` collides during bulk import. `++syncSeqCounter` guarantees FIFO. |

---

## 13. What's Left

- **Phase 2 (deferred):** Stock Portfolio Tracker, Dividend Log, DCA Rotation Log
- **No CI pipeline** — tests run locally before manual releases
- **No auto-backup** — user must export manually; Supabase sync provides cross-device redundancy
