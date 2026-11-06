# Unified Project Spec — mobile-expense-tracker v2.0

> Project overview; detailed feature contracts are linked from the [specs index](README.md).
> Compiled: 2026-11-04. Status: all Phase 1 and Phase 2 features done.

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

**Zero server-side code.** Every component is `'use client'`. No API routes, no server components, no server actions.

---

## 3. Data Model

### 3.1 IndexedDB Stores (13 total)

| Store | Key | Purpose |
|---|---|---|
| `transactions` | UUID | Income, expense, and transfer records |
| `accounts` | UUID | Named accounts with starting balance + sort order |
| `categories` | UUID | Categorized by type (income/expense/transaction) + sort order |
| `cashDenominations` | UUID | Per-date snapshots of cash on hand by denomination |
| `payouts` | UUID | Saved payout calculations |
| `budgetTargets` | UUID | Per-category planned amounts (global default or per-month override) |
| `balanceSnapshots` | UUID | Per-account current balance snapshot (synced across devices) |
| `stocks` | UUID | Stock tickers tracked in portfolio |
| `stockTransactions` | UUID | Buy/sell transaction log |
| `dividends` | UUID | Dividend records (cash and stock) |
| `syncQueue` | UUID | Durable outbound operations, including blocked and quarantined entries |
| `syncMeta` | `storeName:recordId` | Per-record owner, baseline, revision, and conflict state |
| `syncDeletions` | UUID | Recoverable snapshots for local and remote deletions |

**DB version:** 14 (current). Migrations v2→v14 are handled in `idb.ts`.

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

The ten application data stores map 1:1 to Supabase Postgres tables. `syncQueue`,
`syncMeta`, and `syncDeletions` are local-only safety stores. Remote tables have
per-user RLS and ownership columns; most also use `updated_at` and `deleted_at`.
Dividend sync retains legacy `date`/`amount` columns while storing expanded
`ex_date`, `pay_date`, `qty`, `rate`, `fee`, and `dividend_yield` fields.
Legacy remote rows are normalized to the current local shape during pull.

### Legacy LWW Trigger

The existing `updated_at` trigger can reject stale writes made through the
current direct REST protocol. It does not implement server-managed revisions or
atomic operation receipts. Phase 3A's client-side baseline checks and response
verification are containment only; they are not a full concurrency protocol.

1. `001_schema.sql` — tables, LWW trigger, initial RLS
2. `002_user_isolation.sql` — TRUNCATE, user_id column, per-user RLS
3. `003_add_sort_order.sql` — sort_order on accounts + categories
4. `004_stock_sync.sql` — stocks, stock transactions, and legacy dividends tables
5. `005_balance_snapshots.sql` — balance snapshots table
6. `006_dividend_schema_compatibility.sql` — expanded dividend columns and legacy backfill
---

## 5. Sync Architecture (Outbox Pattern)

1. Local record changes and queue writes are atomic in IndexedDB; local deletes also archive the full snapshot in that transaction.
2. The monotonic `syncSeqCounter` preserves FIFO order across same-millisecond changes.
3. Sync uses Read → Network → Write and never holds an IndexedDB transaction across network requests.
4. Queue work is acknowledged only after checking a returned server row; failed work remains durable and is marked `blocked` after five failures.
5. `pending`, `blocked`, `conflict`, and `quarantined` work is reported separately. Conflicts preserve both versions for manual review; there is no in-app conflict-resolution UI. Unowned legacy work is quarantined, not replayed.
6. The client uses stored `updated_at` baselines and response checks where supported. Competing edits are retained as conflicts; this is not server-enforced revision control or exactly-once processing.
7. Pull merges read local rows, queue entries, and metadata in the same read-write IndexedDB transaction that applies remote rows, conflicts, and deletion archives. The network fetch stays outside; overlapping local CRUD transactions serialize before or after the merge. Pending local edits remain protected from remote active overwrites/tombstones; untouched rows removed by tombstones are archived first.
8. `resyncAll()` retains the outbox, baselines, conflicts, and deletion archives; it retries eligible work without rebuilding the queue.
9. Auto-sync is debounced after local changes; `syncInFlight` prevents overlapping cycles in one client instance.

