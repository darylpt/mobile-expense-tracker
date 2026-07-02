// ============================================================
// Settings page — Accounts and Categories CRUD management
//
// Two sections: Accounts (inline edit/add/delete) and
// Categories (grouped by type, same inline CRUD pattern).
// ============================================================

'use client';

import React, { useState } from 'react';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { getAllTransactions } from '@/lib/idb';
import { formatCurrency } from '@/lib/utils';
import type { Account, Category, TransactionType } from '@/types';

export default function SettingsPage() {
  const {
    accounts,
    isLoading: accountsLoading,
    addAccount,
    updateAccount,
    deleteAccount,
  } = useAccounts();

  const {
    categories,
    isLoading: categoriesLoading,
    addCategory,
    updateCategory,
    deleteCategory,
  } = useCategories();

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <Header title="Settings" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {accountsLoading || categoriesLoading ? (
          <LoadingSkeleton />
        ) : (
          <div className="space-y-6">
            <TabVisibilitySection />

            <div className="lg:grid lg:grid-cols-2 lg:gap-6">
              <AccountsSection
                accounts={accounts}
                onAdd={addAccount}
                onUpdate={updateAccount}
                onDelete={deleteAccount}
              />
              <CategoriesSection
                categories={categories}
                onAdd={addCategory}
                onUpdate={updateCategory}
                onDelete={deleteCategory}
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ============================================================
// Accounts Section
// ============================================================

interface AccountsSectionProps {
  accounts: Account[];
  onAdd: (account: Omit<Account, 'id'>) => Promise<string>;
  onUpdate: (account: Account) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function AccountsSection({ accounts, onAdd, onUpdate, onDelete }: AccountsSectionProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [deleteWarning, setDeleteWarning] = useState<string | null>(null);

  const startEdit = (account: Account) => {
    setEditingId(account.id);
    setEditValues({ name: account.name, startingBalance: String(account.startingBalance) });
    setAddMode(false);
    setDeleteWarning(null);
  };

  const startAdd = () => {
    setAddMode(true);
    setEditingId(null);
    setEditValues({ name: '', startingBalance: '0' });
    setDeleteWarning(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValues({});
  };

  const cancelAdd = () => {
    setAddMode(false);
    setEditValues({});
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    const name = editValues.name?.trim();
    if (!name) return;
    const duplicate = accounts.find(
      (a) => a.id !== editingId && a.name.toLowerCase() === name.toLowerCase()
    );
    if (duplicate) {
      setDeleteWarning(`Account name "${name}" already exists.`);
      return;
    }
    const startingBalance = parseFloat(editValues.startingBalance) || 0;
    try {
      await onUpdate({ id: editingId, name, startingBalance });
      setEditingId(null);
      setEditValues({});
      setDeleteWarning(null);
    } catch {
      setDeleteWarning('Failed to save account.');
    }
  };

  const handleSaveAdd = async () => {
    const name = editValues.name?.trim();
    if (!name) return;
    const duplicate = accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (duplicate) {
      setDeleteWarning(`Account name "${name}" already exists.`);
      return;
    }
    const startingBalance = parseFloat(editValues.startingBalance) || 0;
    try {
      await onAdd({ name, startingBalance });
      setAddMode(false);
      setEditValues({});
      setDeleteWarning(null);
    } catch {
      setDeleteWarning('Failed to add account.');
    }
  };

  const handleDelete = async (account: Account) => {
    setDeleteWarning(null);
    const txs = await getAllTransactions();
    const used = txs.some((tx) => tx.fromAccount === account.id || tx.toAccount === account.id);
    if (used) {
      setDeleteWarning(
        `Cannot delete "${account.name}": it is used by one or more transactions. Remove or reassign those transactions first.`
      );
      return;
    }
    try {
      await onDelete(account.id);
    } catch {
      setDeleteWarning('Failed to delete account.');
    }
  };

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
      <h2 className="mb-4 text-base font-semibold text-zinc-900 dark:text-zinc-100">Accounts</h2>

      {deleteWarning && (
        <p role="status" aria-live="polite" className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-400">
          {deleteWarning}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-xs uppercase text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              <th scope="col" className="py-2 pr-4 font-medium">Name</th>
              <th scope="col" className="py-2 px-2 text-right font-medium">Starting Balance</th>
              <th scope="col" className="py-2 pl-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) =>
              editingId === account.id ? (
                <tr key={account.id} className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4">
                    <Input
                      value={editValues.name ?? account.name}
                      onChange={(e) => setEditValues({ ...editValues, name: e.target.value })}
                      placeholder="Account name"
                      aria-label="Account name"
                    />
                  </td>
                  <td className="py-2 px-2 text-right">
                    <Input
                      type="number"
                      step="any"
                      value={editValues.startingBalance ?? String(account.startingBalance)}
                      onChange={(e) =>
                        setEditValues({ ...editValues, startingBalance: e.target.value })
                      }
                      aria-label="Starting balance"
                      leading={<span className="text-zinc-500">₱</span>}
                    />
                  </td>
                  <td className="py-2 pl-2 text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={handleSaveEdit}>
                        Save
                      </Button>
                      <Button variant="ghost" size="sm" onClick={cancelEdit}>
                        Cancel
                      </Button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr
                  key={account.id}
                  className="border-b border-zinc-100 text-zinc-800 last:border-0 dark:border-zinc-800 dark:text-zinc-200"
                >
                  <td className="py-2 pr-4 font-medium">{account.name}</td>
                  <td className="py-2 px-2 text-right tabular-nums">
{formatCurrency(account.startingBalance ?? 0)}
                  </td>
                  <td className="py-2 pl-2 text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => startEdit(account)}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleDelete(account)}>
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              )
            )}
            {addMode && (
              <tr className="border-b border-zinc-100 dark:border-zinc-800">
                <td className="py-2 pr-4">
                    <Input
                      value={editValues.name ?? ''}
                      onChange={(e) => setEditValues({ ...editValues, name: e.target.value })}
                      placeholder="Account name"
                      aria-label="Account name"
                    />
                  </td>
                  <td className="py-2 px-2 text-right">
                    <Input
                      type="number"
                      step="any"
                      value={editValues.startingBalance ?? '0'}
                      onChange={(e) =>
                        setEditValues({ ...editValues, startingBalance: e.target.value })
                      }
                      aria-label="Starting balance"
                      leading={<span className="text-zinc-500">₱</span>}
                    />
                </td>
                <td className="py-2 pl-2 text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={handleSaveAdd}>
                      Save
                    </Button>
                    <Button variant="ghost" size="sm" onClick={cancelAdd}>
                      Cancel
                    </Button>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {accounts.length === 0 && !addMode && (
          <p className="py-4 text-center text-sm text-zinc-500">No accounts configured.</p>
        )}
      </div>

      {!addMode && (
        <div className="mt-3">
          <Button variant="ghost" size="sm" onClick={startAdd}>
            + Add Account
          </Button>
        </div>
      )}
    </section>
  );
}

// ============================================================
// Categories Section
// ============================================================

const CATEGORY_TYPES: { label: string; type: TransactionType }[] = [
  { label: 'Expense', type: 'expense' },
  { label: 'Income', type: 'income' },
  { label: 'Transfer', type: 'transaction' },
];

interface CategoriesSectionProps {
  categories: Category[];
  onAdd: (category: Omit<Category, 'id'>) => Promise<string>;
  onUpdate: (category: Category) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function CategoriesSection({ categories, onAdd, onUpdate, onDelete }: CategoriesSectionProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addType, setAddType] = useState<TransactionType | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [deleteWarning, setDeleteWarning] = useState<string | null>(null);

  const startEdit = (cat: Category) => {
    setEditingId(cat.id);
    setEditValues({ name: cat.name });
    setAddType(null);
    setDeleteWarning(null);
  };

  const startAdd = (type: TransactionType) => {
    setAddType(type);
    setEditingId(null);
    setEditValues({ name: '' });
    setDeleteWarning(null);
  };

  const cancel = () => {
    setEditingId(null);
    setAddType(null);
    setEditValues({});
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    const name = editValues.name?.trim();
    if (!name) return;
    const cat = categories.find((c) => c.id === editingId);
    if (!cat) return;
    const duplicate = categories.find(
      (c) => c.id !== editingId && c.type === cat.type && c.name.toLowerCase() === name.toLowerCase()
    );
    if (duplicate) {
      setDeleteWarning(`Category name "${name}" already exists in ${cat.type}.`);
      return;
    }
    try {
      await onUpdate({ id: editingId, name, type: cat.type });
      setEditingId(null);
      setEditValues({});
      setDeleteWarning(null);
    } catch {
      setDeleteWarning('Failed to save category.');
    }
  };

  const handleSaveAdd = async (type: TransactionType) => {
    const name = editValues.name?.trim();
    if (!name) return;
    const duplicate = categories.find(
      (c) => c.type === type && c.name.toLowerCase() === name.toLowerCase()
    );
    if (duplicate) {
      setDeleteWarning(`Category name "${name}" already exists in ${type}.`);
      return;
    }
    try {
      await onAdd({ name, type });
      setAddType(null);
      setEditValues({});
      setDeleteWarning(null);
    } catch {
      setDeleteWarning('Failed to add category.');
    }
  };

  const handleDelete = async (cat: Category) => {
    setDeleteWarning(null);
    const txs = await getAllTransactions();
    const used = txs.some((tx) => tx.category === cat.name);
    if (used) {
      setDeleteWarning(
        `Cannot delete "${cat.name}": it is used by one or more transactions. Remove or reassign those transactions first.`
      );
      return;
    }
    try {
      await onDelete(cat.id);
    } catch {
      setDeleteWarning('Failed to delete category.');
    }
  };

  const catsByType = (type: TransactionType) =>
    categories.filter((c) => c.type === type);

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
      <h2 className="mb-4 text-base font-semibold text-zinc-900 dark:text-zinc-100">
        Categories
      </h2>

      {deleteWarning && (
        <p role="status" aria-live="polite" className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-400">
          {deleteWarning}
        </p>
      )}

      {CATEGORY_TYPES.map(({ label, type }) => {
        const filtered = catsByType(type);
        const isAdding = addType === type;
        return (
          <div key={type} className="mb-6 last:mb-0">
            <h3 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
              {label}
            </h3>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-xs uppercase text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                    <th scope="col" className="py-2 pr-4 font-medium">Name</th>
                    <th scope="col" className="py-2 pl-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((cat) =>
                    editingId === cat.id ? (
                      <tr key={cat.id} className="border-b border-zinc-100 dark:border-zinc-800">
                        <td className="py-2 pr-4">
                          <Input
                            value={editValues.name ?? cat.name}
                            onChange={(e) =>
                              setEditValues({ ...editValues, name: e.target.value })
                            }
                            placeholder="Category name"
                            aria-label="Category name"
                          />
                        </td>
                        <td className="py-2 pl-2 text-right">
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="sm" onClick={handleSaveEdit}>
                              Save
                            </Button>
                            <Button variant="ghost" size="sm" onClick={cancel}>
                              Cancel
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      <tr
                        key={cat.id}
                        className="border-b border-zinc-100 text-zinc-800 last:border-0 dark:border-zinc-800 dark:text-zinc-200"
                      >
                        <td className="py-2 pr-4 font-medium">{cat.name}</td>
                        <td className="py-2 pl-2 text-right">
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="sm" onClick={() => startEdit(cat)}>
                              Edit
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => handleDelete(cat)}>
                              Delete
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  )}
                  {isAdding && (
                    <tr className="border-b border-zinc-100 dark:border-zinc-800">
                      <td className="py-2 pr-4">
                        <Input
                          value={editValues.name ?? ''}
                          onChange={(e) =>
                            setEditValues({ ...editValues, name: e.target.value })
                          }
                          placeholder="Category name"
                          aria-label="Category name"
                        />
                      </td>
                      <td className="py-2 pl-2 text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleSaveAdd(type)}
                          >
                            Save
                          </Button>
                          <Button variant="ghost" size="sm" onClick={cancel}>
                            Cancel
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {filtered.length === 0 && !isAdding && (
                <p className="py-3 text-center text-sm text-zinc-500">
                  No {label.toLowerCase()} categories.
                </p>
              )}
            </div>

            {!isAdding && (
              <div className="mt-2">
                <Button variant="ghost" size="sm" onClick={() => startAdd(type)}>
                  + Add {label} Category
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

// ============================================================
// Tab visibility preferences

function TabVisibilitySection() {
  const [prefs, setPrefs] = useState(() => {
    try {
      const stored = localStorage.getItem('tab_prefs');
      if (stored) return { showBalances: true, showPayout: true, ...JSON.parse(stored) };
    } catch { /* ignore */ }
    return { showBalances: true, showPayout: true };
  });

  const toggle = (key: string) => {
    const next = { ...prefs, [key]: !(prefs as Record<string, boolean>)[key] };
    setPrefs(next);
    localStorage.setItem('tab_prefs', JSON.stringify(next));
    window.dispatchEvent(new Event('storage'));
  };

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
      <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        Tab Visibility
      </h2>
      <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
        Show or hide optional tabs in the navigation bar.
      </p>
      <div className="flex flex-col gap-3">
        <ToggleRow
          label="Balances"
          checked={prefs.showBalances}
          onChange={() => toggle('showBalances')}
        />
        <ToggleRow
          label="Payout"
          checked={prefs.showPayout}
          onChange={() => toggle('showPayout')}
        />
      </div>
    </section>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between">
      <span className="text-sm text-zinc-700 dark:text-zinc-300">{label}</span>
      <button
        role="switch"
        aria-checked={checked}
        onClick={onChange}
        className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${
          checked ? 'bg-blue-600' : 'bg-zinc-300 dark:bg-zinc-600'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
    </label>
  );
}

// Loading skeleton
// ============================================================

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
        <div className="mb-4 h-6 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="h-32 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
      </div>
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
        <div className="mb-4 h-6 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="h-48 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
      </div>
    </div>
  );
}
