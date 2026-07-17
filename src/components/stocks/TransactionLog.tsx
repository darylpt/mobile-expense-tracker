// ============================================================
// TransactionLog - Buy/sell transaction log
// Desktop: table. Mobile: card list.
// Sort by date descending.
// ============================================================

'use client';

import React from 'react';
import { formatCurrency } from '@/lib/utils';
import type { StockTransaction, Stock } from '@/types';

interface TransactionLogProps {
  transactions: StockTransaction[];
  stocks: Stock[];
  onDelete: (id: string) => void;
}

export function TransactionLog({ transactions, stocks, onDelete }: TransactionLogProps) {
  const stockMap = new Map(stocks.map((s) => [s.id, s]));
  const sorted = [...transactions].sort((a, b) => b.date.localeCompare(a.date));

  if (sorted.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-6 text-center shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No transactions yet.</p>
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
              <th scope="col" className="px-4 pb-3 pt-3">Date</th>
              <th scope="col" className="px-4 pb-3 pt-3">Ticker</th>
              <th scope="col" className="px-4 pb-3 pt-3">Type</th>
              <th scope="col" className="px-4 pb-3 pt-3 text-right">Shares</th>
              <th scope="col" className="px-4 pb-3 pt-3 text-right">Price/Share</th>
              <th scope="col" className="px-4 pb-3 pt-3 text-right">Total</th>
              <th scope="col" className="w-16 px-4 pb-3 pt-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((tx) => (
              <tr
                key={tx.id}
                className="border-b border-zinc-100 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800/30"
              >
                <td className="whitespace-nowrap px-4 py-3 text-zinc-500 dark:text-zinc-400">
                  {new Date(tx.date + 'T00:00:00').toLocaleDateString('en-US', {
                    month: 'short', day: 'numeric', year: 'numeric',
                  })}
                </td>
                <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                  {stockMap.get(tx.stockId)?.ticker ?? tx.stockId}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      tx.type === 'buy'
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                        : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                    }`}
                  >
                    {tx.type === 'buy' ? 'Buy' : 'Sell'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                  {tx.shares.toFixed(4)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                  {formatCurrency(tx.pricePerShare)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                  {formatCurrency(tx.totalAmount)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right">
                  <button
                    onClick={() => onDelete(tx.id)}
                    className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-red-600 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-red-400"
                    aria-label="Delete transaction"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Mobile cards ── */}
      <div className="divide-y divide-zinc-100 dark:divide-zinc-700 md:hidden">
        {sorted.map((tx) => {
          const ticker = stockMap.get(tx.stockId)?.ticker ?? tx.stockId;
          return (
            <div key={tx.id} className="px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{ticker}</span>
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      tx.type === 'buy'
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                        : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                    }`}
                  >
                    {tx.type === 'buy' ? 'Buy' : 'Sell'}
                  </span>
                </div>
                <button
                  onClick={() => onDelete(tx.id)}
                  className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-red-600 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-red-400"
                  aria-label="Delete transaction"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-1 text-xs">
                <div>
                  <span className="text-zinc-400 dark:text-zinc-500">Date </span>
                  <span className="text-zinc-700 dark:text-zinc-300">
                    {new Date(tx.date + 'T00:00:00').toLocaleDateString('en-US', {
                      month: 'short', day: 'numeric', year: 'numeric',
                    })}
                  </span>
                </div>
                <div className="text-right">
                  <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
                    {formatCurrency(tx.totalAmount)}
                  </span>
                </div>
              </div>
              <div className="mt-0.5 grid grid-cols-2 gap-1 text-xs">
                <div>
                  <span className="text-zinc-400 dark:text-zinc-500">Shares </span>
                  <span className="tabular-nums text-zinc-700 dark:text-zinc-300">{tx.shares.toFixed(4)}</span>
                </div>
                <div className="text-right">
                  <span className="text-zinc-400 dark:text-zinc-500">@ </span>
                  <span className="tabular-nums text-zinc-700 dark:text-zinc-300">{formatCurrency(tx.pricePerShare)}</span>
                </div>
              </div>
              {tx.fees > 0 && (
                <div className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">
                  Fees: {formatCurrency(tx.fees)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
