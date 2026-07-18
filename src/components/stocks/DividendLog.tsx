// ============================================================
// DividendLog - Dividend records log
// Desktop: table. Mobile: card list.
// Sort by date descending.
// ============================================================

'use client';

import React, { useState } from 'react';
import { formatCurrency } from '@/lib/utils';
import { Input } from '@/components/common/Input';
import { Button } from '@/components/common/Button';
import type { Dividend, Stock } from '@/types';

interface DividendLogProps {
  dividends: Dividend[];
  stocks: Stock[];
  onDelete: (id: string) => void;
  onUpdate: (id: string, updates: Partial<Dividend>) => Promise<void>;
}

interface EditForm {
  date: string;
  type: 'cash' | 'stock';
  amount: string;
  sharesReceived: string;
  notes: string;
}

export function DividendLog({ dividends, stocks, onDelete, onUpdate }: DividendLogProps) {
  const stockMap = new Map(stocks.map((s) => [s.id, s]));
  const sorted = [...dividends].sort((a, b) => b.date.localeCompare(a.date));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({ date: '', type: 'cash', amount: '', sharesReceived: '', notes: '' });
  const [editError, setEditError] = useState<string | null>(null);

  const startEdit = (d: Dividend) => {
    setEditingId(d.id);
    setEditForm({
      date: d.date,
      type: d.type,
      amount: String(d.amount),
      sharesReceived: d.sharesReceived != null ? String(d.sharesReceived) : '',
      notes: d.notes ?? '',
    });
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditError(null);
  };

  const handleSaveEdit = async (id: string) => {
    setEditError(null);
    if (!editForm.date) { setEditError('Date is required.'); return; }
    const amt = parseFloat(editForm.amount);
    if (isNaN(amt) || amt <= 0) { setEditError('Amount must be a positive number.'); return; }
    let shares: number | null = null;
    if (editForm.type === 'stock') {
      const s = parseFloat(editForm.sharesReceived);
      if (isNaN(s) || s <= 0) { setEditError('Shares received must be a positive number for stock dividends.'); return; }
      shares = s;
    }
    try {
      await onUpdate(id, {
        date: editForm.date,
        type: editForm.type,
        amount: amt,
        sharesReceived: shares,
        notes: editForm.notes.trim() || null,
      });
      setEditingId(null);
    } catch {
      setEditError('Failed to save dividend.');
    }
  };

  if (sorted.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-6 text-center shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No dividends recorded yet.</p>
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
              <th scope="col" className="px-4 pb-3 pt-3 text-right">Amount</th>
              <th scope="col" className="px-4 pb-3 pt-3 text-right">Shares Received</th>
              <th scope="col" className="w-24 px-4 pb-3 pt-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((d) => (
              editingId === d.id ? (
                <tr
                  key={d.id}
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
                    {stockMap.get(d.stockId)?.ticker ?? d.stockId}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex gap-3">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="radio"
                          name={`div-type-${d.id}`}
                          value="cash"
                          checked={editForm.type === 'cash'}
                          onChange={() => setEditForm({ ...editForm, type: 'cash', sharesReceived: '' })}
                          className="text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-sm text-zinc-900 dark:text-zinc-100">Cash</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="radio"
                          name={`div-type-${d.id}`}
                          value="stock"
                          checked={editForm.type === 'stock'}
                          onChange={() => setEditForm({ ...editForm, type: 'stock' })}
                          className="text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-sm text-zinc-900 dark:text-zinc-100">Stock</span>
                      </label>
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    <Input
                      type="number"
                      step="any"
                      min="0"
                      value={editForm.amount}
                      onChange={(e) => setEditForm({ ...editForm, amount: e.target.value })}
                      aria-label="Amount"
                      leading={<span>₱</span>}
                    />
                  </td>
                  <td className="px-4 py-2">
                    {editForm.type === 'stock' ? (
                      <Input
                        type="number"
                        step="any"
                        min="0"
                        value={editForm.sharesReceived}
                        onChange={(e) => setEditForm({ ...editForm, sharesReceived: e.target.value })}
                        aria-label="Shares received"
                      />
                    ) : (
                      <span className="text-sm text-zinc-400 dark:text-zinc-500">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="primary" size="sm" onClick={() => handleSaveEdit(d.id)}>Save</Button>
                      <Button variant="ghost" size="sm" onClick={cancelEdit}>Cancel</Button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr
                  key={d.id}
                  className="border-b border-zinc-100 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800/30"
                >
                  <td className="whitespace-nowrap px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    {new Date(d.date + 'T00:00:00').toLocaleDateString('en-US', {
                      month: 'short', day: 'numeric', year: 'numeric',
                    })}
                  </td>
                  <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                    {stockMap.get(d.stockId)?.ticker ?? d.stockId}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                        d.type === 'cash'
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                          : 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400'
                      }`}
                    >
                      {d.type === 'cash' ? 'Cash' : 'Stock'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {formatCurrency(d.amount)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {d.type === 'stock' && d.sharesReceived != null
                      ? d.sharesReceived.toFixed(4)
                      : '—'}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-0.5">
                      <button
                        onClick={() => startEdit(d)}
                        className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-blue-600 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-blue-400"
                        aria-label="Edit dividend record"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => onDelete(d.id)}
                        className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-red-600 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-red-400"
                        aria-label="Delete dividend record"
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
        {sorted.map((d) => {
          const ticker = stockMap.get(d.stockId)?.ticker ?? d.stockId;
          return editingId === d.id ? (
            <div key={d.id} className="space-y-3 px-4 py-3">
              <Input
                type="date"
                value={editForm.date}
                onChange={(e) => setEditForm({ ...editForm, date: e.target.value })}
                label="Date"
              />
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Type</span>
                <div className="flex gap-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name={`div-type-mobile-${d.id}`}
                      value="cash"
                      checked={editForm.type === 'cash'}
                      onChange={() => setEditForm({ ...editForm, type: 'cash', sharesReceived: '' })}
                      className="text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-sm text-zinc-900 dark:text-zinc-100">Cash</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name={`div-type-mobile-${d.id}`}
                      value="stock"
                      checked={editForm.type === 'stock'}
                      onChange={() => setEditForm({ ...editForm, type: 'stock' })}
                      className="text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-sm text-zinc-900 dark:text-zinc-100">Stock</span>
                  </label>
                </div>
              </div>
              <Input
                type="number"
                step="any"
                min="0"
                value={editForm.amount}
                onChange={(e) => setEditForm({ ...editForm, amount: e.target.value })}
                label="Amount"
                leading={<span>₱</span>}
              />
              {editForm.type === 'stock' && (
                <Input
                  type="number"
                  step="any"
                  min="0"
                  value={editForm.sharesReceived}
                  onChange={(e) => setEditForm({ ...editForm, sharesReceived: e.target.value })}
                  label="Shares Received"
                />
              )}
              <Input
                type="text"
                value={editForm.notes}
                onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                label="Notes (optional)"
              />
              {editError && (
                <div className="text-sm text-red-600 dark:text-red-400">{editError}</div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="primary" size="sm" onClick={() => handleSaveEdit(d.id)}>Save</Button>
                <Button variant="ghost" size="sm" onClick={cancelEdit}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div key={d.id} className="px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{ticker}</span>
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      d.type === 'cash'
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                        : 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400'
                    }`}
                  >
                    {d.type === 'cash' ? 'Cash' : 'Stock'}
                  </span>
                </div>
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={() => startEdit(d)}
                    className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-blue-600 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-blue-400"
                    aria-label="Edit dividend record"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => onDelete(d.id)}
                    className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-red-600 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-red-400"
                    aria-label="Delete dividend record"
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
                    {new Date(d.date + 'T00:00:00').toLocaleDateString('en-US', {
                      month: 'short', day: 'numeric', year: 'numeric',
                    })}
                  </span>
                </div>
                <div className="text-right">
                  <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
                    {formatCurrency(d.amount)}
                  </span>
                </div>
              </div>
              {d.type === 'stock' && d.sharesReceived != null && (
                <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  Shares received: {d.sharesReceived.toFixed(4)}
                </div>
              )}
              {d.notes && (
                <div className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">{d.notes}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
