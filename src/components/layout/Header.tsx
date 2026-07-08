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
import { getSyncQueueCount } from '@/lib/idb';
import { backgroundSync } from '@/lib/sync';

interface HeaderProps {
  /** Optional title override. Defaults to "Expense Tracker" */
  title?: string;
  /** Whether to show the bottom tab navigation. Default true. */
  showTabs?: boolean;
}

export function Header({ title = 'Expense Tracker', showTabs = true }: HeaderProps) {
  const router = useRouter();
  const { state, user, signOut } = useAuth();
  const pathname = usePathname();

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
            <>
              <span className="hidden text-xs text-zinc-400 dark:text-zinc-500 sm:inline" title={user?.email ?? ''}>
                {user?.email ?? ''}
              </span>
              <button
                onClick={handleSignOut}
                className="rounded-lg px-2.5 py-1 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              >
                Sign out
              </button>
            </>
          )}
        </div>
      </div>

      {showTabs && (
        <nav className="mx-auto flex max-w-4xl gap-1 overflow-x-auto px-4 pb-0 sm:px-6">
          <TabLink href="/" pathname={pathname}>Summary</TabLink>
          <TabLink href="/transactions" pathname={pathname}>Transactions</TabLink>
          {tabPrefs.showBalances && <TabLink href="/available-balance" pathname={pathname}>Balances</TabLink>}
          {tabPrefs.showPayout && <TabLink href="/payout" pathname={pathname}>Payout</TabLink>}
          <TabLink href="/settings" pathname={pathname}>Settings</TabLink>
        </nav>
      )}
    </header>
  );
}

// ============================================================
// Tab link sub-component
// ============================================================

function TabLink({ href, pathname, children }: { href: string; pathname: string; children: React.ReactNode }) {
  const p = pathname.replace(/\/+$/, '');
  const h = href.replace(/\/+$/, '') || '/';
  const isActive = h === '/' ? p === '/' : p === h || p.startsWith(h + '/');

  return (
    <Link
      href={href}
      className={`shrink-0 rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
        isActive
          ? 'bg-white text-blue-700 dark:bg-zinc-800 dark:text-blue-400'
          : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200'
      }`}
    >
      {children}
    </Link>
  );
}
