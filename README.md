# Expense Tracker PWA

A client-only personal finance tracker that runs entirely in your browser.
No server, no cloud sync, no accounts — all data lives in IndexedDB on your
device.

**Status:** Phase 1 complete. Active use since June 2026.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) |
| UI | React 19, Tailwind CSS 4 |
| Storage | IndexedDB via [`idb`](https://github.com/jakearchibald/idb) v8 |
| Language | TypeScript strict |
| Testing | Jest 30 (unit) + Playwright 1.61 (E2E) |
| Linting | ESLint 9 with `eslint-config-next` |
| **Total dependencies** | 3 runtime (`next`, `react`, `react-dom`, `idb`) — intentionally minimal |

Everything is `'use client'` — there are no server components, API routes, or
server actions. This is a deliberate choice: your financial data never leaves
your browser.

---

## Architecture

```
src/
├── app/                    # Next.js App Router pages
│   ├── page.tsx            #  /          – Summary / Dashboard
│   ├── transactions/
│   │   └── page.tsx        #  /transactions – Full transaction list
│   ├── available-balance/
│   │   └── page.tsx        #  /available-balance – Cash reconciliation
│   ├── payout/
│   │   └── page.tsx        #  /payout    – Payout calculator
│   └── settings/
│       └── page.tsx        #  /settings  – Accounts, Categories, Backup
├── components/
│   ├── common/             # Button, Input, Dropdown
│   ├── forms/              # QuickAddForm, EditTransactionModal, TransactionFormFields
│   ├── layout/             # Header (tab navigation)
│   ├── summary/            # TransactionList, MonthlySummaryCard, CategoryBreakdown
│   └── available-balance/  # CashDenominationInput
├── context/
│   └── TransactionContext.tsx  # Global state: transactions + accounts
├── hooks/
│   ├── useTransactions.ts     # Derived views from TransactionContext
│   ├── useAccounts.ts         # Account CRUD
│   └── useCategories.ts       # Category CRUD
├── lib/
│   ├── idb.ts                 # IndexedDB CRUD + export/import
│   ├── utils.ts               # Formatting, date math, aggregations
│   ├── aggregations.ts        # Account balance, income/expense breakdown
│   ├── reconciliation.ts      # Expected balance computation
│   ├── constants.ts           # Seed data, DB config
│   ├── test-utils.ts          # Shared test fixture (tx())
│   └── *.test.ts              # Co-located unit tests
└── types/
    └── index.d.ts             # All TypeScript interfaces
```

**Data flow:** Components → hooks → `TransactionContext` (in-memory state) ↔
`idb.ts` (IndexedDB persistence). No network requests.

---

## Routes / Screens

### `/` — Summary / Dashboard

Month navigation, 4 metric cards (Income, Expenses, Net, Count), Accounts
table (starting balance / inflow / outflow / ending), Income Breakdown table,
Expenses Breakdown table with budget targets. Inline budget editor via "Edit
Budgets" button. Category and Account breakdown charts via tabs.

### `/transactions` — Transaction List

Full list with server-side (URL search param) filtering: type chips
(income/expense/transfer), month range, account, category, text search.
Mobile card layout, desktop table layout. Edit modal and inline delete.

### `/available-balance` — Cash Reconciliation

Per-account expected balance computed from transaction history up to a user-
selected date. Cash account has a denomination breakdown grid (₱1000, ₱500,
… ₱1). Difference column shows variance. Read-only — no adjusting entries
created.

### `/payout` — Payout Calculator

Standalone calculator for splitting a total amount across people (default:
Savings, Gy, John, Sona, Daryl). Percentage or flat-amount mode. Savings row
has a sub-split (Emergency/Wants/Investment/Motor). Saves to IndexedDB but
does **not** create ledger transactions.

### `/settings` — Settings

**Accounts:** inline add/edit/delete with delete-blocked-if-in-use checks.
**Categories:** grouped by type (Expense, Income, Transfer), same CRUD.
**Tab Visibility:** toggle Balances/Payout tabs on/off.
**Backup & Restore:** export all data as JSON, export transactions as CSV,
import from JSON backup.

---

## Data Model

### Stores (IndexedDB)

All 6 stores are exported/imported together as a single JSON backup file.

| Store | Key | Records |
|---|---|---|
| `transactions` | `id` (UUID) | Income, expense, and transfer records |
| `accounts` | `id` | Named accounts with starting balance |
| `categories` | `id` | Categorized by type (expense/income/transaction) |
| `cashDenominations` | `id` | Per-date snapshots of cash on hand by denomination |
| `payouts` | `id` | Saved payout calculations |
| `budgetTargets` | `id` | Per-category planned amounts (global default or per-month) |

### Key Types

**`Transaction`** — `id`, `date`, `amount`, `type` (income|expense|transaction),
`category`, `fromAccount` (nullable), `toAccount` (nullable), `description`,
`createdAt`, `updatedAt`.

**`Account`** — `id`, `name`, `startingBalance`.

**`Category`** — `id`, `name`, `type`.

Full type definitions in `src/types/index.d.ts`.

---

## Getting Started

```bash
npm install        # Install dependencies
npm run dev        # Start dev server at http://localhost:3000
```

The app seeds demo data (8 accounts, 21 categories, ~20 transactions) on
first launch so you can explore immediately.

### Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run start` | Serve production build |
| `npm run lint` | ESLint |
| `npm test` | Unit tests (Jest) |
| `npm run test:e2e` | E2E tests (Playwright) |

---

## Backup & Restore

**This is critical.** All data lives in IndexedDB in your browser — clear site
data, switch devices, or have the PWA evicted for storage pressure and the
ledger is gone.

From **Settings → Backup & Restore**:

- **Export All (JSON)** — downloads all 6 stores as a single `.json` file.
  Keep this file somewhere safe (Google Drive, iCloud, etc.).
- **Export Transactions (CSV)** — downloads transactions only for spreadsheet
  analysis.
- **Import from file…** — select a previously exported `.json` file to
  restore all data. Confirms before overwriting.

There is no auto-backup. Make it a habit to export after significant data entry.

---

## Deployment

Since it's a fully client-side PWA, deploy anywhere that serves static files:

```bash
npm run build
# Copy the .next/ directory or use `next export` (if supported) to your host
```

**Recommended:** Vercel (optimized for Next.js), Cloudflare Pages, or any
static host. Zero backend configuration required.

---

## Specs

Detailed specs live in [`specs/`](./specs/). The [index](./specs/README.md)
tracks what's done, in progress, and deferred.
