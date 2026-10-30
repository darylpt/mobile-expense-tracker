# Project Context Map

> Auto-generated 2026-07-12. Single-source snapshot of architecture, current state, and test structures.

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
| E2E Tests | Playwright 1.61 (3 browsers x 3 viewports = 6 projects) |
| Linting | ESLint 9 + eslint-config-next |

**Zero server-side code.** Every component is `'use client'`. No API routes, no server components, no server actions.

---

## 3. Source Tree

```
src/
├── app/                          # Next.js App Router pages (all client)
│   ├── page.tsx                  # / — Summary / Dashboard
│   ├── login/page.tsx            # /login — Magic-link sign-in
│   ├── transactions/page.tsx     # /transactions — Filterable transaction list
│   ├── available-balance/page.tsx # /available-balance — Cash reconciliation
│   ├── payout/page.tsx           # /payout — Payout calculator
│   ├── settings/page.tsx         # /settings — Accounts, Categories, Cloud Sync, Backup
│   ├── layout.tsx                # Root layout (AuthProvider, AuthGuard, GlobalErrorBanner)
│   └── globals.css               # Tailwind entry point
├── components/
│   ├── common/                   # Button, Input, Dropdown (shared primitives)
│   ├── forms/                    # QuickAddForm, TransactionFormFields (shared), EditTransactionModal, CsvImportPreview
│   ├── layout/                   # Header (tab nav, email, sign-out, version badge, sync status, mobile bottom nav), GlobalErrorBanner, LayoutWithError
│   ├── summary/                  # TransactionList (filterable, paginated), MonthlySummaryCard, CategoryBreakdown
│   └── available-balance/        # CashDenominationInput
├── context/
│   ├── AuthContext.tsx            # Auth provider + route guard (useEffect-based redirect)
│   └── TransactionContext.tsx     # Global state + auth-aware cache lifecycle + memoized value
├── hooks/
│   ├── useTransactions.ts        # Derived views from TransactionContext
│   ├── useAccounts.ts            # Account CRUD
│   └── useCategories.ts          # Category CRUD
├── lib/
│   ├── idb.ts                    # IndexedDB CRUD + sync queue + migrations + export/import (~1155 lines, deliberately unsplit)
│   ├── sync.ts                   # Outbox sync (processSyncQueue, pullStore, backgroundSync, FIELD_MAP)
│   ├── supabase.ts               # Supabase client (null if env vars missing)
│   ├── aggregations.ts           # Account balance, income/expense breakdown
│   ├── reconciliation.ts         # Expected balance computation
│   ├── csv-import.ts             # Google Sheets CSV parser + validator
│   ├── constants.ts              # DB config, store names
│   ├── utils.ts                  # Formatting, date math
│   ├── test-utils.ts             # Shared test helpers
│   ├── version.ts                # APP_VERSION = '0.2.15'
│   └── *.test.ts                 # Co-located unit tests
└── types/
    └── index.d.ts                # All TypeScript interfaces
```

### Supporting Files

```
supabase/migrations/
├── 001_schema.sql                # Tables, LWW trigger, initial RLS
├── 002_user_isolation.sql        # TRUNCATE + user_id column + per-user RLS
└── 003_add_sort_order.sql        # sort_order on accounts + categories

e2e/                              # Playwright tests
├── fixtures.ts                   # Shared test fixtures (IDB clear, page helpers)
├── quick-add-summary.spec.ts     # Quick Add → Summary sync
├── settings-delete-blocked.spec.ts # Delete-blocked-if-in-use
├── payout-calculator.spec.ts     # Payout calculator flows
├── settings-orphan-review-deeplink.spec.ts # Deep-link hydration + scroll
└── budget-target-persistence.spec.ts # Budget target reload persistence

specs/                            # Feature specs (all done except Phase 2)
```

---

## 4. Data Model

