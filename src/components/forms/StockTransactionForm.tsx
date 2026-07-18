// ============================================================
// StockTransactionForm - Add buy/sell transaction form
// ============================================================

'use client';

import React, { useState, useMemo } from 'react';
import { Input } from '@/components/common/Input';
import { Dropdown } from '@/components/common/Dropdown';
import { Button } from '@/components/common/Button';
import { getToday, formatCurrency } from '@/lib/utils';
import type { Stock, StockTransaction } from '@/types';

type TxInput = Omit<StockTransaction, 'id' | 'createdAt' | 'updatedAt'>;

interface StockTransactionFormProps {
  stocks: Stock[];
  onSubmit: (tx: TxInput) => Promise<void>;
}

export function StockTransactionForm({ stocks, onSubmit }: StockTransactionFormProps) {
  const [stockId, setStockId] = useState('');
  const [date, setDate] = useState(getToday());
  const [type, setType] = useState<'buy' | 'sell'>('buy');
  const [shares, setShares] = useState('');
  const [pricePerShare, setPricePerShare] = useState('');
  const [fees, setFees] = useState('0');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [byAmount, setByAmount] = useState(false);
  const [amount, setAmount] = useState('');

  const stockOptions = stocks.map((s) => ({ value: s.id, label: `${s.ticker} — ${s.name}` }));

  const computedShares = useMemo(() => {
    if (!byAmount) return null;
    const a = parseFloat(amount) || 0;
    const p = parseFloat(pricePerShare) || 0;
    if (a <= 0 || p <= 0) return 0;
    return Math.round((a / p) * 10000) / 10000;
  }, [byAmount, amount, pricePerShare]);

  const computedTotal = useMemo(() => {
    if (byAmount) {
      const a = parseFloat(amount) || 0;
      const f = parseFloat(fees) || 0;
      return type === 'buy' ? a + f : a - f;
    }
    const s = parseFloat(shares) || 0;
    const p = parseFloat(pricePerShare) || 0;
    const f = parseFloat(fees) || 0;
    const gross = s * p;
    return type === 'buy' ? gross + f : gross - f;
  }, [byAmount, amount, shares, pricePerShare, fees, type]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validate
    if (!stockId) { setError('Please select a stock.'); return; }
    if (!date) { setError('Please select a date.'); return; }
    let s: number;
    let a = 0;
    if (byAmount) {
      a = parseFloat(amount);
      if (isNaN(a) || a <= 0) { setError('Amount must be a positive number.'); return; }
      if (computedShares === null || computedShares <= 0) { setError('Computed shares must be positive.'); return; }
      s = computedShares;
    } else {
      const rawS = parseFloat(shares);
      if (isNaN(rawS) || rawS <= 0) { setError('Shares must be a positive number.'); return; }
      s = rawS;
    }
    const p = parseFloat(pricePerShare);
    if (isNaN(p) || p <= 0) { setError('Price per share must be a positive number.'); return; }
    const f = parseFloat(fees) || 0;
    if (f < 0) { setError('Fees cannot be negative.'); return; }

    const totalAmount = byAmount
      ? (type === 'buy' ? a + f : a - f)
      : (type === 'buy' ? s * p + f : s * p - f);

    setSubmitting(true);
    try {
      await onSubmit({
        stockId,
        date,
        type,
        shares: s,
        pricePerShare: p,
        fees: f,
        totalAmount,
        notes: null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add transaction.');
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

        {/* Date */}
        <Input
          label="Date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
        />

        {/* Type — radio toggle */}
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Type</span>
          <div className="flex gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="tx-type"
                value="buy"
                checked={type === 'buy'}
                onChange={() => setType('buy')}
                className="text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-zinc-900 dark:text-zinc-100">Buy</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="tx-type"
                value="sell"
                checked={type === 'sell'}
                onChange={() => setType('sell')}
                className="text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-zinc-900 dark:text-zinc-100">Sell</span>
            </label>
          </div>
        </div>

        {/* Enter by total amount toggle */}
        <label className="flex items-center gap-2 cursor-pointer col-span-full">
          <input
            type="checkbox"
            checked={byAmount}
            onChange={(e) => { setByAmount(e.target.checked); setAmount(''); setShares(''); }}
            className="rounded text-blue-600 focus:ring-blue-500"
          />
          <span className="text-sm text-zinc-600 dark:text-zinc-400">Enter by total amount</span>
        </label>

        {/* Shares / Amount */}
        {byAmount ? (
          <Input label="Amount" type="number" step="0.01" min="0" placeholder="0.00" value={amount}
            onChange={(e) => setAmount(e.target.value)} leading={<span>₱</span>} required />
        ) : (
          <Input label="Shares" type="number" step="any" min="0" placeholder="e.g. 100" value={shares}
            onChange={(e) => setShares(e.target.value)} required />
        )}

        {/* Price per share */}
        <Input
          label="Price per Share"
          type="number"
          step="0.0001"
          min="0"
          placeholder="0.00"
          value={pricePerShare}
          onChange={(e) => setPricePerShare(e.target.value)}
          leading={<span>₱</span>}
          required
        />

        {byAmount && computedShares !== null && computedShares > 0 && (
          <div className="col-span-full -mt-3 text-xs text-zinc-500 dark:text-zinc-400">
            ≈ {computedShares.toFixed(4)} shares
          </div>
        )}

        {/* Fees */}
        <Input
          label="Fees"
          type="number"
          step="0.01"
          min="0"
          placeholder="0.00"
          value={fees}
          onChange={(e) => setFees(e.target.value)}
          leading={<span>₱</span>}
        />
      </div>

      {/* Computed total */}
      <div className="mt-4 rounded-lg bg-zinc-50 px-4 py-3 dark:bg-zinc-900">
        <div className="flex items-center justify-between text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">
            Total ({byAmount ? 'amount ± fees' : type === 'buy' ? 'shares × price + fees' : 'shares × price − fees'})
          </span>
          <span className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
            {formatCurrency(computedTotal)}
          </span>
        </div>
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
          {submitting ? 'Adding…' : 'Add Transaction'}
        </Button>
      </div>
    </form>
  );
}
