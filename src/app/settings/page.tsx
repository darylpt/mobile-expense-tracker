// ============================================================
// Settings page — Accounts and Categories CRUD management
//
// Two sections: Accounts (inline edit/add/delete) and
// Categories (grouped by type, same inline CRUD pattern).
// ============================================================

'use client';

import React, { useState, useRef } from 'react';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { useAuth } from '@/context/AuthContext';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { useRouter } from 'next/navigation';
import { getAllTransactions, exportAllData, importAllData, transactionsToCsv, importFromCsv } from '@/lib/idb';
import { formatCurrency } from '@/lib/utils';
import type { Account, Category, TransactionType } from '@/types';
import { parseCsv, type ParsedCsv } from '@/lib/csv-import';
import { getSyncQueueCount } from '@/lib/idb';
import { backgroundSync } from '@/lib/sync';
import { CsvImportPreview } from '@/components/forms/CsvImportPreview';

export default function SettingsPage() {
  const { state: authState, signOut } = useAuth();
  const router = useRouter();

  const {
    accounts,
    isLoading: accountsLoading,
    addAccount,
    updateAccount,
    deleteAccount,
    moveAccountTo,
  } = useAccounts();

  const {
    categories,
    isLoading: categoriesLoading,
    addCategory,
    updateCategory,
    deleteCategory,
    moveCategoryTo,
  } = useCategories();

  const handleSignOut = async () => {
    // Try to push pending changes before signing out
    try { await backgroundSync(); } catch { /* offline or error — check queue below */ }
    const pending = await getSyncQueueCount();
    if (pending > 0 && !window.confirm(
      `You have ${pending} unsaved change${pending === 1 ? '' : 's'} that couldn't be synced. Signing out will lose these changes. Continue?`
    )) return;
    await signOut();
    router.push('/login');
  };

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <Header title="Settings" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {accountsLoading || categoriesLoading ? (
          <LoadingSkeleton />
        ) : (
          <div className="space-y-6">
            <TabVisibilitySection />
            <BackupSection />
            <ImportSection />
            <SyncSection />

            {authState === 'authenticated' && (
              <>
                <hr className="my-4 border-zinc-200 dark:border-zinc-700" />
                <Button variant="ghost" size="sm" onClick={handleSignOut}>
                  Sign out
                </Button>
              </>
            )}

            <div className="lg:grid lg:grid-cols-2 lg:gap-6">
              <AccountsSection
                accounts={accounts}
                onAdd={addAccount}
                onUpdate={updateAccount}
                onDelete={deleteAccount}
                onMoveTo={moveAccountTo}
              />
              <CategoriesSection
                categories={categories}
                onAdd={addCategory}
                onUpdate={updateCategory}
                onDelete={deleteCategory}
                onMoveTo={moveCategoryTo}
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
  onMoveTo: (id: string, targetIndex: number) => Promise<void>;
}

function AccountsSection({ accounts, onAdd, onUpdate, onDelete, onMoveTo }: AccountsSectionProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [deleteWarning, setDeleteWarning] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

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

  const handleDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverId(id);
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    setDragOverId(null);
    const draggedId = e.dataTransfer.getData('text/plain');
    if (!draggedId || draggedId === targetId) return;
    const targetIndex = accounts.findIndex((a) => a.id === targetId);
    if (targetIndex < 0) return;
    onMoveTo(draggedId, targetIndex);
  };

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
      <h2 className="mb-1 text-base font-semibold text-zinc-900 dark:text-zinc-100">Accounts</h2>
      <p className="mb-3 text-xs text-zinc-400 dark:text-zinc-500">↕ Drag rows to reorder</p>

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
                  draggable
                  onDragStart={(e) => handleDragStart(e, account.id)}
                  onDragOver={(e) => handleDragOver(e, account.id)}
                  onDragLeave={() => setDragOverId(null)}
                  onDrop={(e) => handleDrop(e, account.id)}
                  className={`border-b border-zinc-100 text-zinc-800 last:border-0 dark:border-zinc-800 dark:text-zinc-200 ${
                    dragOverId === account.id ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                  }`}
                >
                  <td className="py-2 pr-4 font-medium">{account.name}</td>
                  <td className="py-2 px-2 text-right tabular-nums">
{formatCurrency(account.startingBalance ?? 0)}
                  </td>
                  <td className="py-2 pl-2 text-right">
                    <div className="flex justify-end gap-0.5">
                      <Button variant="ghost" size="sm" onClick={() => startEdit(account)}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleDelete(account)}>
                        Del
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
  onMoveTo: (id: string, targetIndex: number) => Promise<void>;
}

