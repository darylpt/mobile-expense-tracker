// ============================================================
// TransactionList - Displays a scrollable list of transactions
// for the currently selected month with edit and delete capability.
// ============================================================

'use client';

import React from 'react';
import { useTransactions } from '@/hooks/useTransactions';
import { formatCurrency, formatDate } from '@/lib/utils';
import { Button } from '@/components/common/Button';
import { EditTransactionModal } from '@/components/forms/EditTransactionModal';
import type { Transaction } from '@/types';

export function TransactionList() {
  const { sortedTransactions, deleteTransaction, isLoading, error } = useTransactions();
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [editingTx, setEditingTx] = React.useState<Transaction | null>(null);
  const editButtonRef = React.useRef<HTMLButtonElement | null>(null);

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this transaction?')) return;
    setDeletingId(id);
    try {
      await deleteTransaction(id);
    } catch {
      // Error is handled in context
    } finally {
      setDeletingId(null);
    }
  };

  const handleEdit = (tx: Transaction, buttonEl: HTMLButtonElement) => {
    editButtonRef.current = buttonEl;
    setEditingTx(tx);
  };

  // Restore focus to the Edit button when the modal closes
  React.useEffect(() => {
    if (!editingTx && editButtonRef.current) {
      editButtonRef.current.focus();
      editButtonRef.current = null;
    }
  }, [editingTx]);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
        <div className="h-6 w-36 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="mt-4 space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
      <h2 className="mb-4 text-base font-semibold text-zinc-900 dark:text-zinc-100">
        Transactions
      </h2>

      {error && (
        <div className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-400">
          {error}
        </div>
      )}

      {sortedTransactions.length === 0 ? (
        <p className="py-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
          No transactions yet. Add one from the Summary page!
        </p>
      ) : (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-700">
          {sortedTransactions.map((tx) => (
            <div
              key={tx.id}
              className="flex items-center gap-3 py-2.5 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/30"
            >
              {/* Type indicator dot */}
              <span
                className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
                  tx.type === 'income'
                    ? 'bg-emerald-500'
                    : tx.type === 'expense'
                      ? 'bg-red-500'
                      : 'bg-blue-500'
                }`}
              />

              {/* Details */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {tx.category}
                  </span>
                  <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                    {tx.type === 'income'
                      ? `→ ${tx.toAccount ?? ''}`
                      : tx.type === 'expense'
                        ? `${tx.fromAccount ?? ''} →`
                        : `${tx.fromAccount ?? ''} → ${tx.toAccount ?? ''}`}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <span>{formatDate(tx.date)}</span>
                  {tx.description && (
                    <>
                      <span>·</span>
                      <span className="truncate">{tx.description}</span>
                    </>
                  )}
                </div>
              </div>

              {/* Amount + delete */}
              <div className="flex items-center gap-2">
                <span
                  className={`text-sm font-semibold ${
                    tx.type === 'income'
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : tx.type === 'expense'
                        ? 'text-red-700 dark:text-red-400'
                        : 'text-blue-700 dark:text-blue-400'
                  }`}
                >
                  {tx.type === 'expense' ? '-' : '+'}
                  {formatCurrency(tx.amount)}
                </span>
                {/* Edit button */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => handleEdit(tx, e.currentTarget)}
                  aria-label="Edit transaction"
                  className="text-zinc-400 hover:text-blue-600 dark:text-zinc-500 dark:hover:text-blue-400"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                    />
                  </svg>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  isLoading={deletingId === tx.id}
                  onClick={() => handleDelete(tx.id)}
                  aria-label="Delete transaction"
                  className="text-zinc-400 hover:text-red-600 dark:text-zinc-500 dark:hover:text-red-400"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                    />
                  </svg>
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Edit transaction modal */}
      <EditTransactionModal
        transaction={editingTx}
        onClose={() => setEditingTx(null)}
      />
    </div>
  );
}