The future server protocol still needs ownership checks, revision checks, and
atomic idempotency receipts. Old-client compatibility or retirement must be
resolved before an RPC cutover.

### Phase 3A transitional limits

These are current constraints, not guarantees:

- Supabase pulls use one unpaginated `select` (`src/lib/sync.ts:1004-1008`) and
  do not page past the API row limit.
- Stock deletion archives and deletes locally in one transaction, then queues
  individual remote delete operations (`src/lib/idb.ts:1410-1470`); there is no
  single cross-record atomic remote delete.
- Account/category in-use checks live in the Settings UI
  (`src/app/settings/page.tsx:421-435,783-797`), not in the IndexedDB deletion
  functions (`src/lib/idb.ts:835-855,962-982`); direct IDB deletes can leave
  dangling references.
- Cash snapshot replacement deletes rows by date and then inserts denominations
  as separate calls (`src/components/available-balance/CashDenominationInput.tsx:71-89`),
  so it is not one atomic replacement.
- Privileged stock-price writers update Supabase directly
  (`server/index.ts:361-365`, `server/refresh-prices.mjs:72-76`), outside the
  client outbox and baseline checks.
- The current direct REST protocol has no server-managed revisions or atomic
  operation receipts. Do not claim exactly-once effects, complete cloud backup,
  or full cross-client concurrency safety.
