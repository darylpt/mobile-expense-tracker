// ============================================================
// CsvImportPreview — Shows parsed CSV summary, errors, and a
// sample of transactions before the user commits the import.
// ============================================================

'use client';

import React from 'react';
import { Button } from '@/components/common/Button';
import { formatCurrency } from '@/lib/utils';
import type { ParsedCsv } from '@/lib/csv-import';

interface CsvImportPreviewProps {
  parsed: ParsedCsv | null;
  onImport: () => void;
  onCancel: () => void;
  isImporting: boolean;
}

export function CsvImportPreview({
  parsed,
  onImport,
  onCancel,
  isImporting,
}: CsvImportPreviewProps) {
  if (!parsed) return null;

  const { accounts, categories, transactions, errors, summary } = parsed;
  const hasErrors = errors.length > 0;

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
      <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        Preview
      </h2>

      {/* ── Summary counts ── */}
      <div className="mb-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <SummaryStat label="Valid Rows" value={String(summary.validRows)} />
        <SummaryStat
          label="Errors"
          value={String(summary.errorRows)}
          className={hasErrors ? 'text-red-600 dark:text-red-400' : ''}
        />
        <SummaryStat label="Accounts" value={String(summary.accountCount)} />
        <SummaryStat label="Categories" value={String(summary.categoryCount)} />
        <SummaryStat label="Income" value={String(summary.incomeCount)} />
        <SummaryStat label="Expenses" value={String(summary.expenseCount)} />
        <SummaryStat label="Transfers" value={String(summary.transferCount)} />
        <SummaryStat label="Total" value={formatCurrency(summary.totalAmount)} />
      </div>

      {/* ── Account names ── */}
      {accounts.length > 0 && (
        <div className="mb-4">
          <h3 className="mb-1 text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">
            Accounts ({accounts.length})
          </h3>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            {accounts.map((a) => a.name).join(', ')}
          </p>
        </div>
      )}

      {/* ── Category names ── */}
      {categories.length > 0 && (
        <div className="mb-4">
          <h3 className="mb-1 text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">
            Categories ({categories.length})
          </h3>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            {categories.map((c) => `${c.name} (${c.type})`).join(', ')}
          </p>
        </div>
      )}

      {/* ── Truncation warning ── */}
      {summary.truncated && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
          ⚠ CSV was capped at {summary.validRows} rows (max 2,000). Split your data into smaller files to import everything.
        </div>
      )}

      {/* ── Error list ── */}
      {hasErrors && (
        <div className="mb-4">
          <h3 className="mb-1 text-xs font-semibold uppercase text-red-600 dark:text-red-400">
            Parse Errors
          </h3>
          <ul className="max-h-32 space-y-1 overflow-y-auto text-sm">
            {errors.map((err, idx) => (
              <li
                key={idx}
                className="rounded bg-red-50 px-2 py-1 text-red-700 dark:bg-red-900/20 dark:text-red-400"
              >
                Row {err.row}: {err.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Sample preview (first 5 transactions) ── */}
      {transactions.length > 0 && (
        <div className="mb-4 overflow-x-auto">
          <h3 className="mb-1 text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">
            Sample Transactions (first {Math.min(5, transactions.length)} of{' '}
            {transactions.length})
          </h3>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-xs uppercase text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                <th scope="col" className="py-1 pr-2 font-medium">Date</th>
                <th scope="col" className="py-1 pr-2 font-medium">Category</th>
                <th scope="col" className="py-1 pr-2 font-medium">Amount</th>
                <th scope="col" className="py-1 pr-2 font-medium">Type</th>
                <th scope="col" className="py-1 font-medium">From→To</th>
              </tr>
            </thead>
            <tbody>
              {transactions.slice(0, 5).map((tx, idx) => (
                <tr
                  key={idx}
                  className="border-b border-zinc-100 text-zinc-800 last:border-0 dark:border-zinc-800 dark:text-zinc-200"
                >
                  <td className="py-1 pr-2">{tx.date}</td>
                  <td className="py-1 pr-2">{tx.category}</td>
                  <td className="py-1 pr-2 tabular-nums">{formatCurrency(tx.amount)}</td>
                  <td className="py-1 pr-2">{tx.type}</td>
                  <td className="py-1">
                    {tx.fromAccount || ''}
                    {tx.fromAccount && tx.toAccount && ' → '}
                    {tx.toAccount || ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Empty state ── */}
      {transactions.length === 0 && !hasErrors && (
        <p className="mb-4 text-sm text-zinc-500">No data found in CSV.</p>
      )}

      {/* ── Actions ── */}
      <div className="flex justify-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-700">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isImporting}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={onImport}
          disabled={transactions.length === 0 || isImporting}
          isLoading={isImporting}
        >
          {isImporting ? 'Importing…' : 'Import'}
        </Button>
      </div>
    </section>
  );
}

function SummaryStat({
  label,
  value,
  className = '',
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-100 bg-zinc-50 p-2 dark:border-zinc-700 dark:bg-zinc-800/30">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className={`text-sm font-semibold text-zinc-900 dark:text-zinc-100 ${className}`}>
        {value}
      </p>
    </div>
  );
}
