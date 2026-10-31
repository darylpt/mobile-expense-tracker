// ============================================================
// QuickAddForm - Form for quickly adding a new transaction
// Manages local form state and submits to the TransactionContext.
// Shows From Account / To Account fields based on transaction type.
// ============================================================

'use client';

import React, { useState, useCallback, useRef, useSyncExternalStore } from 'react';
import { useTransactions } from '@/hooks/useTransactions';
import { useCategories } from '@/hooks/useCategories';
import { useAccounts } from '@/hooks/useAccounts';
import { Button } from '@/components/common/Button';
import { TransactionFormFields, validateTransactionForm, type FormState } from './TransactionFormFields';
import { getToday } from '@/lib/utils';
import type { TransactionType } from '@/types';

// ============================================================
// Initial form state
// ============================================================

const initialFormState: FormState = {
  amount: '',
  date: getToday(),
  type: 'expense',
  category: '',
  fromAccount: '',
  toAccount: '',
  description: '',
};

const PANEL_ID = 'quick-add-panel';
const MOBILE_QUERY = '(max-width: 767px)';

const subscribeMobile = (onChange: () => void) => {
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

// ============================================================
// QuickAddForm Component
// ============================================================

export function QuickAddForm() {
  const { addTransaction, isLoading: isTxLoading } = useTransactions();
  const { accounts } = useAccounts();
  const { getCategoriesByType, categories } = useCategories();

  const [form, setForm] = useState<FormState>(initialFormState);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  const isMobile = useSyncExternalStore(
    subscribeMobile,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false
  );
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Update a single form field
  const updateField = useCallback(
    <K extends keyof FormState>(field: K, value: FormState[K]) => {
      setForm((prev) => {
        const next = { ...prev, [field]: value };

        // Reset category when type changes
        if (field === 'type') {
          const cats = getCategoriesByType(value as TransactionType);
          next.category = cats.length > 0 ? cats[0].name : '';
          // Reset account fields on type change
          if (value === 'income') {
            next.fromAccount = '';
          } else if (value === 'expense') {
            next.toAccount = '';
          }
          // transaction: leave both as-is (user must fill both)
        }

        return next;
      });
    },
    [getCategoriesByType]
  );

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return; // ponytail: belt-and-suspenders double-submit guard
    setError(null);

    // Validation
    const validationError = validateTransactionForm(form);
    if (validationError) {
      setError(validationError);
      return;
    }

    const amountNum = parseFloat(form.amount);
    setIsSubmitting(true);
    try {
      // Build the payload: use null for empty account fields
      await addTransaction({
        amount: amountNum,
        date: form.date,
        type: form.type,
        category: form.category,
        fromAccount: form.fromAccount || null,
        toAccount: form.toAccount || null,
        description: form.description.trim() || undefined,
      });

      // Reset form on success — keep type/category/account/description sticky
      setForm((prev) => ({
        ...initialFormState,
        type: prev.type,
        category: prev.category,
        fromAccount: prev.fromAccount,
        toAccount: prev.toAccount,
        description: prev.description,
      }));
      setCollapsed(true);
      if (isMobile) toggleRef.current?.focus();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add transaction';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle keyboard shortcut: Ctrl+Enter to submit
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.key === 'Enter') {
      handleSubmit(e);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      onKeyDown={handleKeyDown}
      className="rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50"
    >
      <button
        ref={toggleRef}
        type="button"
        onClick={() => { if (isMobile) setCollapsed(!collapsed); }}
        className="flex w-full items-center justify-between px-4 py-3 text-left sm:px-6 md:hidden"
        aria-expanded={!collapsed}
        aria-controls={PANEL_ID}
      >
        <span className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          {collapsed ? (
            <>
              <span className="mr-1.5 inline-block text-blue-500">+</span>
              Add Transaction
            </>
          ) : (
            'Quick Add'
          )}
        </span>
        <span className={`text-xs text-zinc-500 transition-transform dark:text-zinc-400 ${collapsed ? '' : 'rotate-180'}`}>
          ▼
        </span>
      </button>
      <div className="hidden w-full items-center px-4 py-3 sm:px-6 md:flex">
        <span className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          <span className="mr-1.5 inline-block text-blue-500">+</span>
          Add Transaction
        </span>
      </div>

      {/* Expanded: form fields + submit */}
      <div
        id={PANEL_ID}
        inert={collapsed && isMobile}
        className={`overflow-hidden transition-all md:!max-h-full ${collapsed ? 'max-h-0' : 'max-h-[2000px]'}`}
      >
        <div className="border-t border-zinc-200 px-4 pb-4 pt-3 dark:border-zinc-700 sm:px-6 sm:pb-6">
          <TransactionFormFields
            form={form}
            onFieldChange={updateField}
            error={error}
            categories={categories}
            accounts={accounts}
          />

          <div className="mt-4 flex items-center justify-between">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              Press Ctrl+Enter to submit
            </span>
            <Button type="submit" variant="primary" isLoading={isSubmitting || isTxLoading}>
              Add Transaction
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}
