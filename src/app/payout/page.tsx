// ============================================================
// Payout Calculator screen
//
// Standalone calculator for splitting a total payout across
// people/categories. Read-only — does NOT write Transaction
// records to the ledger (Phase 1).
//
// Mirrors the "Payout" sheet tab.
// ============================================================

'use client';

import { useState, Fragment } from 'react';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { formatCurrency, getToday } from '@/lib/utils';
import { addPayout } from '@/lib/idb';

// ── Types ───────────────────────────────────────────────────
interface SplitRow {
  id: string;
  person: string;
  value: number;
  subSplit: boolean;
  subSplitOpen: boolean;
  savingsSplit: SavingsSubSplit;
}

interface SavingsSubSplit {
  emergencyPct: number;
  wantsPct: number;
  investmentPct: number;
  motorPct: number;
}

// ── Defaults ────────────────────────────────────────────────

const DEFAULT_SAVINGS_SPLIT = {
  emergencyPct: 50,
  wantsPct: 15,
  investmentPct: 20,
  motorPct: 15,
};

const DEFAULT_NAMES = ['Savings', 'Gy', 'John', 'Sona', 'Daryl'];

const LABELS: Record<keyof SavingsSubSplit, string> = {
  emergencyPct: 'Emergency',
  wantsPct: 'Wants',
  investmentPct: 'Investment',
  motorPct: 'Motor',
};

// ── Page ─────────────────────────────────────────────────────

