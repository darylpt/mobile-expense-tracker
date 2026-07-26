// ============================================================
// Portfolio API Server — Bridge between Hermes Agent and
// the Expense Tracker's Supabase-backed portfolio data.
//
// Run:   npm run server          (port 4000)
//        PORT=4001 npm run server
//
// Endpoints:
//   GET /api/holdings       — Computed portfolio (what Hermes needs)
//   GET /api/transactions   — Raw buy/sell transactions
//   GET /api/dividends      — Dividend records
//   GET /api/portfolio      — Everything bundled
//   GET /                   — Serving the PWA static export
//
// Env (reads from .env.local or process.env):
//   SUPABASE_URL             — required (same as NEXT_PUBLIC_SUPABASE_URL)
//   SUPABASE_SERVICE_KEY     — required (Supabase service_role key, safe on localhost)
//   PORTFOLIO_USER_ID        — required (your Supabase auth UUID to scope queries)
//   PORT                     — optional (default 4000)
//
// Why service_role key?
//   The stock tables use RLS with auth.uid() = user_id. A server-side query
//   with the anon key returns zero rows (no JWT). The service_role key
//   bypasses RLS, so we filter by user_id manually — safe because the
//   server only listens on localhost.
// ============================================================

import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ── Load .env.local if present ────────────────────────────
const envPath = resolve(process.cwd(), '.env.local');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    // Don't override already-set env vars
    if (!process.env[key]) process.env[key] = val;
  }
}

// ── Config ────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '4000', 10);
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const USER_ID = process.env.PORTFOLIO_USER_ID || '';
const STATIC_DIR = resolve(process.cwd(), 'out');

// ── Boot checks ───────────────────────────────────────────
const errors: string[] = [];
if (!SUPABASE_URL) errors.push('SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) not set');
if (!SUPABASE_SERVICE_KEY) errors.push('SUPABASE_SERVICE_KEY not set');
if (!USER_ID) errors.push('PORTFOLIO_USER_ID not set (your Supabase auth UUID)');
if (errors.length > 0) {
  console.error('❌ Missing configuration:');
  errors.forEach(e => console.error(`   - ${e}`));
  console.error('\nSet them in .env.local or pass as environment variables.');
  process.exit(1);
}

// ── Supabase client (service_role → bypasses RLS) ─────────
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── Express ───────────────────────────────────────────────
const app = express();
app.use(cors());

// ── Types (replica of src/types/index.d.ts for server) ────
interface StockRow {
  id: string;
  ticker: string;
  type: 'stock' | 'fund' | null;
  name: string;
  current_price: number | null;
  price_updated_at: string | null;
  sort_order: number;
}

interface TxRow {
  id: string;
  stock_id: string;
  date: string;
  type: 'buy' | 'sell';
  shares: number;
  price_per_share: number;
  fees: number;
  total_amount: number;
  notes: string | null;
}

interface DivRow {
  id: string;
  stock_id: string;
  date: string;
  type: 'cash' | 'stock';
  amount: number;
  shares_received: number | null;
  notes: string | null;
}

// ── Holdings computation (port of src/lib/holdings.ts) ────
interface HoldingComputed {
  ticker: string;
  name: string;
  type: 'stock' | 'fund' | 'stock (default)';
  shares: number;
  avgCostPerShare: number;
  totalCost: number;
  currentPrice: number | null;
  marketValue: number | null;
  unrealizedGainLoss: number | null;
  unrealizedGainLossPct: number | null;
}

interface HoldingsSummary {
  totalInvested: number;
  totalMarketValue: number | null;
  totalUnrealizedGL: number | null;
  totalUnrealizedGLPct: number | null;
  totalRealizedGL: number;
  totalDividends: number;
}

interface HoldingsResult {
  asOf: string;
  holdings: HoldingComputed[];
  summary: HoldingsSummary;
}

function computeHoldings(stocks: StockRow[], txs: TxRow[], divs: DivRow[]): HoldingsResult {
  // Running state: shares & total cost per stock
  const state = new Map<string, { shares: number; totalCost: number }>();
  let totalRealizedGL = 0;

  // Sort transactions oldest → newest for avg cost
  const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date));

  for (const tx of sorted) {
    const current = state.get(tx.stock_id) ?? { shares: 0, totalCost: 0 };

    if (tx.type === 'buy') {
      const cost = tx.shares * tx.price_per_share;
      state.set(tx.stock_id, {
        shares: current.shares + tx.shares,
        totalCost: current.totalCost + cost,
      });
    } else {
      // sell
      const sellQty = Math.min(tx.shares, current.shares);
      if (current.shares <= 0) continue;

      const avgCost = current.totalCost / current.shares;
      const costBasis = sellQty * avgCost;
      const proceeds = sellQty * tx.price_per_share - tx.fees;
      totalRealizedGL += proceeds - costBasis;

      const remaining = current.shares - sellQty;
      const remainingCost = current.totalCost - costBasis;
      state.set(tx.stock_id, { shares: remaining, totalCost: Math.max(0, remainingCost) });
    }
  }

  // Total dividends — Supabase amount is net (already after fee)
  let totalDividends = 0;
  for (const d of divs) {
    totalDividends += d.amount;
  }

  // Build holdings
  const holdings: HoldingComputed[] = [];
  let totalCost = 0;
  let totalMarketValue: number | null = 0;
  let hasAnyPrice = false;
  let pricedCost = 0;

  const stockMap = new Map(stocks.map(s => [s.id, s]));

  for (const [stockId, stock] of stockMap) {
    const pos = state.get(stockId) ?? { shares: 0, totalCost: 0 };
    if (pos.shares <= 0) continue;

    const avgCostPerShare = pos.shares > 0 ? pos.totalCost / pos.shares : 0;
    const currentPrice = stock.current_price;
    const marketValue = currentPrice !== null ? pos.shares * currentPrice : null;
    const unrealizedGL = marketValue !== null ? marketValue - pos.totalCost : null;
    const unrealizedGLPct = unrealizedGL !== null && pos.totalCost > 0
      ? (unrealizedGL / pos.totalCost) * 100
      : null;

    holdings.push({
      ticker: stock.ticker,
      name: stock.name,
      type: stock.type ?? 'stock (default)',
      shares: pos.shares,
      avgCostPerShare,
      totalCost: pos.totalCost,
      currentPrice,
      marketValue,
      unrealizedGainLoss: unrealizedGL,
      unrealizedGainLossPct: unrealizedGLPct,
    });

    totalCost += pos.totalCost;
    if (marketValue !== null) {
      hasAnyPrice = true;
      totalMarketValue! += marketValue;
      pricedCost += pos.totalCost;
    }
  }

  if (!hasAnyPrice) totalMarketValue = null;

  const totalUnrealizedGL = totalMarketValue !== null ? totalMarketValue - pricedCost : null;
  const totalUnrealizedGLPct = totalUnrealizedGL !== null && pricedCost > 0
    ? (totalUnrealizedGL / pricedCost) * 100
    : null;

  holdings.sort((a, b) => a.ticker.localeCompare(b.ticker));

  return {
    asOf: new Date().toISOString(),
    holdings,
    summary: {
      totalInvested: totalCost,
      totalMarketValue,
      totalUnrealizedGL,
      totalUnrealizedGLPct,
      totalRealizedGL,
      totalDividends,
    },
  };
}

