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

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <Header />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 pb-20 pt-6 sm:px-6 sm:pb-0 sm:pt-8">
        {/* Quick Add Form */}
        <section>
          <QuickAddForm />
        </section>

        {/* Summary / Dashboard — now includes accounts & breakdown tables */}
        <section>
          <MonthlySummaryCard />
        </section>

        {/* Category breakdown — mobile only (desktop uses tables in MonthlySummaryCard) */}
        <section className="md:hidden">
          <CategoryBreakdown />
        </section>


      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-200 py-4 text-center text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-500">
        Expense Tracker &middot; Local-first sync &middot; Data stored locally &amp; synced when online
      </footer>
    </div>
  );
}