function CategoriesSection({ categories, onAdd, onUpdate, onDelete, onMoveTo }: CategoriesSectionProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addType, setAddType] = useState<TransactionType | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [deleteWarning, setDeleteWarning] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

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

  const handleDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverId(id);
  };

  const handleDrop = (e: React.DragEvent, targetId: string, type: TransactionType) => {
    e.preventDefault();
    setDragOverId(null);
    const draggedId = e.dataTransfer.getData('text/plain');
    if (!draggedId || draggedId === targetId) return;
    const group = catsByType(type);
    const targetIndex = group.findIndex((c) => c.id === targetId);
    if (targetIndex < 0) return;
    onMoveTo(draggedId, targetIndex);
  };

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
      <h2 className="mb-1 text-base font-semibold text-zinc-900 dark:text-zinc-100">
        Categories
      </h2>
      <p className="mb-3 text-xs text-zinc-400 dark:text-zinc-500">↕ Drag rows to reorder</p>

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
                        draggable
                        onDragStart={(e) => handleDragStart(e, cat.id)}
                        onDragOver={(e) => handleDragOver(e, cat.id)}
                        onDragLeave={() => setDragOverId(null)}
                        onDrop={(e) => handleDrop(e, cat.id, type)}
                        className={`border-b border-zinc-100 text-zinc-800 last:border-0 dark:border-zinc-800 dark:text-zinc-200 ${
                          dragOverId === cat.id ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                        }`}
                      >
                        <td className="py-2 pr-4 font-medium">{cat.name}</td>
                        <td className="py-2 pl-2 text-right">
                          <div className="flex justify-end gap-0.5">
                            <Button variant="ghost" size="sm" onClick={() => startEdit(cat)}>
                              Edit
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => handleDelete(cat)}>
                              Del
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

// ============================================================
// Backup / Restore
// ============================================================

function BackupSection() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const handleExport = async () => {
    try {
      const backup = await exportAllData();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `expense-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg('Export downloaded.');
    } catch {
      setMsg('Export failed.');
    }
  };

  const handleExportCsv = async () => {
    try {
      const { getAllTransactions } = await import('@/lib/idb');
      const txs = await getAllTransactions();
      const csv = transactionsToCsv(txs);
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `expense-tracker-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg('CSV downloaded.');
    } catch {
      setMsg('CSV export failed.');
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!window.confirm('Import will REPLACE all current data. Are you sure?')) {
      e.target.value = '';
      return;
    }
    try {
      const text = await file.text();
      const backup = JSON.parse(text) as Parameters<typeof importAllData>[0];
      if (!backup.version || !backup.data) throw new Error('Invalid backup file');
      await importAllData(backup);
      setMsg('Data imported. Reload the page to see changes.');
    } catch {
      setMsg('Import failed — check file format.');
    }
    e.target.value = '';
  };

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
      <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        Backup &amp; Restore
      </h2>
      <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
        Export all data as JSON, or import from a previous backup. All data lives
        in your browser — there is no cloud sync.
      </p>

      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" size="sm" onClick={handleExport}>
          Export All (JSON)
        </Button>
        <Button variant="secondary" size="sm" onClick={handleExportCsv}>
          Export Transactions (CSV)
        </Button>
        <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>
          Import from file…
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json"
          onChange={handleImport}
          className="hidden"
        />
      </div>

      {msg && (
        <p role="status" aria-live="polite" className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
          {msg}
        </p>
      )}
    </section>
  );
}

