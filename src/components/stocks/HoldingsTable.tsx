// ============================================================
// HoldingsTable - Portfolio holdings with summary row
// Desktop: full table. Mobile: card-based layout.
// ============================================================

'use client';

import React from 'react';
import { formatCurrency } from '@/lib/utils';
import type { HoldingsResult, HoldingRow } from '@/lib/holdings';

interface HoldingsTableProps {
  holdings: HoldingsResult;
}

export function HoldingsTable({ holdings }: HoldingsTableProps) {
  const { holdings: rows, totalCost, totalMarketValue, totalUnrealizedGainLoss, totalUnrealizedGainLossPct, totalRealizedGainLoss, totalDividends } = holdings;

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-6 text-center shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No holdings yet. Add buy transactions to get started.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50">
      {/* ── Desktop table ── */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-xs font-medium uppercase text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              <th scope="col" className="px-4 pb-3 pt-3">Ticker</th>
              <th scope="col" className="px-4 pb-3 pt-3 text-right">Shares</th>
              <th scope="col" className="px-4 pb-3 pt-3 text-right">Avg Cost</th>
              <th scope="col" className="px-4 pb-3 pt-3 text-right">Current Price</th>
              <th scope="col" className="px-4 pb-3 pt-3 text-right">Market Value</th>
              <th scope="col" className="px-4 pb-3 pt-3 text-right">Gain/Loss</th>
              <th scope="col" className="px-4 pb-3 pt-3 text-right">Return</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <HoldingRowDesktop key={r.stockId} row={r} />
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-zinc-200 font-semibold text-zinc-900 dark:border-zinc-700 dark:text-zinc-100">
              <td className="px-4 pb-3 pt-3 text-xs uppercase">Total</td>
              <td className="px-4 pb-3 pt-3 text-right tabular-nums">
                {rows.reduce((s, r) => s + r.shares, 0).toFixed(4)}
              </td>
              <td className="px-4 pb-3 pt-3 text-right" />
              <td className="px-4 pb-3 pt-3 text-right" />
              <td className="px-4 pb-3 pt-3 text-right tabular-nums">
                {totalMarketValue !== null ? formatCurrency(totalMarketValue) : '—'}
              </td>
              <td className={`px-4 pb-3 pt-3 text-right tabular-nums ${gainLossClass(totalUnrealizedGainLoss)}`}>
                {totalUnrealizedGainLoss !== null ? formatCurrency(totalUnrealizedGainLoss) : '—'}
              </td>
              <td className={`px-4 pb-3 pt-3 text-right tabular-nums ${gainLossClass(totalUnrealizedGainLoss)}`}>
                {totalUnrealizedGainLossPct !== null ? `${totalUnrealizedGainLossPct >= 0 ? '+' : ''}${totalUnrealizedGainLossPct.toFixed(2)}%` : '—'}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* ── Mobile cards ── */}
      <div className="divide-y divide-zinc-100 dark:divide-zinc-700 md:hidden">
        {rows.map((r) => (
          <HoldingCard key={r.stockId} row={r} />
        ))}
      </div>

      {/* ── Summary footer (mobile + desktop) ── */}
      <div className="border-t border-zinc-200 px-4 py-4 dark:border-zinc-700">
        <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <SummaryStat label="Total Cost" value={formatCurrency(totalCost)} />
          <SummaryStat
            label="Total Value"
            value={totalMarketValue !== null ? formatCurrency(totalMarketValue) : '—'}
          />
          <SummaryStat
            label="Unrealized G/L"
            value={totalUnrealizedGainLoss !== null ? formatCurrency(totalUnrealizedGainLoss) : '—'}
            className={gainLossClass(totalUnrealizedGainLoss)}
          />
          <SummaryStat
            label="Realized G/L"
            value={formatCurrency(totalRealizedGainLoss)}
            className={gainLossClass(totalRealizedGainLoss)}
          />
        </div>
        <div className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          Total dividends received: {formatCurrency(totalDividends)}
        </div>
      </div>
    </div>
  );
}

// ── Desktop row ──

function HoldingRowDesktop({ row }: { row: HoldingRow }) {
  const gl = row.unrealizedGainLoss;
  const glPct = row.unrealizedGainLossPct;
  return (
    <tr className="border-b border-zinc-100 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800/30">
      <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
        {row.ticker}
        <span className="ml-1.5 text-xs font-normal text-zinc-400 dark:text-zinc-500">{row.name}</span>
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
        {row.shares.toFixed(4)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
        {formatCurrency(row.avgCostPerShare)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
        {row.currentPrice !== null ? formatCurrency(row.currentPrice) : '—'}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
        {row.marketValue !== null ? formatCurrency(row.marketValue) : '—'}
      </td>
      <td className={`px-4 py-3 text-right tabular-nums ${gainLossClass(gl)}`}>
        {gl !== null ? formatCurrency(gl) : '—'}
      </td>
      <td className={`px-4 py-3 text-right tabular-nums ${gainLossClass(gl)}`}>
        {glPct !== null ? `${glPct >= 0 ? '+' : ''}${glPct.toFixed(2)}%` : '—'}
      </td>
    </tr>
  );
}

// ── Mobile card ──

function HoldingCard({ row }: { row: HoldingRow }) {
  const gl = row.unrealizedGainLoss;
  const glPct = row.unrealizedGainLossPct;
  return (
    <div className="px-4 py-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium text-zinc-900 dark:text-zinc-100">{row.ticker}</span>
        <span className="text-xs text-zinc-400 dark:text-zinc-500">{row.name}</span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <span className="text-zinc-400 dark:text-zinc-500">Shares </span>
          <span className="tabular-nums text-zinc-700 dark:text-zinc-300">{row.shares.toFixed(4)}</span>
        </div>
        <div>
          <span className="text-zinc-400 dark:text-zinc-500">Avg </span>
          <span className="tabular-nums text-zinc-700 dark:text-zinc-300">{formatCurrency(row.avgCostPerShare)}</span>
        </div>
        <div>
          <span className="text-zinc-400 dark:text-zinc-500">Price </span>
          <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
            {row.currentPrice !== null ? formatCurrency(row.currentPrice) : '—'}
          </span>
        </div>
      </div>
      <div className="mt-1 grid grid-cols-3 gap-2 text-xs">
        <div>
          <span className="text-zinc-400 dark:text-zinc-500">Value </span>
          <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
            {row.marketValue !== null ? formatCurrency(row.marketValue) : '—'}
          </span>
        </div>
        <div className={`${gainLossClass(gl)}`}>
          <span className="text-zinc-400 dark:text-zinc-500">G/L </span>
          <span className="tabular-nums">
            {gl !== null ? formatCurrency(gl) : '—'}
          </span>
        </div>
        <div className={`${gainLossClass(gl)}`}>
          <span className="text-zinc-400 dark:text-zinc-500">Return </span>
          <span className="tabular-nums">
            {glPct !== null ? `${glPct >= 0 ? '+' : ''}${glPct.toFixed(2)}%` : '—'}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Summary stat chip ──

function SummaryStat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <p className="text-xs text-zinc-400 dark:text-zinc-500">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100 ${className ?? ''}`}>
        {value}
      </p>
    </div>
  );
}

// ── Helper ──

function gainLossClass(value: number | null): string {
  if (value === null) return '';
  if (value > 0) return 'text-emerald-700 dark:text-emerald-400';
  if (value < 0) return 'text-red-700 dark:text-red-400';
  return 'text-zinc-700 dark:text-zinc-300';
}
