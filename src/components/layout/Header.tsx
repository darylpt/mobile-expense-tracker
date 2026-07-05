// ============================================================
// Header - Top navigation/app bar for the Expense Tracker
//
// Includes tab navigation between Summary (/), Balances
// (/available-balance), and Payout (/payout) using Next.js
// Link + usePathname.
// ============================================================

'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';

interface HeaderProps {
  /** Optional title override. Defaults to "Expense Tracker" */
  title?: string;
  /** Whether to show the bottom tab navigation. Default true. */
  showTabs?: boolean;
}

export function Header({ title = 'Expense Tracker', showTabs = true }: HeaderProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { state, signOut } = useAuth();

  const handleSignOut = async () => {
    await signOut();
    router.push('/login');
  };

  // ponytail: localStorage for tab preferences — simple, no schema, no IndexedDB migration
  // Listens for `storage` event so same-page toggles in Settings take effect immediately
  const [tabPrefs, setTabPrefs] = useState({ showBalances: true, showPayout: true });
  useEffect(() => {
    const read = () => {
      try {
        const stored = localStorage.getItem('tab_prefs');
        if (stored) setTabPrefs(JSON.parse(stored));
      } catch { /* ignore corrupt data */ }
    };
    read();
    window.addEventListener('storage', read);
    return () => window.removeEventListener('storage', read);
  }, []);

  return (
    <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur-md dark:border-zinc-700 dark:bg-zinc-900/80">
      <div className="mx-auto flex max-w-4xl items-center justify-between px-4 pt-3 sm:px-6">
        <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-50">
          {title}
        </h1>
        <div className="flex items-center gap-2">
          {/* App version / status indicator */}
          <span className="hidden rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400 sm:inline-block">
            PWA
          </span>
          {state === 'authenticated' && (
            <button
              onClick={handleSignOut}
              className="rounded-lg px-2.5 py-1 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              Sign out
            </button>
          )}
        </div>
      </div>

      {showTabs && (
        <nav className="mx-auto flex max-w-4xl gap-1 px-4 pb-0 sm:px-6">
          <TabLink href="/" active={pathname === '/'}>
            Summary
          </TabLink>
          <TabLink href="/transactions" active={pathname === '/transactions'}>
            Transactions
          </TabLink>
          {tabPrefs.showBalances && (
            <TabLink href="/available-balance" active={pathname === '/available-balance'}>
              Balances
            </TabLink>
          )}
          {tabPrefs.showPayout && (
            <TabLink href="/payout" active={pathname === '/payout'}>
              Payout
            </TabLink>
          )}
          <TabLink href="/settings" active={pathname === '/settings'}>
            Settings
          </TabLink>
        </nav>
      )}
    </header>
  );
}

// ============================================================
// Tab link sub-component
// ============================================================

function TabLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={`rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? 'bg-white text-blue-700 dark:bg-zinc-800 dark:text-blue-400'
          : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200'
      }`}
    >
      {children}
    </Link>
  );
}
