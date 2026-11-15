// ============================================================
// stock-prices.ts — Phisix API price lookup for PH stocks
//
// Uses phisix-api3.appspot.com (community-maintained, CORS-friendly).
// No .PS suffix — just bare ticker uppercased.
// ============================================================

import { getAllStocks, updateStock } from './idb';

const BASE = 'https://phisix-api3.appspot.com';

/** Single price result from Phisix API */
export interface StockPriceResult {
  ticker: string;
  price: number | null;
  currency: string | null;
  error?: string;
}

/**
 * Fetch the current price for a single Philippine stock ticker.
 * Returns { price, currency } or null on failure.
 *
 * Uses Phisix API — bare ticker, no .PS suffix.
 */
export async function fetchStockPrice(ticker: string): Promise<{ price: number; currency: string } | null> {
  const symbol = ticker.toUpperCase();
  const url = `${BASE}/stocks/${encodeURIComponent(symbol)}.json`;

  try {
    const res = await fetch(url);

    if (res.status === 429) {
      console.warn(`[stock-prices] Rate limited for ${symbol}`);
      return null;
    }

    if (!res.ok) {
      console.warn(`[stock-prices] HTTP ${res.status} for ${symbol}`);
      return null;
    }

    const data = await res.json();
    const stock = data?.stocks?.[0];
    if (!stock) {
      console.warn(`[stock-prices] No stock data for ${symbol}`);
      return null;
    }

    const price = stock?.price?.amount;
    const currency = stock?.price?.currency ?? 'PHP';

    if (typeof price !== 'number' || isNaN(price)) {
      console.warn(`[stock-prices] Invalid price for ${symbol}:`, price);
      return null;
    }

    return { price, currency };
  } catch (err) {
    console.warn(`[stock-prices] Network error for ${symbol}:`, err);
    return null;
  }
}

/**
 * Batch-fetch prices for all stocks in one API call and update IndexedDB.
 * Returns results for each ticker (success or failure).
 *
 * Fetches the full PSE board from /stocks.json and matches against the
 * user's portfolio by uppercase ticker.
 *
 * `isCurrent` is the caller's live scope predicate. It is checked before the
 * local read, after each await (local read, network response, JSON body), and
 * immediately before every admitted stock write. Once it turns false the
 * refresh stops and returns no results; a write already admitted while the
 * scope was current may still finish.
 */
export async function refreshAllPrices(
  isCurrent: () => boolean,
): Promise<StockPriceResult[]> {
  if (!isCurrent()) return [];

  const stocks = await getAllStocks();
  if (!isCurrent()) return [];
  if (stocks.length === 0) return [];

  const results: StockPriceResult[] = [];

  let allStocks: Array<{ symbol: string; price: { currency: string; amount: number } }>;
  try {
    const res = await fetch(`${BASE}/stocks.json`);
    if (!isCurrent()) return [];
    if (!res.ok) {
      const networkErr = `Phisix returned HTTP ${res.status}`;
      for (const stock of stocks) {
        results.push({ ticker: stock.ticker, price: null, currency: null, error: networkErr });
      }
      return results;
    }
    const data = await res.json();
    if (!isCurrent()) return [];
    allStocks = data?.stocks ?? [];
  } catch (err) {
    if (!isCurrent()) return [];
    console.warn('[stock-prices] Network error fetching all stocks:', err);
    for (const stock of stocks) {
      results.push({ ticker: stock.ticker, price: null, currency: null, error: 'Network error' });
    }
    return results;
  }

  // Build lookup by uppercased symbol
  const lookup = new Map<string, { symbol: string; price: { currency: string; amount: number } }>();
  for (const s of allStocks) {
    lookup.set(s.symbol.toUpperCase(), s);
  }

  for (const stock of stocks) {
    const match = lookup.get(stock.ticker.toUpperCase());
    if (!match) {
      results.push({ ticker: stock.ticker, price: null, currency: null, error: 'Not listed on PSE' });
      continue;
    }

    const price = match.price?.amount;
    const currency = match.price?.currency ?? 'PHP';

    if (typeof price !== 'number' || isNaN(price)) {
      results.push({ ticker: stock.ticker, price: null, currency: null, error: 'Invalid price' });
      continue;
    }

    // Admission check: never start a stock + outbox write after the page
    // scope has been revoked. Admitted writes are not rolled back.
    if (!isCurrent()) return [];

    await updateStock({
      id: stock.id,
      currentPrice: price,
      priceUpdatedAt: Date.now(),
    });

    results.push({ ticker: stock.ticker, price, currency });
  }

  return results;
}
