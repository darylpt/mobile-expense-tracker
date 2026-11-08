# Expense Tracker PWA

A local-first personal finance tracker with optional Supabase cloud sync.
Data lives in IndexedDB on your device — the app works fully offline.
When Supabase is configured, changes sync across devices automatically.

**Status:** Phase 1 and Phase 2 complete. Active use since June 2026. Current release: [`APP_VERSION`](src/lib/version.ts).

Development agents use OMP. Before source work, read [AGENTS.md](AGENTS.md) and the [OMP development procedure](DEVELOPMENT_SOP.md), including its native Eval-to-task dispatch. The local [OMP configuration](.omp/config.yml) routes the task role to ChatGPT-backed GPT Luna at high effort and the smol/discovery roles to GPT Luna at low effort; the orchestrator and independent critic also use GPT Luna through ChatGPT-backed `openai-codex`. The retired OpenCode coder/critic aliases are not required. Canonical `npm test` and `npm run lint` discovery exclude the generated `.opencode-local/` agent workspace and continue to cover repository-owned files.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16.2.9 (App Router) |
| UI | React 19.2.4, Tailwind CSS 4 |
| Storage | IndexedDB via [`idb`](https://github.com/jakearchibald/idb) v8 |
| Cloud Sync | Supabase (Postgres + Auth + REST API) |
| Auth | Supabase Auth (Google OAuth + magic link, invite-only) + local PIN app lock |
| Language | TypeScript strict |
| Testing | Jest 30 (unit) + Playwright 1.61 (E2E) |
| Linting | ESLint 9 with `eslint-config-next` |

Every component uses `'use client'`. The Next.js app has no server components,
API routes, or server actions. The separate portfolio API uses Express.

---

## Architecture

```
├── app/
│   ├── page.tsx             # Summary / dashboard
│   ├── login/page.tsx       # Google OAuth and magic-link sign-in
│   ├── transactions/page.tsx
│   ├── available-balance/page.tsx
│   ├── payout/page.tsx
│   ├── stocks/page.tsx      # Holdings, transactions, and dividends
│   └── settings/page.tsx    # Accounts, categories, tickers, sync, backup
├── components/              # Forms, navigation, summaries, and stock views
├── context/                 # Authentication and transaction state
├── hooks/                   # Transaction, account, category, and stock data
├── lib/                     # IndexedDB, sync, calculations, import, and prices
└── types/                   # Application data types
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
2. Pushes them to Supabase with `user_id` stamping and checks the returned
   server row before removing work; failures stay durable and become `blocked`
   after five attempts
3. Pulls the signed-in user's remote rows and merges them in one IndexedDB
   transaction. Pending local edits are protected from newer remote rows and
   tombstones; competing state becomes a conflict, and untouched rows removed
   remotely are archived locally before removal
4. Auto-sync triggers 2 seconds after every CRUD (debounced)
5. Last sync time saved to `localStorage('last_sync_time')` — displayed as relative time in header

Deleting a record writes a remote tombstone and keeps a recoverable local
archive; pull does not purge rows without preserving that snapshot. For tables
with `updated_at`, the server trigger rejects older writes, but this
client-side merge is not a server-managed revision protocol: the REST protocol
has no server revisions or atomic receipts, and it does not provide
exactly-once effects, complete cloud backup, or full multi-client conflict
resolution. Pulls do not paginate.

---

## Routes and screens

### `/login` sign-in

When Supabase is configured and there is no session, users can sign in with
Google or request a magic link. Sign-up is invite-only. Without Supabase
configuration, authentication is disabled and the app works offline.

### `/` summary and dashboard

The dashboard shows monthly income, expenses, net amount, transaction count,
account balances, income and expense breakdowns, budget targets, and category
or account charts. A portfolio summary card appears when stock data exists.

On mobile, the account summary remains visible and scrolls within its card. The
income and expense tables are replaced by grouped category breakdowns with
progress bars. Quick Add starts collapsed. Its closed panel is unavailable to
keyboard and assistive-technology users.

### `/transactions` transaction list

Filter by type, month, account, category, or text. Toggle date grouping and
paginate unfiltered results at 50 rows per page. Edit or delete transactions.
The selected filters persist when you leave and return to the tab. URL queries
take precedence, and **Clear all** removes the saved selection. See the
[filter persistence contract](specs/transaction-filters.md).

### `/available-balance` cash reconciliation

Compare the expected balance from transaction history with the current balance
for each account at a selected date. Cash accounts include a denomination grid.
The page is read-only and does not create adjusting transactions.

### `/payout` payout calculator

Split a total amount by percentage or flat amount. The Savings row supports
Emergency, Wants, Investment, and Motor sub-splits. Saved calculations remain
separate from ledger transactions.

### `/settings` settings

Manage and reorder accounts, categories, and stock tickers. Set optional tab
visibility, enable or change the local PIN lock, manage cloud sync, and sign out.
Backup and restore tools export and import JSON or CSV data.

### `/stocks` stock portfolio

Track Philippine stocks and funds with holdings, buy and sell transactions,
and cash or stock dividends. Stock prices update when requested. Funds use
manual price entry. The Stocks tab is optional and hidden by default.

---

## Data model

IndexedDB uses database version 14. It has 10 application data stores and 3
local sync-safety stores.

| Store | Records |
|---|---|
| `transactions` | Income, expense, and transfer records |
| `accounts` | Named accounts with starting balances and sort order |
| `categories` | Income, expense, and transfer categories |
| `cashDenominations` | Cash-on-hand snapshots by date |
| `payouts` | Saved payout calculations |
| `budgetTargets` | Global or monthly category budgets |
| `balanceSnapshots` | Current balance snapshots by account |
| `stocks` | Stocks and funds tracked in the portfolio |
| `stockTransactions` | Stock buy and sell records |
| `dividends` | Cash and stock dividend records |
| `syncQueue` | Durable outbound operations, including blocked and conflicting work |
| `syncMeta` | Per-record sync owner, baseline/revision, and conflict state |
| `syncDeletions` | Recoverable snapshots of locally and remotely deleted records |

### Key Types

Full definitions are in `src/types/index.d.ts`.

---

## Setup

```bash
npm install
npm run dev              # Start dev server at http://localhost:3000
```

The app starts with no seed data. Import CSV data from
**Settings → Data Tools → Import / Export Data** or restore a JSON backup.

### Optional: Supabase Cloud Sync

1. Create a Supabase project
2. Copy the project URL and anon key into `.env.local`:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
   ```
3. For a new Supabase project, run migrations `001_schema.sql` through
   `006_dividend_schema_compatibility.sql` in numeric order. Migration 002
   truncates existing tables. Do not run it against data you need to keep.
4. **Enable Google OAuth** (optional but recommended):
   - Dashboard → Authentication → Providers → Google → Enable
   - Configure OAuth credentials (Google Cloud Console → Credentials)
   - Add the OAuth callback URL (e.g. `http://localhost:3000/login`) to
     Authentication → URL Configuration → Redirect URLs — the app sends
     Google OAuth callbacks to `${window.location.origin}/login`
   - Magic-link callbacks use the app origin (e.g. `http://localhost:3000`)
     instead; add both URLs if you use both sign-in methods
   - **Disable "Allow new user sign-ups"** to enforce invite-only (OAuth
     cannot pass `shouldCreateUser` on the client, so the dashboard setting
     is the only enforcement for OAuth)
5. Invite users via Supabase Dashboard → Authentication → Users → Invite
6. Restart the dev server — the login page appears on next load

| Command | Purpose |
|---|---|
| `npm run dev` | Start the development server at `http://localhost:3000` |
| `npm run build` | Build the static export in `out/` |
| `npm run lint` | Run ESLint |
| `npm test` | Run Jest unit tests |
| `npm run test:e2e` | Run Playwright tests against `next dev` |
| `npm run test:e2e:prod` | Run Playwright tests against the static export |
| `npm run server` | Start the local portfolio API on port 4000 |

---

## Portfolio API server

The optional local Express server reads synced portfolio data from Supabase
and serves JSON for tools that need current holdings. It requires a Supabase
service-role key and listens on port 4000. The server does not set a bind host,
so do not expose it to untrusted networks.

Set these values in `.env.local`:

```text
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
PORTFOLIO_USER_ID=your-auth-user-uuid
```

Start it with `npm run server`. It serves `GET /api/holdings`,
`GET /api/transactions`, `GET /api/dividends`, and `GET /api/portfolio`.
See the [Portfolio API Server guide](server/README.md) for response details.

---

## Deployment

`npm run build` creates a static export in `out/`. Deploy that directory to
Vercel, Cloudflare Pages, or another static host. The app needs no application
server. Configure Supabase at runtime if you want authentication and cloud sync.

---

## Backup and restore

After local ownership is verified, the app saves a localStorage snapshot on app
load at most once every 24 hours. It covers all 13 IndexedDB stores: the six
core financial stores, the four later financial stores, and the three local
sync-safety stores. It is not an independent backup. localStorage lives in the
same browser profile as the database, so clearing site data or browser eviction
can remove both.

**Account isolation:** the ownership check that gates these tools inspects all
13 IndexedDB stores in one readonly transaction. On a browser profile with no
saved owner, a cache that still holds any record — including only `syncQueue`,
`syncMeta`, or `syncDeletions` — is not treated as empty. It is hidden,
retained, and cannot be exported, imported, restored, or auto-backed up while
the scope remains unverified; the app has no automatic reassignment path for
such a cache. Only a cache whose 13 stores are all empty is claimed by the
newly signed-in account. This is client-side behavior: older
clients can bypass it, and the sync transport still has no server-managed
revisions or atomic receipts. See
[User Data Isolation §5](specs/user-data-isolation.md#5-fixed-behavior-unowned-safety-only-caches-fail-closed).

From **Settings → Backup & Restore** (mobile: **Settings → Data Tools →
Import / Export Data**):

- **Export All (JSON)** downloads all 13 local stores, including pending sync
  work, metadata, and deletion archives. It is a local snapshot, not proof of
  complete cloud state, and contains no authentication secrets.
- **Export Transactions (CSV)** downloads transactions for spreadsheet analysis.
- **Import from file…** replaces only the financial stores contained in the
  backup. Omitted stores stay intact, and a present empty array clears that
  store. Existing records are archived locally, pending uploads are kept for
  review, and sync-safety stores are merged rather than cleared. Reload after
  importing.
- **Restore from auto-backup** uses the same restore behavior.
- **Import from Google Sheets** previews and imports CSV data.

The automatic localStorage copy is convenient for same-device recovery, but
export a JSON file to another device or service when you need an independent
copy, especially before clearing site data or changing devices. Configured
Supabase sync is separate and is not a complete cloud backup.

---

## Specs

Detailed specs live in [`specs/`](./specs/). The [index](./specs/README.md)
tracks what's done, in progress, and deferred.
