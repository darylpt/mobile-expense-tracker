# Unified Project Spec — mobile-expense-tracker v2.0

> Project overview; detailed feature contracts are linked from the [specs index](README.md).
> Compiled: 2026-10-30. Status: all Phase 1 and Phase 2 features done.

---

## 1. What This Is

A **local-first personal finance PWA** that replaces a Google Sheets budget tracker. Data lives in IndexedDB on-device (works fully offline). Optional Supabase cloud sync for cross-device use. Actively used since June 2026; current release: [`APP_VERSION`](../src/lib/version.ts).

---

## 2. Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16.2.9 (App Router) |
| UI | React 19.2.4, Tailwind CSS 4 |
| Storage | IndexedDB via `idb` v8 |
| Cloud Sync | Supabase (Postgres + Auth + REST) |
| Auth | Supabase Auth (Google OAuth + magic link, invite-only) + local PIN app lock |
| Language | TypeScript strict |
| Unit Tests | Jest 30 + ts-jest + jsdom + fake-indexeddb |
| E2E Tests | Playwright 1.61 (6 dev projects: 3 cross-browser desktop runs plus Chromium mobile/tablet/desktop; separate production-static-export Chromium config) |
| Linting | ESLint 9 + eslint-config-next |

**No Next.js server-side code.** Every component is `'use client'`. The app ships no API routes, server components, or server actions. Managed writes and CSV-import dataset replacement are enforced inside the Supabase database instead: authenticated `SECURITY DEFINER` RPCs (`apply_managed_write`, `replace_user_dataset`) own all writes to the six managed tables, and migration 007 removes their direct INSERT/UPDATE/DELETE policies.

---

## 3. Data Model

### 3.1 IndexedDB Stores (12 total)

| Store | Key | Purpose |
|---|---|---|
| `transactions` | UUID | Income, expense, and transfer records |
| `accounts` | UUID | Named accounts with starting balance + sort order |
| `categories` | UUID | Categorized by type (income/expense/transaction) + sort order |
| `cashDenominations` | UUID | Per-date snapshots of cash on hand by denomination |
| `payouts` | UUID | Saved payout calculations |
| `budgetTargets` | UUID | Per-category planned amounts (global default or per-month override) |
| `balanceSnapshots` | accountId | Per-account current balance snapshot (synced across devices) |
| `stocks` | UUID | Stock tickers tracked in portfolio |
| `stockTransactions` | UUID | Buy/sell transaction log |
| `dividends` | UUID | Dividend records (cash and stock) |
| `syncQueue` | auto-increment | Pending outbound sync entries (FIFO by monotonic counter) |
| `datasetMarkers` | userId | Durable CSV replacement snapshot/state (`local` when cloud is disabled) |

**DB version:** 14 (current). Migrations v2→v14 handled in `idb.ts` upgrade callback.

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

The 10 application data stores map 1:1 to Supabase Postgres tables; `syncQueue` and `datasetMarkers` are local-only. The six CSV-managed tables carry `dataset_generation`; authenticated clients can read but not write them directly. Every remote table has `user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE` and `created_at TIMESTAMPTZ`; mutable tables add `updated_at TIMESTAMPTZ` (LWW trigger) and `deleted_at TIMESTAMPTZ` (soft-delete). RLS is per-user (`auth.uid() = user_id`), but the policy set differs:
- **Managed tables** (`accounts`, `categories`, `transactions`, `cash_denominations`, `payouts`, `budget_targets`): SELECT only. All INSERT/UPDATE/DELETE goes through the `apply_managed_write` and `replace_user_dataset` RPCs, and a trigger drops rows whose `dataset_generation` is not the current generation.
- **Remaining synced tables** (`stocks`, `stock_transactions`, `dividends`, `balance_snapshots`): SELECT/INSERT/UPDATE/DELETE, gated on `auth.uid() = user_id`.
- **`dataset_generations`**: SELECT only; the RPCs update it.

Dividend sync retains the legacy `date` and `amount` columns while also storing the expanded `ex_date`, `pay_date`, `qty`, `rate`, `fee`, and `dividend_yield` fields. Legacy rows are normalized to the v13 local shape during pull.

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

