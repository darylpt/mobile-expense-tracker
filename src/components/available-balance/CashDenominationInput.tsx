// ============================================================
// CashDenominationInput - Enter cash counts per denomination
//
// Standard PHP denominations: ₱1000, ₱500, ₱200, ₱100, ₱50,
// ₱20, ₱10, ₱5, ₱1.
//
// Loads existing snapshot from IndexedDB for the given date,
// reports total via onTotalChange, and can save a new snapshot.
// ============================================================

'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getAllCashDenominations, addCashDenomination, deleteCashDenominationsByDate } from '@/lib/idb';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/common/Button';

/** Standard Philippine peso denominations */
const DENOMINATIONS = [1000, 500, 200, 100, 50, 20, 10, 5, 1];

interface CashDenominationInputProps {
  /** ISO date for the snapshot (the Date Check value) */
  date: string;
  /** Called whenever the computed total changes */
  onTotalChange?: (total: number) => void;
}

export function CashDenominationInput({ date, onTotalChange }: CashDenominationInputProps) {
  const [counts, setCounts] = useState<Record<number, number>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // ponytail: ref keeps the callback fresh without triggering effect re-runs
  const onTotalChangeRef = useRef(onTotalChange);
  useEffect(() => {
    onTotalChangeRef.current = onTotalChange;
  }, [onTotalChange]);

  // Load existing denominations for this date on mount / date change
  useEffect(() => {
    getAllCashDenominations().then((records) => {
      const filtered = records.filter((r) => r.date === date);
      const loaded: Record<number, number> = {};
      // Later saves overwrite earlier ones (most recent snapshot wins)
      for (const r of filtered) {
        loaded[r.denomination] = r.count;
      }
      setCounts({ ...loaded });
    });
  }, [date]);

  const total = DENOMINATIONS.reduce((sum, d) => sum + d * (counts[d] ?? 0), 0);

  // ponytail: onTotalChange intentionally omitted — ref keeps it current
  useEffect(() => {
    onTotalChangeRef.current?.(total);
  }, [total]);

  const handleCountChange = useCallback((denomination: number, value: string) => {
    const count = Math.max(0, parseInt(value, 10) || 0);
    setCounts((prev) => ({ ...prev, [denomination]: count }));
    setSaved(false);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      // ponytail: cleared existing records for this date before save to prevent duplicates
      await deleteCashDenominationsByDate(date);
      for (const [denomination, count] of Object.entries(counts)) {
        if (count > 0) {
          await addCashDenomination({
            date,
            denomination: Number(denomination),
            count,
          });
        }
      }
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        {DENOMINATIONS.map((denom) => (
          <div key={denom} className="flex items-center justify-between gap-3">
            <label htmlFor={`denom-${denom}`} className="w-20 text-sm font-medium text-zinc-700 dark:text-zinc-300">
              ₱{denom.toLocaleString()}
            </label>
            <input
              id={`denom-${denom}`}
              type="number"
              min={0}
              step={1}
              value={counts[denom] ?? 0}
              onChange={(e) => handleCountChange(denom, e.target.value)}
              className="w-24 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-right text-sm text-zinc-900 transition-colors focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:focus:border-blue-400 dark:focus:ring-blue-400/20"
            />
          </div>
        ))}
      </div>

      {/* Running total */}
      <div className="flex items-center justify-between rounded-lg bg-blue-50 px-3 py-2 dark:bg-blue-900/20">
        <span className="text-sm font-medium text-blue-700 dark:text-blue-400">Total</span>
        <span className="text-base font-bold text-blue-800 dark:text-blue-300">
          {formatCurrency(total)}
        </span>
      </div>

      {/* Save button */}
      <Button
        variant="secondary"
        size="sm"
        onClick={handleSave}
        isLoading={saving}
        className="w-full"
      >
        {saved ? 'Saved!' : 'Save Snapshot'}
      </Button>
    </div>
  );
}