// ── Query helpers ─────────────────────────────────────────
function queryAll<T>(table: string): Promise<T[]> {
  return supabase
    .from(table)
    .select('*')
    .eq('user_id', USER_ID)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .then(({ data, error }) => {
      if (error) throw error;
      return (data ?? []) as T[];
    });
}

// ── Endpoints ─────────────────────────────────────────────

/** GET /api/holdings — Computed portfolio per-ticker + summary */
app.get('/api/holdings', async (_req, res) => {
  try {
    const [stocks, txs, divs] = await Promise.all([
      queryAll<StockRow>('stocks'),
      queryAll<TxRow>('stock_transactions'),
      queryAll<DivRow>('dividends'),
    ]);

    const result = computeHoldings(stocks, txs, divs);
    res.json(result);
  } catch (err) {
    console.error('[holdings]', err);
    res.status(500).json({ error: 'Failed to compute holdings', detail: String(err) });
  }
});

/** GET /api/transactions — Raw buy/sell log (sorted newest first) */
app.get('/api/transactions', async (_req, res) => {
  try {
    const txs = await queryAll<TxRow>('stock_transactions');
    // Sort newest first (for display)
    txs.sort((a, b) => b.date.localeCompare(a.date));
    res.json({ asOf: new Date().toISOString(), transactions: txs });
  } catch (err) {
    console.error('[transactions]', err);
    res.status(500).json({ error: 'Failed to fetch transactions', detail: String(err) });
  }
});

/** GET /api/dividends — Dividend records (sorted newest first) */
app.get('/api/dividends', async (_req, res) => {
  try {
    const divs = await queryAll<DivRow>('dividends');
    divs.sort((a, b) => b.date.localeCompare(a.date));
    res.json({ asOf: new Date().toISOString(), dividends: divs });
  } catch (err) {
    console.error('[dividends]', err);
    res.status(500).json({ error: 'Failed to fetch dividends', detail: String(err) });
  }
});

/** GET /api/portfolio — Everything bundled in one call */
app.get('/api/portfolio', async (_req, res) => {
  try {
    const [stocks, txs, divs] = await Promise.all([
      queryAll<StockRow>('stocks'),
      queryAll<TxRow>('stock_transactions'),
      queryAll<DivRow>('dividends'),
    ]);

    const holdings = computeHoldings(stocks, txs, divs);

    res.json({
      asOf: holdings.asOf,
      holdings,
      raw: {
        stocks: stocks.map(s => ({
          id: s.id, ticker: s.ticker, type: s.type, name: s.name,
          currentPrice: s.current_price, priceUpdatedAt: s.price_updated_at,
        })),
        transactions: txs.sort((a, b) => b.date.localeCompare(a.date)),
        dividends: divs.sort((a, b) => b.date.localeCompare(a.date)),
      },
    });
  } catch (err) {
    console.error('[portfolio]', err);
    res.status(500).json({ error: 'Failed to fetch portfolio', detail: String(err) });
  }
});

/** GET / — Serve the static PWA export if available */
app.use(express.static(STATIC_DIR));

// Catch-all for SPA client-side routing (non-API paths)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(resolve(STATIC_DIR, 'index.html'), (err) => {
    if (err) next();
  });
});

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
┌──────────────────────────────────────────────────────┐
│  📈 Portfolio API Server                             │
│                                                      │
│  Endpoints:                                          │
│    http://localhost:${PORT}/api/holdings                 │
│    http://localhost:${PORT}/api/transactions              │
│    http://localhost:${PORT}/api/dividends                 │
│    http://localhost:${PORT}/api/portfolio                 │
│                                                      │
│  PWA served at: http://localhost:${PORT}/               │
│                                                      │
│  Hermes Agent:                                       │
│    curl http://host.docker.internal:${PORT}/api/holdings │
└──────────────────────────────────────────────────────┘
  `);
});