1. `001_schema.sql` — tables, LWW trigger, initial RLS
2. `002_user_isolation.sql` — TRUNCATE, user_id column, per-user RLS
3. `003_add_sort_order.sql` — sort_order on accounts + categories
4. `004_stock_sync.sql` — stocks, stock transactions, and legacy dividends tables
5. `005_balance_snapshots.sql` — balance snapshots table
6. `006_dividend_expansion.sql` — expanded dividend columns and legacy backfill
7. `007_dataset_generation.sql` — dataset generation, read-only generation RLS, managed-write RPC, write fence, replacement RPC
---

## 5. Sync Architecture (Outbox Pattern)

1. Every local CRUD **atomically** enqueues a sync entry inside the same IDB transaction
2. Monotonic counter (`syncSeqCounter`) ensures strict FIFO ordering
3. Background sync runs in 3 phases: Read → Network → Write
4. Auto-sync fires 2 seconds after every CRUD (debounced `requestSync()`)
5. Conflict resolution: Last-Writer-Wins by `updated_at` (LWW trigger on Supabase)
6. Soft-delete: "Delete" sets `deleted_at`, never hard-deletes from REST API
7. `resyncAll()` recovery: clears queue, re-enqueues in dependency order
8. `ensureUuids()`: one-shot migration from legacy slug IDs to `crypto.randomUUID()`. One readwrite transaction deletes the old account/category keys, writes the new ones, and remaps transaction refs, balance snapshot `id`/`accountId`, queue identity fields, and every replacement-marker snapshot; the versioned `uuid_migration_v2_done` flag is set only after commit, and the legacy `uuid_migration_done` key is ignored so a prior migration never suppresses this corrected run
9. `syncInFlight` guard prevents concurrent sync cycles
10. Durable `datasetMarkers` snapshot gates managed push/pull until `replace_user_dataset` applies it
11. Managed single-record writes use `apply_managed_write`; direct managed INSERT/UPDATE/DELETE policies are removed
12. Exact generation match is enforced by the server fence; `dataset_generations` is client read-only
13. A newer remote generation reconciles the full managed snapshot with paginated reads; queued managed edits produce a visible conflict
14. A managed push fenced by `conflict` keeps its queue entry, stops the cycle, and records a conflict marker instead of retrying or pulling
15. Conflict resolution re-reads and validates the marker inside its snapshot transaction and derives the next generation there
16. A pending `local` marker is adopted under the authenticated user ID in one `datasetMarkers` transaction; an authenticated import deletes the obsolete local marker
17. On first open, `getDB()` shares one initialization promise and resolves it only after `datasetMarkers` hydrates the active generation; a failed open or hydration clears the promise so a later call retries without exposing a partially initialized singleton

---

## 6. Auth Lifecycle

- Supabase not configured → `state = 'disabled'`, app works fully offline
- Google OAuth is the primary sign-in method; magic link is fallback (invite-only, `shouldCreateUser: false`)
- Authenticated → `lastUserId` localStorage marker prevents unnecessary cache wipe on same-user refresh
- User switch detected → `clearAllLocalData()` + discard sync queue + re-pull
- Sign-out → tries `backgroundSync()` first, warns if queue non-empty
- Route guard uses `useRouter().replace()` in `useEffect` (not `redirect()` mid-render)
- **App lock:** optional local PIN-based privacy lock (PBKDF2-hashed, stored in localStorage). When enabled + authenticated, a full-screen PIN overlay blocks app content until unlocked. Settings → App Lock for enable/disable/change.

### UX Flow

```
User opens app
  ├─ Supabase not configured? → No auth. App works as today.
  └─ Supabase configured?
       ├─ Has valid session? → App lock enabled?
       │    ├─ Yes → PIN screen
       │    └─ No → Dashboard
       └─ No session → /login page
            ├─ "Continue with Google" → OAuth redirect → return
            ├─ Enter email → "Send magic link" (invite-only)
            └─ Returning user with session → auto-redirect
```

Invite-only model — no sign-up form. Users invited via Supabase dashboard.

---

## 7. Routes / Screens

