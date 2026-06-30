// ============================================================
// TransactionFormFields - Shared field grid for add/edit forms
// Renders the 2-column grid of Input/Dropdown fields with
// conditional account visibility and error display.
// ============================================================

'use client';

import React from 'react';
import { Input } from '@/components/common/Input';
import { Dropdown } from '@/components/common/Dropdown';
import type { TransactionType, Category, Account } from '@/types';

// ============================================================
// Form state type (shared between QuickAddForm and EditModal)
// ============================================================

export interface FormState {
  amount: string;
  date: string;
  type: TransactionType;
  category: string;
  fromAccount: string;
  toAccount: string;
  description: string;
}

// ============================================================
// Props
// ============================================================

interface TransactionFormFieldsProps {
  form: FormState;
  onFieldChange: (field: keyof FormState, value: string) => void;
  error: string | null;
  categories: Category[];
  accounts: Account[];
}

// ============================================================
// Constants
// ============================================================

const TYPE_OPTIONS = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
  { value: 'transaction', label: 'Transfer' },
];

// ============================================================
// Shared validation — used by QuickAddForm and EditTransactionModal
// ============================================================

/** Returns an error string if the form is invalid, or null if OK. */
export function validateTransactionForm(form: FormState): string | null {
  const amountNum = parseFloat(form.amount);
  if (isNaN(amountNum) || amountNum <= 0) return 'Please enter a valid positive amount.';
  if (!form.date) return 'Please select a date.';
  if (!form.category) return 'Please select a category.';

  if (form.type === 'income') {
    if (!form.toAccount) return 'Please select a destination account (To Account).';
  } else if (form.type === 'expense') {
    if (!form.fromAccount) return 'Please select a source account (From Account).';
  } else if (form.type === 'transaction') {
    if (!form.fromAccount || !form.toAccount) return 'Please select both From Account and To Account.';
    if (form.fromAccount === form.toAccount) return 'From Account and To Account must be different.';
  }

  return null;
}

// ============================================================
// TransactionFormFields Component
// ============================================================

export function TransactionFormFields({
  form,
  onFieldChange,
  error,
  categories,
  accounts,
}: TransactionFormFieldsProps) {
  // Compute category options filtered by current type
  const categoryOptions = categories
    .filter((c) => c.type === form.type)
    .map((c) => ({ value: c.name, label: c.name }));

  const accountOptions = accounts.map((a) => ({
    value: a.id,
    label: a.name,
  }));

  // Conditional account field visibility (same logic as QuickAddForm)
  const showFromAccount =
    form.type === 'expense' || form.type === 'transaction';

  const showToAccount =
    form.type === 'income' ||
    form.type === 'transaction' ||
    (form.type === 'expense' &&
      (form.category === 'Savings' || form.category === 'Investment'));

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Amount */}
        <Input
          label="Amount"
          type="number"
          step="0.01"
          min="0"
          placeholder="0.00"
          value={form.amount}
          onChange={(e) => onFieldChange('amount', e.target.value)}
          leading={<span>₱</span>}
          required
        />

        {/* Date */}
        <Input
          label="Date"
          type="date"
          value={form.date}
          onChange={(e) => onFieldChange('date', e.target.value)}
          required
        />

        {/* Type */}
        <Dropdown
          label="Type"
          options={TYPE_OPTIONS}
          value={form.type}
          onChange={(e) => onFieldChange('type', e.target.value as TransactionType)}
        />

        {/* Category */}
        <Dropdown
          label="Category"
          options={categoryOptions}
          value={form.category}
          onChange={(e) => onFieldChange('category', e.target.value)}
        />

        {/* From Account — shown for expense and transaction */}
        {showFromAccount && (
          <Dropdown
            label="From Account"
            options={accountOptions}
            value={form.fromAccount}
            onChange={(e) => onFieldChange('fromAccount', e.target.value)}
            placeholder={
              form.type === 'expense' ? 'Select source account' : 'Select account'
            }
          />
        )}

        {/* To Account — shown for income, transaction, or expense with Savings/Investment */}
        {showToAccount && (
          <Dropdown
            label="To Account"
            options={accountOptions}
            value={form.toAccount}
            onChange={(e) => onFieldChange('toAccount', e.target.value)}
            placeholder={
              form.type === 'income'
                ? 'Select destination account'
                : 'Select account'
            }
          />
        )}

        {/* Description */}
        <Input
          label="Description (optional)"
          type="text"
          placeholder="Add a note..."
          value={form.description}
          onChange={(e) => onFieldChange('description', e.target.value)}
        />
      </div>

      {/* Error message */}
      {error && (
        <div className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-400">
          {error}
        </div>
      )}
    </>
  );
}
