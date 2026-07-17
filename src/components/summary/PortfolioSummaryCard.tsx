'use client';

import React, { useState, useEffect } from 'react';
import { getAllStocks, getAllStockTransactions, getAllDividends } from '@/lib/idb';
import { computeHoldings, type HoldingsResult } from '@/lib/holdings';

export function PortfolioSummaryCard() {
  const [holdings, setHoldings] = useState<HoldingsResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const stocks = await getAllStocks();
        if (stocks.length === 0) { if (mounted) setLoading(false); return; }
        const [txs, divs] = await Promise.all([
          getAllStockTransactions(),
          getAllDividends(),
        ]);
        const result = computeHoldings(stocks, txs, divs);
        if (result.holdings.length === 0) { if (mounted) setLoading(false); return; }
        if (mounted) setHoldings(result);
      } catch { /* ignore */ }
      if (mounted) setLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, []);

  if (loading || !holdings) return null;

  const fmt = (n: number) => `₱${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const pct = (n: number | null) => n !== null ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—';
  const gainClass = (n: number | null) =>
    n === null ? '' : n >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400';

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50">
      <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        📈 Portfolio
      </h2>
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Stat label="Market Value" value={holdings.totalMarketValue !== null ? fmt(holdings.totalMarketValue) : '—'} />
        <Stat label="Invested" value={fmt(holdings.totalCost)} />
        <Stat
          label="Unrealized G/L"
          value={`${fmt(holdings.totalUnrealizedGainLoss ?? 0)} (${pct(holdings.totalUnrealizedGainLossPct)})`}
          className={gainClass(holdings.totalUnrealizedGainLoss)}
        />
        <Stat label="Dividends" value={fmt(holdings.totalDividends)} />
      </div>
    </div>
  );
}

function Stat({ label, value, className = '' }: { label: string; value: string; className?: string }) {
  return (
    <div className="rounded-lg border border-zinc-100 bg-zinc-50 p-2 dark:border-zinc-700 dark:bg-zinc-800/30">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className={`text-sm font-semibold text-zinc-900 dark:text-zinc-100 tabular-nums ${className}`}>
        {value}
      </p>
    </div>
  );
}