| Route | Purpose | Key Features |
|---|---|---|
| `/login` | Sign-in (Google OAuth + magic link) | Google primary, magic link fallback, invite-only, disabled when Supabase not configured |
| `/` | Summary / Dashboard | Month nav, 4 metric cards, Accounts table, Income/Expenses breakdowns with budget targets, Category/Account breakdown charts. Mobile: grouped CategoryBreakdown with progress bars, collapsed Quick Add |
| `/transactions` | Transaction List | URL search-param filtering (type, month, account, category, text), date grouping toggle, pagination (50/page), edit modal, inline delete. Persistence and account isolation follow the [transaction filter contract](transaction-filters.md). Mobile: card layout. Desktop: table layout |
| `/available-balance` | Cash Reconciliation | Per-account expected balance to user-selected date. **Current** field computable from sub-split amounts (toggle via layers icon). Cash: denomination breakdown grid (₱1000→₱1). Difference column. Read-only |
| `/payout` | Payout Calculator | Standalone calc (no ledger writes). Percentage/flat-amount mode. Savings sub-split. Validated saves are atomic, guarded against concurrent submissions, and expose pending/success/failure state. |
| `/settings` | Settings | Accounts CRUD + reorder, Categories CRUD + reorder, Tab Visibility toggle, App Lock (PIN), Cloud Sync controls, Sign-out, Backup & Restore (JSON export/import, CSV export, CSV import from Google Sheets) |

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
- **Account creation** from unique names; an unambiguous normalized-name match on both sides retains the existing ID, otherwise a new UUID is generated. Transaction references are remapped
- **Category creation** with auto-detected type from CSV Type values
- **Failure reporting** shows the caught error name and message

### Replacement Contract

- Six managed stores, the durable marker snapshot, managed queue cleanup, and obsolete local-marker removal commit in one IndexedDB transaction
- One transactional RPC applies the snapshot, soft-deletes missing rows, and never touches `balance_snapshots` or hard-deletes accounts
- Status distinguishes local pending, cloud applied, failed, and conflicted replacement
- A managed push fenced by `conflict` preserves its queue entry and local rows in a conflict marker instead of retry-dropping or pulling
- An older-generation queue entry is a post-snapshot edit from a tab with a stale in-memory generation, so it also becomes a conflict marker instead of being dropped
- Writes wait until the persisted generation is loaded. The first `getDB()` call shares one initialization promise across all callers and resolves only after marker hydration, so a queue entry started during that open carries the persisted generation rather than `0`
- Reconciliation and replacement RPC outcomes commit only while the durable marker identity is unchanged; a concurrent import always wins
- Re-importing the same CSV converges to one latest snapshot; retrying the same snapshot is idempotent
- Missing references stay inspectable with exact IDs; repair requires an explicit target account and deletes nothing

---

### 9.1 Auto-Backup

- On app load, `saveAutoBackup()` exports all data to `localStorage` under keys `auto-backup-data` / `auto-backup-time`
- Throttled to once per 24 hours — subsequent loads within the window are no-ops
- `getAutoBackup()` reads + validates the stored backup
- Settings → Backup & Restore shows "Last auto-backup: X ago" and a "Restore from auto-backup" button
- Restore uses existing `importAllData()` followed by page reload
- All errors caught silently — full localStorage or corrupt data won't break the app

## 9. Backup / Restore

- **JSON export** — all 6 stores as single portable file
- **CSV export** — transactions only, for spreadsheet analysis
- **JSON import** — full restore from previously exported file (clear-and-replace)
- **CSV import** — from Google Sheets format (see §8)

---

## 10. Test Structure

### CI Pipeline (GitHub Actions)

`.github/workflows/ci.yml` — runs on push/PR to `main`:
- `npm ci` → `lint` → `tsc --noEmit` → `jest` → `build`
- E2E (Playwright) not included — requires browser deps, run locally

### Unit Tests (Jest)

