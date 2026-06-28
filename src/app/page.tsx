// ============================================================
// Main Application Page
// Displays the Quick Add form, Monthly Summary, and Transaction List
// ============================================================

'use client';

import React from 'react';
import { Header } from '@/components/layout/Header';
import { QuickAddForm } from '@/components/forms/QuickAddForm';
import { MonthlySummaryCard } from '@/components/summary/MonthlySummaryCard';
import { CategoryBreakdown } from '@/components/summary/CategoryBreakdown';
import { TransactionList } from '@/components/summary/TransactionList';

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <Header />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
        {/* Quick Add Form */}
        <section>
          <QuickAddForm />
        </section>

        {/* Summary / Dashboard — now includes accounts & breakdown tables */}
        <section>
          <MonthlySummaryCard />
        </section>

        {/* Category breakdown chart view (complements the summary tables) */}
        <section>
          <CategoryBreakdown />
        </section>

        {/* Transaction List */}
        <section>
          <TransactionList />
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-200 py-4 text-center text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-500">
        Expense Tracker &middot; Data stored locally in your browser
      </footer>
    </div>
  );
}