The authoritative store inventory, database version, and remote schema are in [the project spec](specs/project-spec.md#3-data-model).

### Key Types (`src/types/index.d.ts`)

- `TransactionType`: `'income' | 'expense' | 'transaction'`
- `Transaction`, `Account`, `Category`, `CashDenomination`, `Payout`, `BudgetTarget`, `MonthYear`
- `MonthlySummary`, `CategoryBreakdownItem`, `AccountBreakdownItem`
- `AccountBalanceRow`, `IncomeBreakdownRow`, `ExpenseBreakdownRow`

---

## 5. Data Flow

```
UI Components → hooks → TransactionContext (in-memory cache, memoized value)
                            ↕
                      idb.ts (IndexedDB — source of truth)
                            ↕
                    sync.ts (outbox queue → Supabase REST)
```

### Sync Architecture (Outbox Pattern)

See the [sync spec](specs/local-first-sync-supabase.md) for queue processing, generation fencing, conflict recovery, and UUID migration.

### Auth Lifecycle

- Supabase not configured → `state = 'disabled'`, app works fully offline
- Authenticated → `lastUserId` localStorage marker prevents unnecessary cache wipe on same-user refresh
- User switch detected → `clearAllLocalData()` + discard sync queue + re-pull
- Sign-out → tries `backgroundSync()` first, warns if queue non-empty
- Route guard uses `useRouter().replace()` in `useEffect` (not `redirect()` mid-render — avoids Next.js hooks crash)

---

## 6. Routes / Screens

| Route | Purpose | Key Features |
|---|---|---|
| `/login` | Magic-link sign-in | Invite-only, no public signup. Disabled when Supabase not configured |
| `/` | Summary / Dashboard | Month nav, 4 metric cards, Accounts table, Income/Expenses breakdowns with budget targets, Category/Account breakdown charts. Mobile: grouped CategoryBreakdown with progress bars, collapsed Quick Add |
| `/transactions` | Transaction List | URL search-param filtering (type, month, account, category, text), date grouping toggle, pagination (50/page), edit modal, inline delete. Mobile: card layout. Desktop: table layout |
| `/available-balance` | Cash Reconciliation | Per-account expected balance to user-selected date. Cash: denomination breakdown grid (₱1000→₱1). Difference column. Read-only |
| `/payout` | Payout Calculator | Standalone calc (no ledger writes). Percentage/flat-amount mode. Savings sub-split (Emergency/Wants/Investment/Motor). Saves to IDB |
| `/settings` | Settings | Accounts CRUD + reorder, Categories CRUD + reorder, Tab Visibility toggle, Cloud Sync controls, Sign-out, Backup & Restore (JSON export/import, CSV export, CSV import from Google Sheets) |

### Responsive Layout

- **Mobile (<768px):** Single column, fixed bottom tab bar (5 tabs, z-20, safe-area-inset), card layouts for Settings, collapsible Quick Add
- **Tablet (md: 768px+):** Light adjustments (side-by-side fields)
- **Desktop (lg: 1024px+):** Multi-column grids, wider max-width container (`max-w-7xl mx-auto`)

---

## 7. Test Structure

### Unit Tests (Jest)

Config: `jest.config.js` — jsdom environment, ts-jest transform, `@/` path alias.

| File | Tests | Focus |
|---|---|---|
| `src/lib/aggregations.test.ts` | Account balance computation, income/expense breakdowns | Pure aggregation functions |
| `src/lib/idb.test.ts` | IDB CRUD operations, sync queue, migrations | IndexedDB operations via fake-indexeddb |
| `src/lib/csv-import.test.ts` | CSV parsing, date detection, amount parsing, carry-over logic, category inference | Parser + validator |
| `src/lib/reconciliation.test.ts` | Expected balance computation | Pure math |
| `src/hooks/useTransactions.test.ts` | Derived view hooks | Hook behavior |

Shared helpers: `src/lib/test-utils.ts` — `tx()` fixture factory for creating test transactions.

**Run:** `npm test`

### E2E Tests (Playwright)

Config: `playwright.config.ts` — 6 projects (Chromium/Firefox/WebKit × desktop, plus mobile/tablet/desktop viewport variants). Auto-starts dev server on port 3000.

| File | Tests | Focus |
|---|---|---|
| `e2e/quick-add-summary.spec.ts` | Quick Add → Summary sync | Core write→render flow |
| `e2e/settings-delete-blocked.spec.ts` | Delete-blocked-if-in-use | Settings CRUD guard |
| `e2e/payout-calculator.spec.ts` | Payout calculator flows | Split mode, validation, save |
| `e2e/budget-target-persistence.spec.ts` | Budget target reload persistence | IDB round-trip |
| `e2e/settings-orphan-review-deeplink.spec.ts` | `#orphan-review` deep link | Hydration safety, scroll to review |
| `e2e/fixtures.ts` | Shared helpers | IDB clear, page navigation |

**Run:** `npm run test:e2e`

### Quality Status

- 0 ESLint errors, 0 TypeScript errors
- 42/42 unit tests passing (per codebase audit)
- Codebase audit complete (2026-07-10): 21 findings resolved (18 fixed, 3 won't-fix)
- Accessibility audit complete: WCAG 2.2 Level AA targets met

---

## 8. Spec Status

### Completed (all done)

| Spec | Status | Key Notes |
|---|---|---|
| Phase 1 Budget Tracker | Done | All 9 tasks. Feature parity with Google Sheets |
| Responsive Layout Pass | Done | Multi-column grids at lg:. Manual check at 375/768/1280px |
| Local-First Sync (Supabase) | Done | Outbox pattern, LWW, per-user isolation, auto-sync |
| Budget Target Persistence | Done | Hybrid: global defaults + per-month overrides in IDB |
| Transaction Editing | Done | Edit modal with shared TransactionFormFields. Focus trap |
| E2E Testing (Playwright) | Done | 66 tests, 6 projects, cross-browser + viewport regression |
| Magic-Link Auth | Done | Invite-only, useEffect-based route guard |
| User Data Isolation | Done | user_id on all tables, RLS, cache wipe on user switch |
| Backup & Restore | Done | JSON export/import (all stores), CSV export/import |
| CSV Import | Done | Google Sheets format, carry-over→starting balance, bulk atomic import |
| Codebase Audit | Done | 21 findings resolved. Clean codebase |
| Empty State / Onboarding | Done | All pages show import guidance when empty |
| Seed Data Removal | Done | App starts clean — user imports their own data |
| Category Reordering | Done | sortOrder field, DB v6 migration, up/down buttons |
| Bottom Tab Bar | Done | Mobile fixed bottom nav, tab visibility prefs |

### Deferred

| Spec | Status |
|---|---|
| Phase 2 — Stock Portfolio Tracker | Deferred (ticker, shares, cost basis, DCA rotation log) |

---

## 9. Known Design Decisions

| Decision | Rationale |
|---|---|
| `idb.ts` unsplit (~1155 lines) | DB code is tightly coupled (schema, migrations, CRUD, sync queue, export/import). Splitting scatters without benefit. |
| `useAccounts`/`useCategories` not generic | Meaningful differences between them (refresh behavior, type-specific queries). Generic adds more code than it saves. |
| `redirect()` replaced with `router.replace()` | Next.js 16 throws mid-render, corrupts hooks ordering. useEffect-based redirect prevents crash. |
| Payout doesn't create ledger transactions | Calculator only. Phase 1 scope. User confirmed. |
| Sync queue discarded on user switch | Intentional: unsynced offline changes from another user should not pollute new user's queue. |
| `lastUserId` localStorage marker | Prevents full cache wipe + re-pull on same-user page refresh. |
| Monotonic counter for sync ordering | `Date.now()` collides during bulk import (same ms). `++syncSeqCounter` guarantees FIFO. |

---

## 10. Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Development server (localhost:3000) |
| `npm run build` | Production build |
| `npm run start` | Serve production build |
| `npm run lint` | ESLint |
| `npm test` | Unit tests (Jest) |
| `npm run test:e2e` | E2E tests (Playwright) |
| `npm run version:bump` | Auto-increment patch, stage `src/lib/version.ts` |

---

## 11. Deployment

Static export. Deploy `.next/` to Vercel, Cloudflare Pages, or any static host. Zero backend config — auth and sync connect to Supabase project at runtime via `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `.env.local`.

---

## 12. What's Left

- **Phase 2 (deferred):** Stock Portfolio Tracker, Dividend Log, DCA Rotation Log
- **No CI pipeline** — tests run locally before manual releases
- **No auto-backup** — user must export manually; Supabase sync provides cross-device redundancy