| File | Focus |
|---|---|
| `src/lib/aggregations.test.ts` | Account balance computation, income/expense breakdowns |
| `src/lib/idb.test.ts` | IDB CRUD operations, sync queue, migrations |
| `src/lib/idb-import.test.ts` | Atomic replacement, marker snapshot, obsolete local-marker removal, re-import convergence, failure rollback, explicit relinking |
| `src/lib/idb-first-open-generation.test.ts` | First-open hydration barrier: a queue entry started during initialization carries the persisted generation |
| `src/lib/idb-import-uuid-snapshot.test.ts` | UUID migration after an import: no duplicate account, local references and balance snapshot follow, every persisted marker snapshot is remapped, a preexisting `uuid_migration_done` key does not suppress the correctly versioned rerun, and a failed migration leaves `uuid_migration_v2_done` unset |
| `src/lib/dataset-replacement.test.ts` | Account identity, ID retention, generation sequencing |
| `src/lib/orphans.test.ts` | Missing-account grouping, safe labels, reference-only relinking |
| `src/lib/sync.test.ts` | Replacement retry/idempotency, managed-write RPC, generation gate, fenced-push conflict retention, atomic local marker adoption, marker-transition-safe resolution, paginated reconciliation |
| `src/lib/csv-import.test.ts` | CSV parsing, date detection, amount parsing, carry-over logic |
| `src/lib/reconciliation.test.ts` | Expected balance computation |
| `src/hooks/useTransactions.test.ts` | Transaction add/delete through the hook |
| `src/lib/holdings.test.ts` | Share cost basis, realized/unrealized gains, dividend totals, and aggregates |
| `src/lib/stock-prices.test.ts` | Price response parsing, HTTP/network failures, and ticker normalization |
| `src/lib/utils.test.ts` | Category breakdown aggregation, percentages, and ordering |
| `src/lib/dividends.test.ts` | Legacy/expanded dividend sync compatibility |
| `src/components/summary/PortfolioSummaryCard.test.tsx` | Portfolio summary rerender behavior and empty-state handling |
| `src/context/AuthContext.test.tsx` | Auth lifecycle, identity isolation, sign-out cleanup, PIN remount, and filter mirror gates |
| `src/lib/transaction-filters.test.ts` | Persistable filter allowlist and query canonicalization |
| `src/components/summary/TransactionList.test.tsx` | Add dialog toggle render isolation; StrictMode restore/settlement; empty-URL/stale-router settlement; stale-router and view-only URL projection; consecutive filter updates and stale-page normalization; auth-gated persistence and identity-switch provenance |
| `src/components/forms/DividendForm.test.tsx` | Dividend fields, validation, computed amounts, and loading state |
| `src/components/stocks/DividendLog.test.tsx` | Dividend table, legacy amounts, yields, and edit/delete actions |

### E2E Tests (Playwright)

| File | Focus |
|---|---|
| `e2e/quick-add-summary.spec.ts` | Quick Add → Summary sync |
| `e2e/settings-delete-blocked.spec.ts` | Delete-blocked-if-in-use |
| `e2e/payout-calculator.spec.ts` | Payout calculator flows |
| `e2e/budget-target-persistence.spec.ts` | Budget target reload persistence |
| `e2e/transaction-filter-persistence.spec.ts` | Filter selection, direct-URL selection/clearing, and tab restore against dev and the static export |
| `e2e/settings-orphan-review-deeplink.spec.ts` | Orphan-review deep link hydration and scroll |

