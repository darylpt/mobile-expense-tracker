// ============================================================
// DividendForm - Add dividend record form
// ============================================================

'use client';

import React, { useState } from 'react';
import { Input } from '@/components/common/Input';
import { Dropdown } from '@/components/common/Dropdown';
import { Button } from '@/components/common/Button';
import { getToday } from '@/lib/utils';
import type { Stock, Dividend } from '@/types';

type DivInput = Omit<Dividend, 'id' | 'createdAt' | 'updatedAt'>;

interface DividendFormProps {
  stocks: Stock[];
  onSubmit: (d: DivInput) => Promise<void>;
}

export function DividendForm({ stocks, onSubmit }: DividendFormProps) {
  const [stockId, setStockId] = useState('');
  const [qty, setQty] = useState('');
  const [rate, setRate] = useState('');
  const [exDate, setExDate] = useState(getToday());
  const [payDate, setPayDate] = useState(getToday());
  const [fee, setFee] = useState('');
  const [dividendYield, setDividendYield] = useState('');
  const [type, setType] = useState<'cash' | 'stock'>('cash');
  const [sharesReceived, setSharesReceived] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stockOptions = stocks.map((s) => ({ value: s.id, label: `${s.ticker} — ${s.name}` }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!stockId) { setError('Please select a stock.'); return; }

    const qtyNum = parseFloat(qty);
    if (isNaN(qtyNum) || qtyNum <= 0) { setError('Qty must be a positive number.'); return; }

    const rateNum = parseFloat(rate);
    if (isNaN(rateNum) || rateNum <= 0) { setError('Rate per share must be a positive number.'); return; }

    if (!exDate) { setError('Please select an ex-dividend date.'); return; }
    if (!payDate) { setError('Please select a payment date.'); return; }

    const feeNum = parseFloat(fee) || 0;
    const yieldNum = dividendYield ? parseFloat(dividendYield) : null;

    let shares: number | null = null;
    if (type === 'stock') {
      const s = parseFloat(sharesReceived);
      if (isNaN(s) || s <= 0) {
        setError('Shares received must be a positive number for stock dividends.');
        return;
      }
      shares = s;
    }

    setSubmitting(true);
    try {
      await onSubmit({
        stockId,
        exDate,
        payDate,
        type,
        qty: qtyNum,
        rate: rateNum,
        amount: qtyNum * rateNum,
        fee: feeNum,
        dividendYield: yieldNum,
        sharesReceived: shares,
        notes: notes.trim() || null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add dividend.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Stock */}
        <Dropdown
          label="Stock"
          options={stockOptions}
          placeholder="Select a stock"
          value={stockId}
          onChange={(e) => setStockId(e.target.value)}
          required
        />

        {/* Qty */}
        <Input
          label="Qty (Shares)"
          type="number"
          step="any"
          min="0"
          placeholder="e.g. 1000"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          required
        />

        {/* Rate */}
        <Input
          label="Rate per Share"
          type="number"
          step="any"
          min="0"
          placeholder="0.00"
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          leading={<span>₱</span>}
          required
        />

        {/* Ex-Date */}
        <Input
          label="Ex-Date"
          type="date"
          value={exDate}
          onChange={(e) => setExDate(e.target.value)}
          required
        />

        {/* Pay Date */}
        <Input
          label="Payment Date"
          type="date"
          value={payDate}
          onChange={(e) => setPayDate(e.target.value)}
          required
        />

        {/* Fee */}
        <Input
          label="Fee (Tax)"
          type="number"
          step="any"
          min="0"
          placeholder="0.00"
          value={fee}
          onChange={(e) => setFee(e.target.value)}
          leading={<span>₱</span>}
        />

        {/* Yield */}
        <Input
          label="Yield % (optional)"
          type="number"
          step="any"
          min="0"
          placeholder="e.g. 5.2"
          value={dividendYield}
          onChange={(e) => setDividendYield(e.target.value)}
        />

        {/* Type — radio toggle */}
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Type</span>
          <div className="flex gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="div-type"
                value="cash"
                checked={type === 'cash'}
                onChange={() => setType('cash')}
                className="text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-zinc-900 dark:text-zinc-100">Cash</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="div-type"
                value="stock"
                checked={type === 'stock'}
                onChange={() => setType('stock')}
                className="text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-zinc-900 dark:text-zinc-100">Stock</span>
            </label>
          </div>
        </div>

        {/* Shares Received — only for stock dividends */}
        {type === 'stock' && (
          <Input
            label="Shares Received"
            type="number"
            step="any"
            min="0"
            placeholder="e.g. 10"
            value={sharesReceived}
            onChange={(e) => setSharesReceived(e.target.value)}
            required
          />
        )}

        {/* Notes */}
        <Input
          label="Notes (optional)"
          type="text"
          placeholder="e.g. quarterly dividend"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      {/* Error */}
      {error && (
        <div className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Submit */}
      <div className="mt-4 flex justify-end">
        <Button type="submit" variant="primary" size="sm" isLoading={submitting} disabled={submitting}>
          {submitting ? 'Adding…' : 'Add Dividend'}
        </Button>
      </div>
    </form>
  );
}