// ============================================================
// CSV Import Section
// ============================================================

function ImportSection() {
  const [csvText, setCsvText] = useState('');
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleParse = (text: string) => {
    setMsg(null);
    setCsvText(text);
    if (!text.trim()) {
      setParsed(null);
      return;
    }
    try {
      const result = parseCsv(text);
      setParsed(result);
    } catch {
      setParsed(null);
      setMsg('Failed to parse CSV.');
    }
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      handleParse(reader.result as string);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleImport = async () => {
    if (!parsed || parsed.transactions.length === 0) return;
    if (!window.confirm('Import will REPLACE all current data. Are you sure?')) return;
    setIsImporting(true);
    setMsg(null);
    try {
      await importFromCsv(csvText);
      setMsg('Data imported successfully! Reload the page to see changes.');
      setParsed(null);
      setCsvText('');
    } catch {
      setMsg('Import failed.');
    } finally {
      setIsImporting(false);
    }
  };

  const handleCancel = () => {
    setCsvText('');
    setParsed(null);
    setMsg(null);
  };

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
      <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        Import from Google Sheets
      </h2>
      <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
        Paste CSV data below or upload a <code>.csv</code> file. The CSV becomes
        the single source of truth — all current data will be replaced.
      </p>

      <textarea
        value={csvText}
        onChange={(e) => handleParse(e.target.value)}
        placeholder={`Paste CSV here...
Example:
Date,Amount,Description,Type,Category,From Account,To Account
1/5/2026,₱1489.00,Monthly salary,,Paycheck,,GoTyme`}
        rows={6}
        className="mb-3 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 transition-colors focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-500 dark:focus:border-blue-400"
      />

      <div className="mb-3">
        <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>
          Upload CSV file…
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          onChange={handleFile}
          className="hidden"
        />
      </div>

      {msg && (
        <p role="status" aria-live="polite" className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
          {msg}
        </p>
      )}

      <CsvImportPreview
        parsed={parsed}
        onImport={handleImport}
        onCancel={handleCancel}
        isImporting={isImporting}
      />
    </section>
  );
}

// ============================================================
// Sync Section — manual trigger to push local changes to cloud
// ============================================================

function SyncSection() {
  const { state: authState } = useAuth();
  const router = useRouter();
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(() => {
    const stored = localStorage.getItem('lastSyncTime');
    return stored ? formatSyncTime(Number(stored)) : null;
  });

  if (authState !== 'authenticated') return null;

  const handleSync = async () => {
    setIsSyncing(true);
    setSyncMsg(null);
    try {
      await backgroundSync();
      const remaining = await getSyncQueueCount();
      if (remaining === 0) {
        const now = Date.now();
        localStorage.setItem('lastSyncTime', String(now));
        setLastSync(formatSyncTime(now));
        setSyncMsg('Synced!');
      } else {
        setSyncMsg(`${remaining} entr${remaining === 1 ? 'y' : 'ies'} couldn't be synced — check connection.`);
      }
    } catch {
      setSyncMsg('Sync failed — check connection.');
    } finally {
      setIsSyncing(false);
      router.refresh();
    }
  };

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-6">
      <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        Cloud Sync
      </h2>
      <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
        Push local changes to the cloud and pull the latest data.
      </p>
      <div className="flex items-center gap-3">
        <Button variant="secondary" size="sm" onClick={handleSync} disabled={isSyncing}>
          {isSyncing ? 'Syncing…' : 'Sync now'}
        </Button>
        {lastSync && (
          <span className="text-xs text-zinc-400 dark:text-zinc-500">
            Last sync: {lastSync}
          </span>
        )}
      </div>
      {syncMsg && (
        <p role="status" aria-live="polite" className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
          {syncMsg}
        </p>
      )}
    </section>
  );
}

function formatSyncTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;

  const hours = d.getHours().toString().padStart(2, '0');
  const mins = d.getMinutes().toString().padStart(2, '0');
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `today at ${hours}:${mins}`;

  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${month}/${day} ${hours}:${mins}`;
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
