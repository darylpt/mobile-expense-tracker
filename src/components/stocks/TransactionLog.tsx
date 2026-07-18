// ============================================================
// TransactionLog - Buy/sell transaction log
// Desktop: table. Mobile: card list.
// Sort by date descending.
// ============================================================

'use client';

import React, { useState } from 'react';
import { formatCurrency } from '@/lib/utils';
import { Input } from '@/components/common/Input';
import { Button } from '@/components/common/Button';
import type { StockTransaction, Stock } from '@/types';

interface TransactionLogProps {
  transactions: StockTransaction[];
  stocks: Stock[];
  onDelete: (id: string) => void;
  onUpdate: (id: string, updates: Partial<StockTransaction>) => Promise<void>;
}

interface EditForm {
  date: string;
  type: 'buy' | 'sell';
  shares: string;
  pricePerShare: string;
  fees: string;
}

export function TransactionLog({ transactions, stocks, onDelete, onUpdate }: TransactionLogProps) {
  const stockMap = new Map(stocks.map((s) => [s.id, s]));
  const sorted = [...transactions].sort((a, b) => b.date.localeCompare(a.date));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({ date: '', type: 'buy', shares: '', pricePerShare: '', fees: '' });
  const [editError, setEditError] = useState<string | null>(null);

  const startEdit = (tx: StockTransaction) => {
    setEditingId(tx.id);
    setEditForm({
      date: tx.date,
      type: tx.type,
      shares: String(tx.shares),
      pricePerShare: String(tx.pricePerShare),
      fees: String(tx.fees),
    });
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditError(null);
  };

  const handleSaveEdit = async (id: string) => {
    setEditError(null);
    const s = parseFloat(editForm.shares);
    const p = parseFloat(editForm.pricePerShare);
    const f = parseFloat(editForm.fees) || 0;
    if (!editForm.date) { setEditError('Date is required.'); return; }
    if (isNaN(s) || s <= 0) { setEditError('Shares must be a positive number.'); return; }
    if (isNaN(p) || p <= 0) { setEditError('Price per share must be a positive number.'); return; }
    if (f < 0) { setEditError('Fees cannot be negative.'); return; }
    const totalAmount = editForm.type === 'buy' ? s * p + f : s * p - f;
    try {
      await onUpdate(id, {
        date: editForm.date,
        type: editForm.type,
        shares: s,
        pricePerShare: p,
        fees: f,
        totalAmount,
      });
      setEditingId(null);
    } catch {
      setEditError('Failed to save transaction.');
    }
  };

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
              <th scope="col" className="w-24 px-4 pb-3 pt-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((tx) => (
              editingId === tx.id ? (
                <tr
                  key={tx.id}
                  className="border-b border-zinc-100 bg-blue-50/40 dark:border-zinc-700 dark:bg-blue-900/10"
                >
                  <td className="px-4 py-2">
                    <Input
                      type="date"
                      value={editForm.date}
                      onChange={(e) => setEditForm({ ...editForm, date: e.target.value })}
                      aria-label="Date"
                    />
                  </td>
                  <td className="px-4 py-2 font-medium text-zinc-500 dark:text-zinc-400">
                    {stockMap.get(tx.stockId)?.ticker ?? tx.stockId}
                  </td>
                  <td className="px-4 py-2">
                    <select
                      value={editForm.type}
                      onChange={(e) => setEditForm({ ...editForm, type: e.target.value as 'buy' | 'sell' })}
                      className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
                      aria-label="Type"
                    >
                      <option value="buy">Buy</option>
                      <option value="sell">Sell</option>
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <Input
                      type="number"
                      step="any"
                      min="0"
                      value={editForm.shares}
                      onChange={(e) => setEditForm({ ...editForm, shares: e.target.value })}
                      aria-label="Shares"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <Input
                      type="number"
                      step="any"
                      min="0"
                      value={editForm.pricePerShare}
                      onChange={(e) => setEditForm({ ...editForm, pricePerShare: e.target.value })}
                      aria-label="Price per share"
                      leading={<span>₱</span>}
                    />
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {formatCurrency(
                      (parseFloat(editForm.shares) || 0) * (parseFloat(editForm.pricePerShare) || 0) + (parseFloat(editForm.fees) || 0)
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="primary" size="sm" onClick={() => handleSaveEdit(tx.id)}>Save</Button>
                      <Button variant="ghost" size="sm" onClick={cancelEdit}>Cancel</Button>
                    </div>
                  </td>
                </tr>
              ) : (
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
                    <div className="flex items-center justify-end gap-0.5">
                      <button
                        onClick={() => startEdit(tx)}
                        className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-blue-600 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-blue-400"
                        aria-label="Edit transaction"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
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
                  </td>
                </tr>
              )
            ))}
          </tbody>
        </table>
        {editError && (
          <div className="border-t border-zinc-200 px-4 py-2 text-sm text-red-600 dark:border-zinc-700 dark:text-red-400">
            {editError}
          </div>
        )}
      </div>

      {/* ── Mobile cards ── */}
      <div className="divide-y divide-zinc-100 dark:divide-zinc-700 md:hidden">
        {sorted.map((tx) => {
          const ticker = stockMap.get(tx.stockId)?.ticker ?? tx.stockId;
          return editingId === tx.id ? (
            <div key={tx.id} className="space-y-3 px-4 py-3">
              <Input
                type="date"
                value={editForm.date}
                onChange={(e) => setEditForm({ ...editForm, date: e.target.value })}
                label="Date"
              />
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Type</span>
                <select
                  value={editForm.type}
                  onChange={(e) => setEditForm({ ...editForm, type: e.target.value as 'buy' | 'sell' })}
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
                  aria-label="Type"
                >
                  <option value="buy">Buy</option>
                  <option value="sell">Sell</option>
                </select>
              </div>
              <Input
                type="number"
                step="any"
                min="0"
                value={editForm.shares}
                onChange={(e) => setEditForm({ ...editForm, shares: e.target.value })}
                label="Shares"
              />
              <Input
                type="number"
                step="any"
                min="0"
                value={editForm.pricePerShare}
                onChange={(e) => setEditForm({ ...editForm, pricePerShare: e.target.value })}
                label="Price per Share"
                leading={<span>₱</span>}
              />
              <Input
                type="number"
                step="any"
                min="0"
                value={editForm.fees}
                onChange={(e) => setEditForm({ ...editForm, fees: e.target.value })}
                label="Fees"
                leading={<span>₱</span>}
              />
              <div className="text-sm text-zinc-600 dark:text-zinc-400">
                Total: <span className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                  {formatCurrency(
                    (parseFloat(editForm.shares) || 0) * (parseFloat(editForm.pricePerShare) || 0) + (parseFloat(editForm.fees) || 0)
                  )}
                </span>
              </div>
              {editError && (
                <div className="text-sm text-red-600 dark:text-red-400">{editError}</div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="primary" size="sm" onClick={() => handleSaveEdit(tx.id)}>Save</Button>
                <Button variant="ghost" size="sm" onClick={cancelEdit}>Cancel</Button>
              </div>
            </div>
          ) : (
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
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={() => startEdit(tx)}
                    className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-blue-600 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-blue-400"
                    aria-label="Edit transaction"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>
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
