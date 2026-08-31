# Stock Portfolio Tracker (Phase 2)

**Status:** ✅ Implemented (2026-07-17 → 2026-07-25)

Add stock portfolio tracking to the expense tracker PWA. Philippine stocks only.
Separate tracking layer — no integration with expense ledger.

---

## Stories

### 1. DB Schema + Types (`stock-schema`) ✅

- Bumped `DB_VERSION` 10 → 11
- Added 3 IndexedDB stores: `stocks`, `stockTransactions`, `dividends`
- TypeScript interfaces: `Stock`, `StockTransaction`, `Dividend`
- Migration handler in `idb.ts`

### 2. Ticker CRUD (`stock-crud`) ✅

- "Manage Tickers" UI in Settings (add/edit/delete/reorder)
- Shared `ManageTickers` component reused on the Stocks page
- Ticker validation: 2-8 uppercase alphanumeric

### 3. Price Lookup (`stock-prices`) ✅

- **Phisix API** (`phisix-api3.appspot.com`) — community-maintained PSE data, CORS-friendly
- Single-ticker and batch fetch
- Manual price override for funds (no API price)
- Rate-limit/network error handling → null

### 4. Transactions + Dividends + Holdings (`stock-transactions`) ✅

- `/stocks` route with 3-section tabs: Holdings, Transactions, Dividends
- Holdings table: ticker, shares, avg cost basis, current price, market value, unrealized P&L
- Transaction log: buy/sell entries, inline edit & delete
- Dividend log: cash/stock dividends, inline edit & delete
- Weighted-average cost basis computation
- Stock vs. Fund type separation (funds use manual NAVPU, no API price)

### 5. Dashboard Widget + Tab Bar (`stock-dashboard`) ✅

- `PortfolioSummaryCard` on dashboard (total market value, invested, dividends, unrealized P&L)
- Stocks tab added to mobile bottom nav and desktop header
- Tab visibility toggle in Settings (optional tabs hidden by default)

### 6. Tests (`stock-tests`) ✅

- `holdings.test.ts` — buy/sell → correct shares, avg cost, realized P&L; partial sells; empty state
- `stock-prices.test.ts` — valid response, error handling
- 114 tests passing total

### 7. Dividend Expansion (`dividend-expansion`) ✅

- Per-share fields: `exDate`, `payDate`, `qty`, `rate`, `fee`, `dividendYield`
- Net calculation: `qty × rate − fee`
- IDB v13 migration with legacy data preservation
- Updated `DividendForm`, `DividendLog`, holdings compute

---

### 7.1 Dividend sync compatibility fix

- Added Supabase migration `006_dividend_schema_compatibility.sql` for the expanded dividend fields while preserving legacy `date` and `amount` columns.
- Normalized legacy remote records during sync so the Dividends subtab can render migrated and legacy data safely.
- Included focused tests for legacy pull normalization and expanded outbound payload compatibility.
- PortfolioSummaryCard now consumes the current StocksPage holdings state, so dividend totals refresh after dividend CRUD.

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| **Phisix API** over Yahoo Finance | Yahoo Finance CORS issues on client-side (`703a35c`, `b024f74`). Phisix is PSE-specific, CORS-friendly, no auth needed. |
| **`service_role` key** for server API | RLS blocks server-side queries with anon key. Service key bypasses RLS, filtered by `user_id` — safe because server is localhost-only. |
| **Dividend net calculation** | `qty × rate − fee` instead of storing gross amount. Consistent with brokerage statements. Legacy records keep old `amount` field. |
| **Stocks vs. Funds** | Separate `type` field (`stock` = PSE-listed/price-tracked, `fund` = UITF/mutual fund/manual NAVPU). Different columns in holdings cards. |

---

## Portfolio API Server

A local Express API (`server/index.ts`) reads portfolio data from Supabase and serves JSON for AI assistants (Hermes Agent, etc.). See [`server/README.md`](../server/README.md) or the **Portfolio API Server** section in [`README.md`](../README.md).

---

## Non-Goals

- No expense-tracker integration (stocks are a separate tracking layer)
- No DCA rotation log (buy/sell log covers it)
- No auto-refresh prices — manual button only
- No dividend → income auto-creation
- No stock split / reverse split tracking
- No Philippine fund-specific fields beyond stock/fund type
