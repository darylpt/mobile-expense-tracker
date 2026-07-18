// ============================================================
// holdings.ts — Portfolio holdings computation
//
// Computes: shares owned, avg cost basis, market value,
// unrealized gain/loss, realized gain/loss, and dividends.
// ============================================================

import type { Stock, StockTransaction, Dividend } from '@/types';

export interface HoldingRow {
  stockId: string;
  ticker: string;
  name: string;
  shares: number;
  avgCostPerShare: number;
  totalCost: number;           // total amount paid for current holdings
  currentPrice: number | null;
  marketValue: number | null;
  unrealizedGainLoss: number | null;
  unrealizedGainLossPct: number | null;
}

export interface HoldingsResult {
  holdings: HoldingRow[];
  totalCost: number;
  totalMarketValue: number | null;
  totalUnrealizedGainLoss: number | null;
  totalUnrealizedGainLossPct: number | null;
  totalRealizedGainLoss: number;   // from sells
  totalDividends: number;
}

/**
 * Compute portfolio holdings from a list of transactions and stocks.
 *
 * Average cost basis is weighted average of all buy prices.
 * When selling: uses average cost for cost basis (not FIFO/LIFO).
 * Realized gain/loss = sell proceeds - (shares sold × avg cost at time of sale).
 *
 * Transactions are processed in chronological order.
 */
export function computeHoldings(
  stocks: Stock[],
  transactions: StockTransaction[],
  dividends: Dividend[]
): HoldingsResult {
  // ponytail: average-cost method. Simple and correct for most retail investors.
  // Add FIFO/LIFO when tax reporting requires it.

  const stockMap = new Map(stocks.map(s => [s.id, s]));

  // Sort transactions chronologically
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));

  // Running state per stock: { shares, totalCost }
  const state = new Map<string, { shares: number; totalCost: number }>();

  let totalRealizedGainLoss = 0;

  for (const tx of sorted) {
    const current = state.get(tx.stockId) ?? { shares: 0, totalCost: 0 };

    if (tx.type === 'buy') {
      // shares × pricePerShare = cost (not including fees for avg cost)
      // ponytail: fees not included in avg cost basis. Add when tax reporting needs it.
      const cost = tx.shares * tx.pricePerShare;
      const totalShares = current.shares + tx.shares;
      const totalCost = current.totalCost + cost;
      state.set(tx.stockId, { shares: totalShares, totalCost });
    } else {
      // sell
      const sellQty = Math.min(tx.shares, current.shares); // can't sell more than owned
      if (current.shares <= 0) continue; // nothing to sell

      const avgCost = current.totalCost / current.shares;
      const costBasis = sellQty * avgCost;
      const proceeds = (sellQty * tx.pricePerShare) - tx.fees;
      totalRealizedGainLoss += proceeds - costBasis;

      const remaining = current.shares - sellQty;
      const remainingCost = current.totalCost - costBasis;
      state.set(tx.stockId, { shares: remaining, totalCost: Math.max(0, remainingCost) });
    }
  }

  // Total dividends
  let totalDividends = 0;
  for (const d of dividends) {
    totalDividends += d.amount;
  }

  // Build holding rows
  const holdings: HoldingRow[] = [];
  let totalCost = 0;
  let totalMarketValue: number | null = 0;
  let hasAnyPrice = false;
  let pricedCost = 0;

  for (const [stockId, s] of stockMap) {
    const pos = state.get(stockId) ?? { shares: 0, totalCost: 0 };
    if (pos.shares <= 0) continue; // skip fully-sold stocks

    const avgCostPerShare = pos.shares > 0 ? pos.totalCost / pos.shares : 0;
    const currentPrice = s.currentPrice;
    const marketValue = currentPrice !== null ? pos.shares * currentPrice : null;
    const unrealizedGainLoss = marketValue !== null ? marketValue - pos.totalCost : null;
    const unrealizedGainLossPct = unrealizedGainLoss !== null && pos.totalCost > 0
      ? (unrealizedGainLoss / pos.totalCost) * 100
      : null;

    holdings.push({
      stockId,
      ticker: s.ticker,
      name: s.name,
      shares: pos.shares,
      avgCostPerShare,
      totalCost: pos.totalCost,
      currentPrice,
      marketValue,
      unrealizedGainLoss,
      unrealizedGainLossPct,
    });

    totalCost += pos.totalCost;
    if (marketValue !== null) {
      hasAnyPrice = true;
      totalMarketValue! += marketValue;
      pricedCost += pos.totalCost;
    }
  }

  if (!hasAnyPrice) totalMarketValue = null;

  const totalUnrealizedGainLoss = totalMarketValue !== null ? totalMarketValue - pricedCost : null;
  const totalUnrealizedGainLossPct = totalUnrealizedGainLoss !== null && pricedCost > 0
    ? (totalUnrealizedGainLoss / pricedCost) * 100
    : null;

  // Sort holdings by ticker
  holdings.sort((a, b) => a.ticker.localeCompare(b.ticker));

  return {
    holdings,
    totalCost,
    totalMarketValue,
    totalUnrealizedGainLoss,
    totalUnrealizedGainLossPct,
    totalRealizedGainLoss,
    totalDividends,
  };
}