- Owner inference for an unmarked cache checks all 13 local stores
  (`ALL_BACKUP_STORES`, `src/lib/idb.ts`; `hasAnyLocalData()`). A cache is
  claimed only when every store is empty. A cache whose only records sit in
  `syncQueue`, `syncMeta`, or `syncDeletions` is treated as non-empty, so
  ownership stays unverified, the records stay hidden and retained, and
  export/import/restore/AutoBackup remain gated while the scope is unverified.
  The app has no automatic reassignment path for such a cache. This is verified
  client behavior; older clients can still bypass these safeguards. See
  [User Data Isolation §5](user-data-isolation.md#5-fixed-behavior-unowned-safety-only-caches-fail-closed).

---

## 6. Auth Lifecycle

- Supabase not configured → `state = 'disabled'`, app works fully offline
- Google OAuth is the primary sign-in method; magic link is fallback (invite-only, `shouldCreateUser: false`)
- Authenticated → `lastUserId` localStorage marker allows same-user reuse of the cache.
- Account mismatch, or an unowned cache with a record in any of the 13 stores (including a safety-only cache) → fail closed; hide local records and retain them without replaying. A cache is claimed only when all 13 stores are empty.
- Unowned cache with retained sync-safety records (`syncQueue`, `syncMeta`, `syncDeletions`) and empty financial stores → treated as non-empty. Ownership stays unverified, the records stay hidden and retained, and export/import/restore/AutoBackup remain locked while the scope is unverified; the app provides no automatic reassignment path. See [User Data Isolation §5](user-data-isolation.md#5-fixed-behavior-unowned-safety-only-caches-fail-closed). This client check does not constrain older clients or add server revisions.
- Sign-out or unauthenticated state → hide local data and retain records, outbox, and deletion snapshots. No sign-out sync attempt can guarantee delivery.
- Every identity transition advances a published generation. Push/pull cycles and UI reads capture that generation before they start; work authorized for a previous generation is cancelled and cannot merge rows, acknowledge queue entries, advance sync status, or republish stale UI state.
- Authenticated startup verifies cache ownership, publishes the local IndexedDB snapshot, and settles initial loading before starting online background sync. After the attempt settles (including `false` or rejection), it refreshes from IndexedDB only if the identity is still current; online/foreground lifecycle events cannot bypass the initial-read barrier. Offline and disabled startup remain local-only.
- Within one provider and auth generation, only the newest authorized IndexedDB read may publish rows, errors, or loading completion. A same-user `User` object replacement does not restart initialization.
- These are client-side UI guards; they do not provide server-managed revisions, atomic operation receipts, exactly-once effects, or cross-tab request ordering.
- `AuthGuard` renders no private children while unauthenticated and remounts the authenticated subtree when the generation changes.
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
| `/` | Summary / Dashboard | Month nav, 4 metric cards, per-account summary (starting balance, inflow, outflow, ending balance, TOTAL footer) at every viewport, Income/Expenses breakdowns with budget targets, Category/Account breakdown charts. Mobile: the accounts table stays visible and scrolls horizontally inside its card, grouped CategoryBreakdown with progress bars sits below it, collapsed Quick Add whose closed panel is inert |
| `/transactions` | Transaction List | URL search-param filtering (type, month, account, category, text), date grouping toggle, pagination (50/page), edit modal, inline delete. Query persistence is owned by the private `useTransactionFilterState` hook and follows the [transaction filter contract](transaction-filters.md). Mobile: card layout. Desktop: table layout |
| `/available-balance` | Cash Reconciliation | Per-account expected balance to user-selected date. **Current** field computable from sub-split amounts (toggle via layers icon). Cash: denomination breakdown grid (₱1000→₱1). Difference column. Read-only |
| `/payout` | Payout Calculator | Standalone calc (no ledger writes). Percentage/flat-amount mode. Savings sub-split. Validated saves are atomic, guarded against concurrent submissions, and expose pending/success/failure state. |
| `/settings` | Settings | Accounts CRUD + reorder, Categories CRUD + reorder, Tab Visibility toggle, App Lock (PIN), Cloud Sync controls, Sign-out, Backup & Restore (13-store JSON export/import, CSV export, CSV import from Google Sheets). Navigation uses decorative SVG icons, not emoji. |

### Responsive Layout

- **Mobile (<768px):** Single column, fixed bottom tab bar (5 tabs, z-20, safe-area-inset), card layouts for Settings, collapsible Quick Add, per-account summary table scrolling inside its card
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

A JSON backup is a local snapshot of all 13 IndexedDB stores, not proof of
complete cloud state. It contains no authentication secrets. Treat it as
sensitive because it includes the full ledger, outbox, sync metadata, and
deletion archives.

- **JSON export** — all 13 stores in one portable file (`version: 1`)
- **CSV export** — transactions only, for spreadsheet analysis
- **JSON import** — replaces only the financial stores present in the file;
  omitted stores are left intact and a present empty array clears that store
- **CSV import** — from Google Sheets format (see §8)

Restore archives existing records from replaced stores in `syncDeletions`
before clearing them. The existing outbox is retained; pending or blocked work
for replaced record IDs becomes `conflict`. Incoming queue, metadata, and
deletion entries are inserted by ID only when absent, so they do not replace an
existing local entry with the same ID. Restored records are queued for sync,
but commit is not server acknowledgement.

Backup tools are gated by `isScopeVerified`, which proves local cache ownership
only. Startup verifies ownership across all 13 stores: an unowned cache with any
record — including a cache whose only records are safety stores — is not claimed
for the newly signed-in account, so export, import, restore, and AutoBackup stay
locked while the scope is unverified. A matching-owner scope can export all
13 stores. The export snapshot does not encode its owner, and restore neither
validates nor transfers account ownership, so a backup is not an account-transfer
mechanism. See
[User Data Isolation §5](user-data-isolation.md#5-fixed-behavior-unowned-safety-only-caches-fail-closed).

The UI checks only truthy `version` and `data`; it does not validate store
names, required fields, or record shapes. There is no per-record restore or
conflict-resolution UI. Old six-store backups still import; the four later
financial stores and three safety stores are optional.

### 9.1 Auto-Backup

- Runs on app load only after the local scope is verified, exporting the same 13 stores to `localStorage` (`auto-backup-data` / `auto-backup-time`)
- Throttled to once per 24 hours; failures are swallowed and do not break the app
- `getAutoBackup()` rejects missing keys, corrupt JSON, or a snapshot without truthy `version` and `data`; it does not validate deeper schema
- Settings → Backup & Restore shows "Auto-backup: saved X ago" and a "Restore from auto-backup" button when a snapshot exists
- Restore reuses `importAllData()` and the same archive/outbox/merge semantics, then instructs the user to reload
- localStorage shares the browser profile with IndexedDB and is not an independent backup; clearing site data or browser eviction can remove both

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
| `src/lib/csv-import.test.ts` | CSV parsing, date detection, amount parsing, carry-over logic |
| `src/lib/reconciliation.test.ts` | Expected balance computation |
| `src/hooks/useTransactions.test.ts` | Transaction add/delete through the hook |
| `src/lib/holdings.test.ts` | Share cost basis, realized/unrealized gains, dividend totals, and aggregates |
| `src/lib/stock-prices.test.ts` | Price response parsing, HTTP/network failures, and ticker normalization |
| `src/lib/utils.test.ts` | Category breakdown aggregation, percentages, and ordering |
| `src/lib/dividends.test.ts` | Legacy/expanded dividend sync compatibility |
| `src/components/summary/PortfolioSummaryCard.test.tsx` | Portfolio summary rerender behavior and empty-state handling |
| `src/context/AuthContext.test.tsx` | Auth lifecycle, identity isolation, sign-out cleanup, PIN remount, and filter mirror gates |
| `src/lib/auth-scope.test.ts` | Identity generations, exact scope tokens, and abort-on-invalidation registration |
| `src/lib/sync.test.ts` / `src/lib/phase3a-sync.test.ts` | Outbox preservation, CAS readback verification, and auth-generation fencing for in-flight push and pull |
| `src/context/TransactionContext.test.tsx` / `TransactionContext.phase3a.test.tsx` | Cache ownership, sign-out hiding, and stale read/error/loading/refresh publication fences |
| `src/components/auth/AuthGuard.test.tsx` | Fail-closed unauthenticated rendering, PIN gate order, and generation-keyed subtree remount |
| `src/lib/transaction-filters.test.ts` | Persistable filter allowlist and query canonicalization |
| `src/components/summary/TransactionList.test.tsx` | Add dialog toggle render isolation; StrictMode restore/settlement; empty-URL/stale-router settlement; stale-router and view-only URL projection; consecutive filter updates and stale-page normalization; auth-gated persistence and identity-switch provenance |
| `src/components/forms/DividendForm.test.tsx` | Dividend fields, validation, computed amounts, and loading state |
| `src/components/stocks/DividendLog.test.tsx` | Dividend table, legacy amounts, yields, and edit/delete actions |

### E2E Tests (Playwright)

| File | Focus |
|---|---|
| `e2e/quick-add-summary.spec.ts` | Quick Add → Summary sync with seeded category/account option waits, mobile accounts summary rendering and balances, mobile disclosure keyboard/focus behavior, and empty-state setup guidance |
| `e2e/settings-delete-blocked.spec.ts` | Delete-blocked-if-in-use |
| `e2e/payout-calculator.spec.ts` | Payout calculator flows |
| `e2e/budget-target-persistence.spec.ts` | Budget target reload persistence |
| `e2e/transaction-filter-persistence.spec.ts` | Filter selection, direct-URL selection/clearing, tab restore, and full-load/reload restore against dev and the static export |

`e2e/fixtures.ts` seeds through the running app: `seedIndexedDB` opens `/`, waits for the empty state so IndexedDB initializes at the current version, then writes fixtures without pinning an older version.

Recorded validation metrics: [`state.yaml` metrics](./state.yaml).

---

## 11. Spec Status

### Feature status

| Spec | Status |
|---|---|
| Phase 1 Budget Tracker | ✅ All 9 tasks |
| Responsive Layout Pass | ✅ Multi-column grids on all 4 routes |
| Local-First Sync (Supabase) | ✅ Durable client outbox, nondestructive recovery, conflict containment; owner checks span all 13 stores. Transitional REST protocol with unpaginated pulls and no server revisions or atomic receipts |
| Budget Target Persistence | ✅ Hybrid global defaults + per-month overrides |
| Transaction Editing | ✅ Edit modal with shared TransactionFormFields |
| Transactions Add Isolation | ✅ See [Transaction Editing §2.4](./transaction-editing.md#24-add-entry-point) for the render contract and performance evidence |
| E2E Testing (Playwright) | ✅ See [`e2e/`](../e2e/) for coverage, [`playwright.config.ts`](../playwright.config.ts) for projects, and [`playwright.prod.config.ts`](../playwright.prod.config.ts) for the static-export filter run |
| Magic-Link Auth | ✅ Invite-only, useEffect-based route guard |
| Transaction Filter Persistence | ✅ See [feature contract](transaction-filters.md) |
| User Data Isolation | 🟡 Client-side fix verified: per-user RLS plus fail-closed transitions; an unmarked cache is claimed only when all 13 stores are empty, so a safety-only cache is not assigned or exportable. Phase 3B server revisions, receipts, and an old-client retirement plan remain unimplemented — see [§5](user-data-isolation.md#5-fixed-behavior-unowned-safety-only-caches-fail-closed) |
| Backup & Restore | ✅ 13-store JSON snapshot with legacy v1 import, present-only financial-store replacement, local archives, retained outbox, and scope-gated tools. Ownership is not encoded in the file or validated as account transfer; the gate refuses any unowned cache with records — see [§5](user-data-isolation.md#5-fixed-behavior-unowned-safety-only-caches-fail-closed) |
| CSV Import | ✅ Google Sheets format, carry-over→starting balance |
| Codebase Audit | ✅ 21 findings resolved |
| Empty State / Onboarding | ✅ Accurate manual setup guidance plus `Open Settings` on Dashboard, Transactions, and Available Balance. See [UI accessibility and onboarding](ui-accessibility-onboarding.md) |
| UI Accessibility & Onboarding | ✅ Inert closed Quick Add, AA secondary text in both themes (including Settings empty accounts and no-categories messages, Input-owned peso and percent adornments in Quick Add, Settings, and Payout, the Stocks empty-state message in both themes, and the Payout selected mode and warning text), SVG Settings nav icons, hierarchical payout heading. See [feature contract](ui-accessibility-onboarding.md) |
| Seed Data Removal | ✅ App starts clean |
| Category Reordering | ✅ sortOrder field, DB v6 migration |
| Bottom Tab Bar | ✅ Mobile fixed bottom nav |
| CI Pipeline | ✅ GitHub Actions: lint, typecheck, test, build |
| Auto-Backup | ✅ Scope-verified daily localStorage snapshot of the same 13 stores; same-device convenience only, restore reuses import semantics |
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
| Account transition protection | Preserve and hide local data on sign-out or account mismatch; quarantine legacy work without verified ownership. In-flight sync and UI reads are fenced by the captured identity generation, so old work cannot become authoritative after re-login. These are client-side guards; older clients can still bypass them. |
| `lastUserId` localStorage marker | Confirms cache ownership for the current account; does not authorize assigning legacy local data to a new account. Without a marker, startup claims the cache only when all 13 stores are empty, so a safety-only cache fails closed. See [§5](user-data-isolation.md#5-fixed-behavior-unowned-safety-only-caches-fail-closed). |
| Monotonic counter for sync ordering | `Date.now()` collides during bulk import. `++syncSeqCounter` guarantees FIFO. |
| Transaction filter query in a private hook | `useTransactionFilterState` owns URL/mirror precedence, one-time restore, and the two-stage Next history publish. The filter spec records the installed 16.2.9 restore-publish evidence and the upgrade recheck. The list keeps filter derivation and rendering; no generic URL hook without a second consumer. |

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
