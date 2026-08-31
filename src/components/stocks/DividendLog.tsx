// ============================================================
// DividendLog - Dividend records log
// Desktop: table. Mobile: card list.
// Sort by date descending.
// ============================================================

'use client';

import React, { useState } from 'react';
import { formatCurrency } from '@/lib/utils';
import { normalizeDividendRecord } from '@/lib/dividends';
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
  exDate: string;
  payDate: string;
  type: 'cash' | 'stock';
  qty: string;
  rate: string;
  fee: string;
  dividendYield: string;
  sharesReceived: string;
  notes: string;
}

export function DividendLog({ dividends, stocks, onDelete, onUpdate }: DividendLogProps) {
  const stockMap = new Map(stocks.map((s) => [s.id, s]));
  const sorted = dividends
    .map((dividend) => normalizeDividendRecord(dividend as unknown as Record<string, unknown>) as unknown as Dividend)
    .sort((a, b) => b.exDate.localeCompare(a.exDate));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({
    exDate: '', payDate: '', type: 'cash',
    qty: '', rate: '', fee: '', dividendYield: '',
    sharesReceived: '', notes: '',
  });
  const [editError, setEditError] = useState<string | null>(null);

  const startEdit = (d: Dividend) => {
    setEditingId(d.id);
    setEditForm({
      exDate: d.exDate,
      payDate: d.payDate,
      type: d.type,
      qty: d.qty ? String(d.qty) : '',
      rate: d.rate ? String(d.rate) : '',
      fee: d.fee ? String(d.fee) : '',
      dividendYield: d.dividendYield != null ? String(d.dividendYield) : '',
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
    const qtyNum = parseFloat(editForm.qty);
    const rateNum = parseFloat(editForm.rate);
    if (isNaN(qtyNum) || qtyNum <= 0) { setEditError('Qty must be a positive number.'); return; }
    if (isNaN(rateNum) || rateNum <= 0) { setEditError('Rate must be a positive number.'); return; }
    if (!editForm.exDate) { setEditError('Ex-date is required.'); return; }
    if (!editForm.payDate) { setEditError('Pay date is required.'); return; }
    const feeNum = parseFloat(editForm.fee) || 0;
    const yieldNum = editForm.dividendYield ? parseFloat(editForm.dividendYield) : null;
    let shares: number | null = null;
    if (editForm.type === 'stock') {
      const s = parseFloat(editForm.sharesReceived);
      if (isNaN(s) || s <= 0) { setEditError('Shares received must be a positive number for stock dividends.'); return; }
      shares = s;
    }
    try {
      await onUpdate(id, {
        exDate: editForm.exDate,
        payDate: editForm.payDate,
        type: editForm.type,
        qty: qtyNum,
        rate: rateNum,
        amount: qtyNum * rateNum,
        fee: feeNum,
        dividendYield: yieldNum,
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
              <th scope="col" className="px-2 pb-3 pt-3">Stock</th>
              <th scope="col" className="px-2 pb-3 pt-3 text-right">Qty</th>
              <th scope="col" className="px-2 pb-3 pt-3 text-right">Rate</th>
              <th scope="col" className="px-2 pb-3 pt-3 text-right">Yield</th>
              <th scope="col" className="px-2 pb-3 pt-3">Ex-Date</th>
              <th scope="col" className="px-2 pb-3 pt-3">Pay Date</th>
              <th scope="col" className="px-2 pb-3 pt-3 text-right">Gross</th>
              <th scope="col" className="px-2 pb-3 pt-3 text-right">Fee</th>
              <th scope="col" className="px-2 pb-3 pt-3 text-right">Net</th>
              <th scope="col" className="px-2 pb-3 pt-3">Type</th>
              <th scope="col" className="w-24 px-2 pb-3 pt-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((d) => {
              const gross = d.qty > 0 ? d.qty * d.rate : d.amount;
              const net = gross - d.fee;
              return editingId === d.id ? (
                <tr
                  key={d.id}
                  className="border-b border-zinc-100 bg-blue-50/40 dark:border-zinc-700 dark:bg-blue-900/10"
                >
                  <td className="px-2 py-2 font-medium text-zinc-500 dark:text-zinc-400">
                    {stockMap.get(d.stockId)?.ticker ?? d.stockId}
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      type="number"
                      step="any"
                      min="0"
                      value={editForm.qty}
                      onChange={(e) => setEditForm({ ...editForm, qty: e.target.value })}
                      aria-label="Qty"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      type="number"
                      step="any"
                      min="0"
                      value={editForm.rate}
                      onChange={(e) => setEditForm({ ...editForm, rate: e.target.value })}
                      aria-label="Rate"
                      leading={<span>₱</span>}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      type="number"
                      step="any"
                      min="0"
                      value={editForm.dividendYield}
                      onChange={(e) => setEditForm({ ...editForm, dividendYield: e.target.value })}
                      aria-label="Yield %"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      type="date"
                      value={editForm.exDate}
                      onChange={(e) => setEditForm({ ...editForm, exDate: e.target.value })}
                      aria-label="Ex-Date"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      type="date"
                      value={editForm.payDate}
                      onChange={(e) => setEditForm({ ...editForm, payDate: e.target.value })}
                      aria-label="Pay Date"
                    />
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                    {formatCurrency((parseFloat(editForm.qty) || 0) * (parseFloat(editForm.rate) || 0))}
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      type="number"
                      step="any"
                      min="0"
                      value={editForm.fee}
                      onChange={(e) => setEditForm({ ...editForm, fee: e.target.value })}
                      aria-label="Fee"
                      leading={<span>₱</span>}
                    />
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                    {formatCurrency((parseFloat(editForm.qty) || 0) * (parseFloat(editForm.rate) || 0) - (parseFloat(editForm.fee) || 0))}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex gap-1">
                      <label className="flex items-center gap-1 cursor-pointer">
                        <input
                          type="radio"
                          name={`div-type-${d.id}`}
                          value="cash"
                          checked={editForm.type === 'cash'}
                          onChange={() => setEditForm({ ...editForm, type: 'cash', sharesReceived: '' })}
                          className="text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-xs text-zinc-900 dark:text-zinc-100">Cash</span>
                      </label>
                      <label className="flex items-center gap-1 cursor-pointer">
                        <input
                          type="radio"
                          name={`div-type-${d.id}`}
                          value="stock"
                          checked={editForm.type === 'stock'}
                          onChange={() => setEditForm({ ...editForm, type: 'stock' })}
                          className="text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-xs text-zinc-900 dark:text-zinc-100">Stock</span>
                      </label>
                    </div>
                    {editForm.type === 'stock' && (
                      <Input
                        type="number"
                        step="any"
                        min="0"
                        value={editForm.sharesReceived}
                        onChange={(e) => setEditForm({ ...editForm, sharesReceived: e.target.value })}
                        aria-label="Shares received"
                        className="mt-1"
                      />
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-right">
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
                  <td className="px-2 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                    {stockMap.get(d.stockId)?.ticker ?? d.stockId}
                  </td>
                  <td className="px-2 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {d.qty > 0 ? d.qty.toLocaleString() : '—'}
                  </td>
                  <td className="px-2 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {d.rate > 0 ? formatCurrency(d.rate) : '—'}
                  </td>
                  <td className="px-2 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {d.dividendYield != null ? d.dividendYield.toFixed(2) + '%' : '—'}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 text-zinc-500 dark:text-zinc-400">
                    {new Date(d.exDate + 'T00:00:00').toLocaleDateString('en-US', {
                      month: 'short', day: 'numeric', year: 'numeric',
                    })}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 text-zinc-500 dark:text-zinc-400">
                    {new Date(d.payDate + 'T00:00:00').toLocaleDateString('en-US', {
                      month: 'short', day: 'numeric', year: 'numeric',
                    })}
                  </td>
                  <td className="px-2 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {formatCurrency(gross)}
                  </td>
                  <td className="px-2 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {d.fee > 0 ? formatCurrency(d.fee) : '—'}
                  </td>
                  <td className={`px-2 py-3 text-right tabular-nums ${net < 0 ? 'text-red-600 dark:text-red-400' : 'text-zinc-700 dark:text-zinc-300'}`}>
                    {formatCurrency(net)}
                  </td>
                  <td className="px-2 py-3">
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
                  <td className="whitespace-nowrap px-2 py-3 text-right">
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
              );
            })}
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
          const gross = d.qty > 0 ? d.qty * d.rate : d.amount;
          const net = gross - d.fee;
          return editingId === d.id ? (
            <div key={d.id} className="space-y-3 px-4 py-3">
              <Input
                type="number"
                step="any"
                min="0"
                value={editForm.qty}
                onChange={(e) => setEditForm({ ...editForm, qty: e.target.value })}
                label="Qty (Shares)"
              />
              <Input
                type="number"
                step="any"
                min="0"
                value={editForm.rate}
                onChange={(e) => setEditForm({ ...editForm, rate: e.target.value })}
                label="Rate per Share"
                leading={<span>₱</span>}
              />
              <Input
                type="date"
                value={editForm.exDate}
                onChange={(e) => setEditForm({ ...editForm, exDate: e.target.value })}
                label="Ex-Date"
              />
              <Input
                type="date"
                value={editForm.payDate}
                onChange={(e) => setEditForm({ ...editForm, payDate: e.target.value })}
                label="Payment Date"
              />
              <Input
                type="number"
                step="any"
                min="0"
                value={editForm.fee}
                onChange={(e) => setEditForm({ ...editForm, fee: e.target.value })}
                label="Fee (Tax)"
                leading={<span>₱</span>}
              />
              <Input
                type="number"
                step="any"
                min="0"
                value={editForm.dividendYield}
                onChange={(e) => setEditForm({ ...editForm, dividendYield: e.target.value })}
                label="Yield % (optional)"
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
              <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
                <div>
                  <span className="text-zinc-400 dark:text-zinc-500">Ex-Date </span>
                  <span className="text-zinc-700 dark:text-zinc-300">
                    {new Date(d.exDate + 'T00:00:00').toLocaleDateString('en-US', {
                      month: 'short', day: 'numeric', year: 'numeric',
                    })}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-400 dark:text-zinc-500">Pay Date </span>
                  <span className="text-zinc-700 dark:text-zinc-300">
                    {new Date(d.payDate + 'T00:00:00').toLocaleDateString('en-US', {
                      month: 'short', day: 'numeric', year: 'numeric',
                    })}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-400 dark:text-zinc-500">Gross </span>
                  <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
                    {formatCurrency(gross)}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-400 dark:text-zinc-500">Fee </span>
                  <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
                    {d.fee > 0 ? formatCurrency(d.fee) : '—'}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-400 dark:text-zinc-500">Net </span>
                  <span className={`tabular-nums ${net < 0 ? 'text-red-600 dark:text-red-400' : 'text-zinc-700 dark:text-zinc-300'}`}>
                    {formatCurrency(net)}
                  </span>
                </div>
              </div>
              {d.qty > 0 && (
                <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {d.qty.toLocaleString()} × {formatCurrency(d.rate)} = {formatCurrency(gross)}
                </div>
              )}
              {d.dividendYield != null && (
                <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  Yield: {d.dividendYield.toFixed(2)}%
                </div>
              )}
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
