// ============================================================
// stock-prices.ts — Yahoo Finance v8 price lookup for PH stocks
//
// PH stocks use .PS suffix (e.g. BDO → BDO.PS).
// No auto-refresh — explicit user action only.
// Rate limit / network errors → returns null, caller shows error.
// ============================================================

import { getAllStocks, updateStock } from './idb';

/** Single price result from Yahoo Finance */
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
 * Uses Yahoo Finance v8 chart API with .PS suffix.
 * Rate limit handling: if HTTP 429, returns null with error message.
 */
export async function fetchStockPrice(ticker: string): Promise<{ price: number; currency: string } | null> {
  const symbol = `${ticker.toUpperCase()}.PS`;
  // ponytail: query2 allows CORS, query1 blocks browser fetch
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;

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
    const result = data?.chart?.result?.[0];
    if (!result) {
      console.warn(`[stock-prices] No chart data for ${symbol}`);
      return null;
    }

    const meta = result.meta;
    const price = meta?.regularMarketPrice;
    const currency = meta?.currency ?? 'PHP';

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
 * Batch-fetch prices for all stocks and update their currentPrice in IndexedDB.
 * Returns results for each ticker (success or failure).
 *
 * Fetches one at a time (sequential) to avoid rate-limiting.
 * Failed tickers are returned with error details — caller can show which failed.
 */
export async function refreshAllPrices(): Promise<StockPriceResult[]> {
  const stocks = await getAllStocks();
  const results: StockPriceResult[] = [];

  for (const stock of stocks) {
    // Small delay between requests to be polite to Yahoo's servers
    if (results.length > 0) {
      await new Promise((r) => setTimeout(r, 500));
    }

    const data = await fetchStockPrice(stock.ticker);

    if (data) {
      await updateStock({
        id: stock.id,
        currentPrice: data.price,
        priceUpdatedAt: Date.now(),
      });
      results.push({ ticker: stock.ticker, price: data.price, currency: data.currency });
    } else {
      results.push({ ticker: stock.ticker, price: null, currency: null, error: 'Failed to fetch' });
    }
  }

  return results;
}