export default function PayoutPage() {
  const [totalAmount, setTotalAmount] = useState(0);
  const [splitMode, setSplitMode] = useState<'amount' | 'percentage'>('percentage');
  const [splits, setSplits] = useState<SplitRow[]>(() =>
    DEFAULT_NAMES.map((name) => ({
      id: crypto.randomUUID(),
      person: name,
      value: 0,
      subSplit: false,
      subSplitOpen: false,
      savingsSplit: { ...DEFAULT_SAVINGS_SPLIT },
    }))
  );
  const [saved, setSaved] = useState(false);

  // ── Derived ──────────────────────────────────────────────

  const amounts = splits.map((s) =>
    splitMode === 'amount' ? s.value : totalAmount * (s.value / 100)
  );
  const allocated = amounts.reduce((a, b) => a + b, 0);

  const subSplitAmounts = (base: number, ss: SavingsSubSplit) => ({
    emergencyPct: base * (ss.emergencyPct / 100),
    wantsPct: base * (ss.wantsPct / 100),
    investmentPct: base * (ss.investmentPct / 100),
    motorPct: base * (ss.motorPct / 100),
  });

  // ── Validation ───────────────────────────────────────────

  const warnings: string[] = [];
  if (totalAmount <= 0) {
    warnings.push('Total amount must be greater than zero');
  }
  if (splitMode === 'percentage') {
    const totalPct = splits.reduce((sum, s) => sum + s.value, 0);
    if (Math.abs(totalPct - 100) > 0.01) {
      warnings.push(`Percentages sum to ${totalPct.toFixed(1)}% — should be 100%`);
    }
  } else {
    if (Math.abs(allocated - totalAmount) > 0.01) {
      warnings.push(
        `Allocated (${formatCurrency(allocated)}) ≠ Total (${formatCurrency(totalAmount)})`
      );
    }
  }
  splits.filter((s) => s.subSplit).forEach((s) => {
    const sum =
      s.savingsSplit.emergencyPct +
      s.savingsSplit.wantsPct +
      s.savingsSplit.investmentPct +
      s.savingsSplit.motorPct;
    if (Math.abs(sum - 100) > 0.01) {
      const name = s.person || '(unnamed)';
      warnings.push(`${name}'s sub-split sums to ${sum.toFixed(1)}% — should be 100%`);
    }
  });

  // ── Handlers ─────────────────────────────────────────────

  const handlePersonChange = (id: string, field: 'person' | 'value', val: string) => {
    setSplits((prev) =>
      prev.map((s) => (s.id === id ? { ...s, [field]: field === 'value' ? parseFloat(val) || 0 : val } : s))
    );
  };

  const removeSplit = (id: string) => {
    setSplits((prev) => prev.filter((s) => s.id !== id));
  };

  const addSplit = () => {
    setSplits((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        person: '',
        value: 0,
        subSplit: false,
        subSplitOpen: false,
        savingsSplit: { ...DEFAULT_SAVINGS_SPLIT },
      },
    ]);
  };

  const handleSubSplitChange = (splitId: string, key: keyof SavingsSubSplit, val: string) => {
    setSplits((prev) =>
      prev.map((s) =>
        s.id === splitId
          ? { ...s, savingsSplit: { ...s.savingsSplit, [key]: parseFloat(val) || 0 } }
          : s
      )
    );
  };

  const canSave = warnings.length === 0;

  // ponytail: blocks save when percentages don't sum to 100% (or amounts don't match total)
  const handleSave = async () => {
    await addPayout({
      date: getToday(),
      totalAmount,
      splitMode,
      splits: splits.map((s) => ({ person: s.person, value: s.value })),
      // ponytail: saves the first opted-in person's split as the canonical one
      savingsSubSplit: splits.find((s) => s.subSplit)?.savingsSplit,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  // ── Render ───────────────────────────────────────────────

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <Header title="Payout" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-20 pt-6 sm:px-6 sm:pb-0 sm:pt-8">
        <div className="space-y-6 lg:grid lg:grid-cols-2 lg:gap-6 lg:space-y-0">
          {/* ── Left column: inputs ── */}
          <div className="space-y-6">
            {/* ── Total Amount ─────────────────────────────── */}
            <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
              <Input
                label="Total Amount"
                leading={<span className="text-zinc-500">₱</span>}
                type="number"
                step="any"
                min={0}
                placeholder="0.00"
                value={totalAmount || ''}
                onChange={(e) => setTotalAmount(parseFloat(e.target.value) || 0)}
              />
            </section>

            {/* ── Split Mode Toggle ────────────────────────── */}
            <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
              <label className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Split Mode
              </label>
              <div className="inline-flex rounded-lg border border-zinc-300 bg-zinc-100 p-0.5 dark:border-zinc-600 dark:bg-zinc-800">
                {(['percentage', 'amount'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setSplitMode(mode)}
                    className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                      splitMode === mode
                        ? 'bg-white text-blue-700 shadow-sm dark:bg-zinc-700 dark:text-blue-400'
                        : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200'
                    }`}
                  >
                    {mode === 'percentage' ? 'By Percentage' : 'By Amount'}
                  </button>
                ))}
              </div>
            </section>

            {/* ── Person Rows ──────────────────────────────── */}
            <section className="rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50">
              <div className="divide-y divide-zinc-100 dark:divide-zinc-700">
                {splits.map((split, idx) => (
                  <Fragment key={split.id}>
                    <div className="flex items-end gap-3 p-4 sm:px-6">
                      <div className="flex-1">
                        <Input
                          label={idx === 0 ? 'Person' : undefined}
                          placeholder="Name"
                          value={split.person}
                          onChange={(e) => handlePersonChange(split.id, 'person', e.target.value)}
                        />
                      </div>
                      <div className="w-32">
                        <Input
                          label={idx === 0 ? splitMode === 'percentage' ? 'Percent' : 'Amount' : undefined}
                          type="number"
                          step="any"
                          min={0}
                          placeholder="0"
                          value={split.value || ''}
                          onChange={(e) => handlePersonChange(split.id, 'value', e.target.value)}
                          {...(splitMode === 'percentage'
                            ? { trailing: <span className="text-zinc-400">%</span> }
                            : { leading: <span className="text-zinc-500">₱</span> })}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setSplits((prev) =>
                            prev.map((s) => (s.id === split.id ? { ...s, subSplit: !s.subSplit } : s))
                          )
                        }
                        className={`mb-1.5 flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
                          split.subSplit
                            ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                            : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-300'
                        }`}
                        aria-label={split.subSplit ? 'Disable sub-split' : 'Enable sub-split'}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                          <path d="M3.196 12.87l-.825.483a.75.75 0 000 1.294l7.25 4.25a.75.75 0 00.758 0l7.25-4.25a.75.75 0 000-1.294l-.825-.484-5.666 3.322a2.25 2.25 0 01-2.276 0L3.196 12.87z" />
                          <path d="M3.196 8.87l-.825.483a.75.75 0 000 1.294l7.25 4.25a.75.75 0 00.758 0l7.25-4.25a.75.75 0 000-1.294l-.825-.484-5.666 3.322a2.25 2.25 0 01-2.276 0L3.196 8.87z" />
                          <path d="M10.38 1.103a.75.75 0 00-.76 0l-7.25 4.25a.75.75 0 000 1.294l7.25 4.25a.75.75 0 00.76 0l7.25-4.25a.75.75 0 000-1.294l-7.25-4.25z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => removeSplit(split.id)}
                        className="mb-1.5 flex h-9 w-9 items-center justify-center rounded-md text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                        aria-label={`Remove ${split.person || 'person'}`}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                          <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c-.84 0-1.673.025-2.5.075V3.75c0-.69.56-1.25 1.25-1.25h2.5c.69 0 1.25.56 1.25 1.25v.325C11.673 4.025 10.84 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
                        </svg>
                      </button>
                    </div>

                    {/* ── Sub-Split (per-person) ──────────────────── */}
                    {split.subSplit && (
                      <div className="border-t border-zinc-100 bg-zinc-50/50 px-4 pb-4 dark:border-zinc-700 dark:bg-zinc-900/30 sm:px-6">
                        <button
                          type="button"
                          onClick={() =>
                            setSplits((prev) =>
                              prev.map((s) =>
                                s.id === split.id ? { ...s, subSplitOpen: !s.subSplitOpen } : s
                              )
                            )
                          }
                          className="flex w-full items-center gap-2 py-3 text-sm font-medium text-zinc-600 dark:text-zinc-400"
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 20 20"
                            fill="currentColor"
                            className={`h-4 w-4 transition-transform ${split.subSplitOpen ? 'rotate-90' : ''}`}
                          >
                            <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
                          </svg>
                          Savings Sub-Split
                        </button>
                        {split.subSplitOpen && (
                          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                            {(Object.keys(DEFAULT_SAVINGS_SPLIT) as (keyof SavingsSubSplit)[]).map(
                              (key) => (
                                <div key={key}>
                                  <label htmlFor={`savings-split-${split.id}-${key}`} className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
                                    {LABELS[key]}
                                  </label>
                                  <div className="relative">
                                    <input
                                      id={`savings-split-${split.id}-${key}`}
                                      type="number"
                                      step="any"
                                      min={0}
                                      max={100}
                                      value={split.savingsSplit[key] || ''}
                                      onChange={(e) => handleSubSplitChange(split.id, key, e.target.value)}
                                      className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 pr-7 text-sm text-zinc-900 transition-colors focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:focus:border-blue-400"
                                    />
                                    <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-zinc-400">
                                      %
                                    </span>
                                  </div>
                                </div>
                              )
                            )}
                          </div>
                        )}
                      </div>
                    )}

                  </Fragment>
                ))}
              </div>

              <div className="border-t border-zinc-100 px-4 py-3 dark:border-zinc-700 sm:px-6">
                <Button variant="ghost" size="sm" onClick={addSplit}>
                  + Add Person
                </Button>
              </div>
            </section>

            {/* ── Validation / Summary Bar ─────────────────── */}
            <section
              className={`rounded-xl border p-4 shadow-sm sm:p-6 ${
                warnings.length > 0
                  ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20'
                  : 'border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-900/20'
              }`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Total:{' '}
                  <span className="text-zinc-900 dark:text-zinc-100">
                    {formatCurrency(totalAmount)}
                  </span>
                </span>
                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Allocated:{' '}
                  <span
                    className={
                      warnings.length > 0
                        ? 'text-amber-700 dark:text-amber-400'
                        : 'text-emerald-700 dark:text-emerald-400'
                    }
                  >
                    {splitMode === 'percentage'
                      ? `${((allocated / (totalAmount || 1)) * 100).toFixed(1)}%`
                      : formatCurrency(allocated)}
                  </span>
                </span>
              </div>
              {warnings.map((w, i) => (
                <p key={i} className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                  ⚠ {w}
                </p>
              ))}
            </section>
          </div>

          {/* ── Right column: output ── */}
          <div className="space-y-6">
            {/* ── Output Display ──────────────────────────── */}
            <section className="rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50">
              <div className="px-4 py-3 sm:px-6">
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Output
                </h3>
              </div>

              {/* Desktop table */}
              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-y border-zinc-200 text-xs uppercase text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                      <th className="py-2 pl-4 pr-4 font-medium sm:pl-6">Person</th>
                      <th className="py-2 px-2 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {splits.map((split, idx) => {
                      const amount = amounts[idx] ?? 0;
                      const ssa = split.subSplit ? subSplitAmounts(amount, split.savingsSplit) : null;
                      return (
                        <Fragment key={split.id}>
                          <tr className="border-b border-zinc-100 text-zinc-800 last:border-0 dark:border-zinc-800 dark:text-zinc-200">
                            <td className="py-2 pl-4 pr-4 font-medium sm:pl-6">
                              {split.person || '(unnamed)'}
                            </td>
                            <td className="py-2 px-2 text-right tabular-nums">
                              {formatCurrency(amount)}
                            </td>
                          </tr>
                          {ssa && amount > 0 && (
                            <>
                              {(Object.keys(LABELS) as (keyof SavingsSubSplit)[]).map((key) => (
                                <tr
                                  key={key}
                                  className="border-b border-zinc-100 text-zinc-600 last:border-0 dark:border-zinc-800 dark:text-zinc-400"
                                >
                                  <td className="py-1.5 pl-8 pr-4 text-xs sm:pl-10">
                                    └ {LABELS[key]}
                                  </td>
                                  <td className="py-1.5 px-2 text-right text-xs tabular-nums">
                                    {formatCurrency(ssa[key])}
                                  </td>
                                </tr>
                              ))}
                            </>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-zinc-200 font-semibold text-zinc-900 dark:border-zinc-700 dark:text-zinc-100">
                      <td className="py-2 pl-4 pr-4 sm:pl-6">Total</td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {formatCurrency(allocated)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="divide-y divide-zinc-100 dark:divide-zinc-700 lg:hidden">
                {splits.map((split, idx) => {
                  const amount = amounts[idx] ?? 0;
                  const ssa = split.subSplit ? subSplitAmounts(amount, split.savingsSplit) : null;
                  return (
                    <div key={split.id} className="px-4 py-3 sm:px-6">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {split.person || '(unnamed)'}
                        </span>
                        <span className="text-sm font-semibold tabular-nums text-zinc-800 dark:text-zinc-200">
                          {formatCurrency(amount)}
                        </span>
                      </div>
                      {ssa && amount > 0 && (
                        <div className="mt-2 space-y-1 border-t border-zinc-100 pt-2 dark:border-zinc-700">
                          {(Object.keys(LABELS) as (keyof SavingsSubSplit)[]).map((key) => (
                            <div key={key} className="flex items-center justify-between text-xs">
                              <span className="text-zinc-500 dark:text-zinc-400">
                                └ {LABELS[key]}
                              </span>
                              <span className="tabular-nums text-zinc-600 dark:text-zinc-400">
                                {formatCurrency(ssa[key])}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Mobile total */}
              <div className="border-t border-zinc-200 px-4 py-3 lg:hidden dark:border-zinc-700">
                <div className="flex items-center justify-between text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  <span>Total</span>
                  <span className="tabular-nums">{formatCurrency(allocated)}</span>
                </div>
              </div>

              {splits.length === 0 && (
                <p className="py-8 text-center text-sm text-zinc-500">
                  No rows. Add a person to start.
                </p>
              )}
            </section>

            {/* ── Save Button ──────────────────────────────── */}
            <div className="flex justify-center">
              <Button onClick={handleSave} size="lg" disabled={!canSave}>
                {saved ? '✓ Saved!' : 'Save Payout'}
              </Button>
            </div>
          </div>
        </div>

        {/* Footer note */}
        <p className="mt-6 text-center text-xs text-zinc-500 dark:text-zinc-400">
          Payout Calculator — no transactions are created from this screen.
        </p>
      </main>
    </div>
  );
}