Recorded validation metrics: [`state.yaml` metrics](./state.yaml).

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
| Transactions Add Isolation | ✅ See [Transaction Editing §2.4](./transaction-editing.md#24-add-entry-point) for the render contract and performance evidence |
| E2E Testing (Playwright) | ✅ See [`e2e/`](../e2e/) for coverage, [`playwright.config.ts`](../playwright.config.ts) for projects, and [`playwright.prod.config.ts`](../playwright.prod.config.ts) for the static-export filter run |
| Magic-Link Auth | ✅ Invite-only, useEffect-based route guard |
| Transaction Filter Persistence | ✅ See [feature contract](transaction-filters.md) |
| User Data Isolation | ✅ user_id on all tables, RLS, cache wipe on user switch |
| Backup & Restore | ✅ JSON export/import, CSV export/import |
| CSV Import | ✅ Google Sheets format, carry-over→starting balance, retained account IDs |
| Dataset Replacement Sync | ✅ Durable marker, generation fence, managed-write RPC, idempotent replacement |
| Missing Account Review | ✅ Exact missing IDs, explicit relinking, no guessing/deletion; `#orphan-review` deep link hydrates after mount and scrolls to the review |
| Codebase Audit | ✅ 21 findings resolved |
| Empty State / Onboarding | ✅ All pages show import guidance when empty |
| Seed Data Removal | ✅ App starts clean |
| Category Reordering | ✅ sortOrder field, DB v6 migration |
| Bottom Tab Bar | ✅ Mobile fixed bottom nav |
| CI Pipeline | ✅ GitHub Actions: lint, typecheck, test, build |
| Auto-Backup | ✅ Daily localStorage snapshot with restore button |
| CSV Validation Hardening | ✅ Duplicate-account transfer rejection + negative balance warning |
| IDB Quota Check | ✅ Pre-import storage quota warning (>80%) |

### Deferred

*None currently.*

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
| Managed writes require an RPC | Direct PostgREST writes cannot prove the current generation |
| Full paginated reconciliation on generation change | Supabase caps selects at 1000 rows; partial replacement loses rows |
| Pending managed edits surface a conflict | Preserves user work and the queue |
| Local marker adoption | Offline import remains usable before sign-in |
| A fenced push keeps its queue entry | Retry counting would drop the user's write even though only explicit resolution can fix the generation |
| Local marker adoption is one transaction | Separate check, copy, and delete can overwrite a user marker or delete a newer local marker |
| Conflict preparation re-reads the marker | Reading before the transaction can rebuild and overwrite a marker changed by a concurrent import |

---

## 13. Stock Portfolio Tracker (✅ Phase 2 Complete)

### 13.1 Data Model (4 new IDB stores — v11→v13)

**`stocks`** — tickers tracked:

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| ticker | string | Bare ticker, no `.PS` (e.g. `"BDO"`, `"SM"`) |
| type | `'stock'` \| `'fund'` \| null | `stock` = PSE-listed/price-tracked, `fund` = UITF/manual NAVPU |
| name | string | Full company name |
| currentPrice | number \| null | From API or manual entry |
| priceUpdatedAt | number \| null | |
| sortOrder | integer | |
| createdAt, updatedAt | number | |

**`stockTransactions`** — buy/sell log:

| Field | Type |
|---|---|
| id | uuid |
| stockId | uuid |
| date | ISO date |
| type | `'buy'` \| `'sell'` |
| shares | number |
| pricePerShare | number |
| fees | number (default 0) |
| totalAmount | number |
| notes | string \| null |
| createdAt, updatedAt | number | |

**`dividends`** — dividend log (v13 expanded):

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| stockId | uuid | → Stock.id |
| exDate | string | Ex-dividend date "YYYY-MM-DD" |
| payDate | string | Payment date "YYYY-MM-DD" |
| type | `'cash'` \| `'stock'` | |
| qty | number | Shares held at dividend time |
| rate | number | Per-share dividend rate (PHP) |
| amount | number | Net amount (= qty × rate − fee for new records; gross for legacy) |
| fee | number | Withholding tax / deductions (PHP) |
| dividendYield | number \| null | User-entered yield % |
| sharesReceived | number \| null | Stock dividends only |
| notes | string \| null | |

Portfolio dividend totals retain the expanded `qty × rate − fee` calculation and legacy `amount` fallback; missing or non-finite legacy numeric fields are treated safely so the summary cannot display `NaN`. PortfolioSummaryCard consumes the current StocksPage `HoldingsResult`, so dividend totals refresh after dividend create, edit, delete, and sync reloads.

### 13.2 Price Source

**Phisix API** (`phisix-api3.appspot.com`) — community-maintained PSE data, CORS-friendly. Previously Yahoo Finance v8 (`b024f74` → Yahoo CORS issues), switched to Phisix (`703a35c`).
- Bare ticker, no `.PS` suffix
- Batch fetch from `/stocks.json`, matched against user's portfolio
- Fetch on button press only (no polling)
- Manual price override for funds (type = `'fund'`)

### 13.3 Screens

| Route | Content |
|---|---|
| `/stocks` | Holdings table → 3-section tabs (Holdings, Transactions, Dividends) |
| Settings → Manage Tickers | Stock/Fund CRUD + reorder + type selection |
| Dashboard | Portfolio summary card (total value, invested, dividends, gain/loss) |

### 13.4 Bottom Tab Bar

6 tabs: Summary \| Transactions \| Balance \| Payout \| **Stocks** \| Settings

Stocks is an **optional tab** — toggleable in Settings → Tab Visibility alongside Balances and Payout.

### 13.5 Portfolio API Server

Local Express API (`server/index.ts`) for AI assistant integration. See [`server/README.md`](../server/README.md).

## 14. What's Left

- **Dividend → expense tracker integration** — auto-create income transactions from dividend records (deferred — separate tracking layer for now)
