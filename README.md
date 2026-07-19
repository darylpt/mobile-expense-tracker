# Expense Tracker PWA

A local-first personal finance tracker with optional Supabase cloud sync.
Data lives in IndexedDB on your device — the app works fully offline.
When Supabase is configured, changes sync across devices automatically.

**Status:** Phase 1 complete. Active use since June 2026. **v0.1.8**

---

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) |
| UI | React 19, Tailwind CSS 4 |
| Storage | IndexedDB via [`idb`](https://github.com/jakearchibald/idb) v8 |
| Cloud Sync | Supabase (Postgres + Auth + REST API) |
| Auth | Supabase Auth (magic link, invite-only) |
| Language | TypeScript strict |
| Testing | Jest 30 (unit) + Playwright 1.61 (E2E) |
| Linting | ESLint 9 with `eslint-config-next` |

Everything is `'use client'` — no server components, API routes, or server actions.

---

## Architecture

```
src/
├── app/                    # Next.js App Router pages
│   ├── page.tsx            # /          – Summary / Dashboard
│   ├── login/
│   │   └── page.tsx        # /login     – Magic-link sign-in
│   ├── transactions/
│   │   └── page.tsx        # /transactions – Full transaction list
│   ├── available-balance/
│   │   └── page.tsx        # /available-balance – Cash reconciliation
│   ├── payout/
│   │   └── page.tsx        # /payout    – Payout calculator
│   └── settings/
│       └── page.tsx        # /settings  – Accounts, Categories, Cloud Sync, Backup
├── components/
│   ├── common/             # Button, Input, Dropdown
│   ├── forms/              # QuickAddForm, EditTransactionModal, TransactionFormFields
│   ├── layout/             # Header (tab nav, user email, sign-out, version badge, sync status, mobile bottom nav)
│   ├── summary/            # TransactionList, MonthlySummaryCard, CategoryBreakdown
│   └── available-balance/  # CashDenominationInput
├── context/
│   ├── AuthContext.tsx     # Auth provider, route guard, sign-in/sign-out
│   └── TransactionContext.tsx  # Global state + auth-aware cache lifecycle
├── hooks/
│   ├── useTransactions.ts     # Derived views from TransactionContext
│   ├── useAccounts.ts         # Account CRUD
│   └── useCategories.ts       # Category CRUD
├── lib/
│   ├── idb.ts                 # IndexedDB CRUD + sync queue + migrations
│   ├── sync.ts                # Outbox sync (processSyncQueue, pullStore, backgroundSync)
│   ├── supabase.ts            # Supabase client (null if env vars missing)
│   ├── utils.ts               # Formatting, date math, aggregations
│   ├── aggregations.ts        # Account balance, income/expense breakdown
│   ├── reconciliation.ts      # Expected balance computation
│   ├── csv-import.ts          # Google Sheets CSV import
│   ├── constants.ts           # DB config, store names
│   └── *.test.ts              # Co-located unit tests
└── types/
    └── index.d.ts             # All TypeScript interfaces
```

### Data flow

```
UI Components → hooks → TransactionContext (in-memory cache)
                            ↕
                      idb.ts (IndexedDB — source of truth)
                            ↕
                    sync.ts (outbox queue → Supabase REST)
```

### Sync architecture (outbox pattern)

Every local CRUD enqueues a sync entry **inside the same IndexedDB transaction**
as the data write (atomic by construction). A background sync loop:

1. Reads pending entries FIFO (monotonic counter orders them)
2. Upserts to Supabase (user_id-stamped for per-user isolation)
3. Pulls remote changes and merges via LWW (Last-Writer-Wins by `updated_at`)
4. Auto-sync triggers 2 seconds after every CRUD (debounced)
5. Last sync time saved to `localStorage('last_sync_time')` — displayed as relative time in header

Soft-delete strategy: "Delete" sets `deleted_at` on Supabase (never hard-delete).
During pull, soft-deleted records are purged from local IDB.

---

## Routes / Screens

### `/login` — Magic-link sign-in

Shown when Supabase is configured and no session exists. Enter email → receive
magic link. Invite-only (no sign-up form). When Supabase is not configured,
auth is disabled entirely and the app works fully offline.

### `/` — Summary / Dashboard

Month navigation, 4 metric cards (Income, Expenses, Net, Count), Accounts
table (starting balance / inflow / outflow / ending), Income Breakdown table,
Expenses Breakdown table with budget targets. Inline budget editor via "Edit
Budgets" button. Category and Account breakdown charts via tabs.

**Mobile (<768px):** Accounts table, Income table, and Expenses table are hidden.
Replaced by a grouped CategoryBreakdown (Income/Expenses/Transfers sections) with
progress bars. Quick Add form is collapsed by default — tap to expand.

### `/transactions` — Transaction List

Full list with URL search-param filtering: type chips (income/expense/transfer),
month range, account, category, text search. Date grouping toggle, pagination
(50/page) when no filters active. Mobile card layout, desktop table layout.
Edit modal and inline delete.

### `/available-balance` — Cash Reconciliation

Per-account expected balance computed from transaction history up to a user-
selected date. Cash account has a denomination breakdown grid (₱1000, ₱500,
… ₱1). Difference column shows variance. Read-only — no adjusting entries.

### `/payout` — Payout Calculator

Standalone calculator for splitting a total amount across people (default:
Savings, Gy, John, Sona, Daryl). Percentage or flat-amount mode. Savings row
has a sub-split (Emergency/Wants/Investment/Motor). Saves to IndexedDB but
does **not** create ledger transactions.

### `/settings` — Settings

**Accounts:** inline add/edit/delete with delete-blocked-if-in-use checks,
drag-and-drop reordering. **Categories:** grouped by type (Income/Expense/Transfer),
same CRUD + reorder. Same-name categories allowed across types.
**Tab Visibility:** toggle Balances/Payout/Stocks tabs on/off. **Cloud Sync:** sync
status, last sync time, Sync Now, Re-sync All buttons. **Sign out** (visible
when authenticated). **Backup & Restore:** export all data as JSON, export
transactions as CSV, import from JSON or CSV (Google Sheets format).

---

## Data Model

### Stores (IndexedDB)

All 6 data stores plus sync queue are managed by `idb.ts`.

| Store | Key | Records |
|---|---|---|
| `transactions` | `id` (UUID) | Income, expense, and transfer records |
| `accounts` | `id` (UUID) | Named accounts with starting balance + sort order |
| `categories` | `id` (UUID) | Categorized by type (expense/income/transaction) + sort order |
| `cashDenominations` | `id` (UUID) | Per-date snapshots of cash on hand by denomination |
| `payouts` | `id` (UUID) | Saved payout calculations |
| `budgetTargets` | `id` (UUID) | Per-category planned amounts (global default or per-month) |
| `syncQueue` | auto-key | Pending outbound sync entries (FIFO by timestamp) |

### Key Types

Full definitions in `src/types/index.d.ts`.

---

## Setup

```bash
npm install
npm run dev              # Start dev server at http://localhost:3000
```

The app starts clean with no seed data. Import your data via CSV (Settings →
Import CSV) or restore a JSON backup.

### Optional: Supabase Cloud Sync

1. Create a Supabase project
2. Copy the project URL and anon key into `.env.local`:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
   ```
3. Run the migrations in `supabase/migrations/` via Supabase Dashboard →
   SQL Editor (run in order: 001, 002, 003)
4. Invite users via Supabase Dashboard → Authentication → Users → Invite
5. Restart the dev server — the login page appears on next load

### Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run start` | Serve production build |
| `npm run lint` | ESLint |
| `npm test` | Unit tests (Jest) |
| `npm run test:e2e` | E2E tests (Playwright) |
| `npm run version:bump` | Auto-increment patch version, stage `src/lib/version.ts` |

---

## Deployment

Deploy anywhere that serves static files:

```bash
npm run build
# Deploy the .next/ directory to Vercel, Cloudflare Pages, etc.
```

**Recommended:** Vercel (optimized for Next.js), Cloudflare Pages, or any
static host. Zero backend configuration required — auth and sync connect to
your Supabase project at runtime.

---

## Backup & Restore

**This is critical.** All data lives in IndexedDB in your browser — clear site
data, switch devices, or have the PWA evicted for storage pressure and the
ledger is gone. **Export regularly.**

From **Settings → Backup & Restore**:

- **Export All (JSON)** — downloads all 6 stores as a single `.json` file.
- **Export Transactions (CSV)** — downloads transactions only for spreadsheet
  analysis.
- **Import from file…** — select a previously exported `.json` file to
  restore all data. Confirms before overwriting.
- **Import CSV (Google Sheets)** — paste Google Sheets CSV data, preview,
  bulk-import accounts, categories, and transactions.

There is no auto-backup. Make it a habit to export after significant data entry.
Cloud sync via Supabase provides cross-device redundancy.

---

## Specs

Detailed specs live in [`specs/`](./specs/). The [index](./specs/README.md)
tracks what's done, in progress, and deferred.
