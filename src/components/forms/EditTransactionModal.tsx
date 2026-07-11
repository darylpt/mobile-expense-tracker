// ============================================================
// EditTransactionModal - Modal overlay for editing a transaction
// Portal-based, focus-trapped, pre-populated form that calls
// updateTransaction on save.
// ============================================================

'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTransactions } from '@/hooks/useTransactions';
import { useCategories } from '@/hooks/useCategories';
import { useAccounts } from '@/hooks/useAccounts';
import { TransactionFormFields, validateTransactionForm, type FormState } from './TransactionFormFields';
import { Button } from '@/components/common/Button';
import type { Transaction } from '@/types';

// ============================================================
// Props
// ============================================================

interface EditTransactionModalProps {
  transaction: Transaction | null;
  onClose: () => void;
}

// ============================================================
// EditTransactionModal Component
// ============================================================

export function EditTransactionModal({ transaction, onClose }: EditTransactionModalProps) {
  const { updateTransaction } = useTransactions();
  const { categories } = useCategories();
  const { accounts } = useAccounts();

  // Derive form state from a Transaction object
  const initForm = (tx: Transaction): FormState => ({
    amount: String(tx.amount),
    date: tx.date,
    type: tx.type,
    category: tx.category,
    fromAccount: tx.fromAccount ?? '',
    toAccount: tx.toAccount ?? '',
    description: tx.description ?? '',
  });

  const [form, setForm] = useState<FormState>(() => transaction ? initForm(transaction) : {
    amount: '', date: '', type: 'expense' as const, category: '', fromAccount: '', toAccount: '', description: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

  // Sync form when transaction prop changes (modal reused in list, not remounted)
  // ponytail: intentional — modal stays mounted; key-based remount would be heavier
  useEffect(() => {
    if (transaction) setForm(initForm(transaction)); // eslint-disable-line react-hooks/set-state-in-effect
  }, [transaction]);

  // Focus trap + Escape key handler
  useEffect(() => {
    if (!transaction) return;

    const modal = modalRef.current;
    if (!modal) return;

    // Focus the first focusable element inside the modal
    const focusableSelector =
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const firstFocusable = modal.querySelector<HTMLElement>(focusableSelector);
    firstFocusable?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }

      if (e.key === 'Tab') {
        const focusables = modal.querySelectorAll<HTMLElement>(focusableSelector);
        if (focusables.length === 0) return;

        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [transaction, onClose]);

  // Update a single form field (same side effects as QuickAddForm)
  const updateField = useCallback(
    (field: keyof FormState, value: string) => {
      setForm((prev) => {
        const next = { ...prev, [field]: value };

        // Reset category when type changes
        if (field === 'type') {
          const filtered = categories.filter((c) => c.type === value);
          next.category = filtered.length > 0 ? filtered[0].name : '';
          if (value === 'income') {
            next.fromAccount = '';
          } else if (value === 'expense') {
            next.toAccount = '';
          }
        }

        return next;
      });
    },
    [categories]
  );

  // Validate and save
  const handleSave = async () => {
    if (!transaction) return;
    setError(null);

    const validationError = validateTransactionForm(form);
    if (validationError) {
      setError(validationError);
      return;
    }

    const amountNum = parseFloat(form.amount);
    setIsSubmitting(true);
    try {
      await updateTransaction({
        ...transaction,
        amount: amountNum,
        date: form.date,
        type: form.type,
        category: form.category,
        fromAccount: form.fromAccount || null,
        toAccount: form.toAccount || null,
        description: form.description.trim() || undefined,
        updatedAt: Date.now(),
      });
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update transaction';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Close on backdrop click (not on modal body click)
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  if (!transaction) return null;

  return createPortal(
    <div
      key={transaction.id}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={handleBackdropClick}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-transaction-heading"
        className="relative mx-4 w-full max-w-lg rounded-xl bg-white p-6 shadow-xl dark:bg-zinc-800"
      >
        {/* Close button (X) */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* Heading */}
        <h2
          id="edit-transaction-heading"
          className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100"
        >
          Edit Transaction
        </h2>

        {/* Form fields */}
        <TransactionFormFields
          form={form}
          onFieldChange={updateField}
          error={error}
          categories={categories}
          accounts={accounts}
        />

        {/* Action buttons */}
        <div className="mt-4 flex items-center justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" isLoading={isSubmitting} onClick={handleSave}>
            Save Changes
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
