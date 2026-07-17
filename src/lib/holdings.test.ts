// ============================================================
// holdings.test.ts — Portfolio holdings computation tests
// ============================================================

import { computeHoldings } from './holdings';
import type { Stock, StockTransaction, Dividend } from '@/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStock(overrides: Partial<Stock> = {}): Stock {
  return {
    id: 'stock-1',
    ticker: 'BDO',
    name: 'BDO Unibank',
    currentPrice: 150,
    priceUpdatedAt: Date.now(),
    sortOrder: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function buy(
  stockId: string,
  date: string,
  shares: number,
  pricePerShare: number,
  fees = 0,
): StockTransaction {
  return {
    id: crypto.randomUUID(),
    stockId,
    date,
    type: 'buy',
    shares,
    pricePerShare,
    fees,
    totalAmount: shares * pricePerShare + fees,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function sell(
  stockId: string,
  date: string,
  shares: number,
  pricePerShare: number,
  fees = 0,
): StockTransaction {
  return {
    id: crypto.randomUUID(),
    stockId,
    date,
    type: 'sell',
    shares,
    pricePerShare,
    fees,
    totalAmount: shares * pricePerShare - fees,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function div(
  stockId: string,
  date: string,
  amount: number,
  type: 'cash' | 'stock' = 'cash',
): Dividend {
  return {
    id: crypto.randomUUID(),
    stockId,
    date,
    type,
    amount,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeHoldings', () => {
  it('returns empty holdings when there are no transactions', () => {
    const stocks = [makeStock()];
    const result = computeHoldings(stocks, [], []);
    expect(result.holdings).toHaveLength(0);
    expect(result.totalCost).toBe(0);
    expect(result.totalDividends).toBe(0);
  });

  it('computes shares and avg cost for a single buy', () => {
    const stocks = [makeStock()];
    const txs = [buy('stock-1', '2026-01-15', 100, 140)];
    const result = computeHoldings(stocks, txs, []);

    expect(result.holdings).toHaveLength(1);
    const h = result.holdings[0];
    expect(h.shares).toBe(100);
    expect(h.avgCostPerShare).toBe(140);
    expect(h.totalCost).toBe(14000);
  });

  it('computes weighted average cost for multiple buys', () => {
    const stocks = [makeStock()];
    const txs = [
      buy('stock-1', '2026-01-15', 100, 140),  // cost: 14,000
      buy('stock-1', '2026-02-15', 50, 160),   // cost: 8,000
    ];
    const result = computeHoldings(stocks, txs, []);

    const h = result.holdings[0];
    expect(h.shares).toBe(150);
    expect(h.totalCost).toBe(22000);
    expect(h.avgCostPerShare).toBeCloseTo(146.67, 1);
  });

  it('computes market value and unrealized gain/loss from currentPrice', () => {
    const stocks = [makeStock({ currentPrice: 150 })];
    const txs = [buy('stock-1', '2026-01-15', 100, 140)];
    const result = computeHoldings(stocks, txs, []);

    const h = result.holdings[0];
    expect(h.marketValue).toBe(15000);
    expect(h.unrealizedGainLoss).toBe(1000); // 15000 - 14000
    expect(h.unrealizedGainLossPct).toBeCloseTo(7.14, 1);
  });

  it('returns null market value when no currentPrice', () => {
    const stocks = [makeStock({ currentPrice: null })];
    const txs = [buy('stock-1', '2026-01-15', 100, 140)];
    const result = computeHoldings(stocks, txs, []);

    const h = result.holdings[0];
    expect(h.marketValue).toBeNull();
    expect(h.unrealizedGainLoss).toBeNull();
  });

  it('computes realized gain/loss on partial sell (average cost method)', () => {
    const stocks = [makeStock({ currentPrice: 160 })];
    const txs = [
      buy('stock-1', '2026-01-15', 100, 140),   // avg cost: 140
      sell('stock-1', '2026-02-15', 50, 160),    // sell 50 @ 160 = 8000, cost basis = 50*140 = 7000
    ];
    const result = computeHoldings(stocks, txs, []);

    // Realized gain: 8000 - 7000 = 1000
    expect(result.totalRealizedGainLoss).toBeCloseTo(1000, 0);

    // Remaining: 50 shares @ avg cost 140
    const h = result.holdings[0];
    expect(h.shares).toBe(50);
    expect(h.totalCost).toBeCloseTo(7000, 0);
  });

  it('computes realized loss on sell below cost', () => {
    const stocks = [makeStock()];
    const txs = [
      buy('stock-1', '2026-01-15', 100, 140),
      sell('stock-1', '2026-02-15', 50, 120),   // sell 50 @ 120 = 6000, cost basis = 7000
    ];
    const result = computeHoldings(stocks, txs, []);

    expect(result.totalRealizedGainLoss).toBeCloseTo(-1000, 0);
  });

  it('includes fees in realized gain/loss (fees reduce proceeds)', () => {
    const stocks = [makeStock()];
    const txs = [
      buy('stock-1', '2026-01-15', 100, 140),
      sell('stock-1', '2026-02-15', 100, 160, 50), // proceeds = 16000-50 = 15950, cost = 14000
    ];
    const result = computeHoldings(stocks, txs, []);

    // Realized: 15950 - 14000 = 1950
    expect(result.totalRealizedGainLoss).toBeCloseTo(1950, 0);
    // No holdings left
    expect(result.holdings).toHaveLength(0);
  });

  it('sums total dividends', () => {
    const stocks = [makeStock()];
    const txs: StockTransaction[] = [];
    const dividends = [
      div('stock-1', '2026-03-15', 500),
      div('stock-1', '2026-06-15', 750),
    ];
    const result = computeHoldings(stocks, txs, dividends);

    expect(result.totalDividends).toBe(1250);
  });

  it('handles multiple stocks independently', () => {
    const stocks = [
      makeStock({ id: 'bdo', ticker: 'BDO', currentPrice: 150 }),
      makeStock({ id: 'sm', ticker: 'SM', currentPrice: 900 }),
    ];
    const txs = [
      buy('bdo', '2026-01-15', 100, 140),
      buy('sm', '2026-01-15', 10, 850),
    ];
    const result = computeHoldings(stocks, txs, []);

    expect(result.holdings).toHaveLength(2);
    const bdo = result.holdings.find((h) => h.ticker === 'BDO')!;
    const sm = result.holdings.find((h) => h.ticker === 'SM')!;
    expect(bdo.shares).toBe(100);
    expect(sm.shares).toBe(10);
    expect(bdo.marketValue).toBe(15000);
    expect(sm.marketValue).toBe(9000);
  });

  it('processes transactions in chronological order', () => {
    const stocks = [makeStock()];
    const txs = [
      sell('stock-1', '2026-01-15', 50, 150),  // nothing to sell yet
      buy('stock-1', '2026-02-15', 100, 140),   // buy 100 @ 140
    ];
    const result = computeHoldings(stocks, txs, []);

    // The sell on Jan 15 should be ignored (no shares owned)
    // Then buy 100 on Feb 15
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].shares).toBe(100);
  });

  it('returns correct aggregate totals', () => {
    const stocks = [
      makeStock({ id: 'bdo', currentPrice: 150 }),
      makeStock({ id: 'sm', currentPrice: 900 }),
    ];
    const txs = [
      buy('bdo', '2026-01-15', 100, 140),
      buy('sm', '2026-01-15', 10, 850),
    ];
    const result = computeHoldings(stocks, txs, []);

    expect(result.totalCost).toBe(22500);        // 14000 + 8500
    expect(result.totalMarketValue).toBe(24000); // 15000 + 9000
    expect(result.totalUnrealizedGainLoss).toBe(1500);
    expect(result.totalUnrealizedGainLossPct).toBeCloseTo(6.67, 1);
  });
});
