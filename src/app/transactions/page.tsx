// ============================================================
// Transactions Page
// Lists all transactions with edit and delete capability.
// ============================================================

'use client';

import React, { Suspense } from 'react';
import { Header } from '@/components/layout/Header';
import { TransactionList } from '@/components/summary/TransactionList';

function TransactionsPageContent() {
  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <Header />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
        <section>
          <TransactionList />
        </section>
      </main>

      <footer className="border-t border-zinc-200 py-4 text-center text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-500">
        Expense Tracker &middot; Data stored locally in your browser
      </footer>
    </div>
  );
}

export default function TransactionsPage() {
  return (
    <Suspense fallback={null}>
      <TransactionsPageContent />
    </Suspense>
  );
}
