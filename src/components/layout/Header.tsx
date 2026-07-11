// ============================================================
// Header - Top navigation/app bar for the Expense Tracker
//
// Includes tab navigation between Summary (/), Balances
// (/available-balance), and Payout (/payout) using Next.js
// Link + usePathname.
// ============================================================

'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { getSyncQueueCount } from '@/lib/idb';
import { backgroundSync } from '@/lib/sync';
import { APP_VERSION } from '@/lib/version';

interface HeaderProps {
  /** Optional title override. Defaults to "Expense Tracker" */
  title?: string;
  /** Whether to show the bottom tab navigation. Default true. */
  showTabs?: boolean;
}

// ── Inline SVG icon components (Heroicons-style) ──────────

function HomeIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
    </svg>
  );
}

function ListIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function WalletIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" />
    </svg>
  );
}

function CashIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function CogIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
    </svg>
  );
}

function ArrowRightOnRectangleIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
    </svg>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
    </svg>
  );
}

interface TabDef {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  core?: boolean;
}

const tabs: TabDef[] = [
  { href: '/', label: 'Summary', icon: HomeIcon, core: true },
  { href: '/transactions', label: 'Transactions', icon: ListIcon, core: true },
  { href: '/available-balance', label: 'Balances', icon: WalletIcon },
  { href: '/payout', label: 'Payout', icon: CashIcon },
  { href: '/settings', label: 'Settings', icon: CogIcon, core: true },
];

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

  // ── Sync status ──────────────────────────────────────────
  const [lastSync, setLastSync] = useState<number | null>(() => {
    try { const ts = localStorage.getItem('last_sync_time'); return ts ? parseInt(ts, 10) : null; } catch { return null; }
  });
  const [isSyncing, setIsSyncing] = useState(false);
  const syncTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    // Refresh the relative-time display every 30s
    syncTimer.current = setInterval(() => {
      const ts = localStorage.getItem('last_sync_time');
      if (ts) setLastSync(parseInt(ts, 10));
    }, 30000);
    // Listen for sync-time updates from other tabs
    const handler = (e: StorageEvent) => {
      if (e.key === 'last_sync_time' && e.newValue) setLastSync(parseInt(e.newValue, 10));
    };
    window.addEventListener('storage', handler);
    return () => {
      clearInterval(syncTimer.current);
      window.removeEventListener('storage', handler);
    };
  }, []);

  const handleSync = useCallback(async () => {
    setIsSyncing(true);
    try {
      await backgroundSync();
    } catch { /* handled in sync.ts */ }
    const ts = localStorage.getItem('last_sync_time');
    if (ts) setLastSync(parseInt(ts, 10));
    setIsSyncing(false);
  }, []);

  const visibleTabs = tabs.filter(t =>
    t.core ||
    (t.href === '/available-balance' && tabPrefs.showBalances) ||
    (t.href === '/payout' && tabPrefs.showPayout)
  );

  return (
    <>
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur-md dark:border-zinc-700 dark:bg-zinc-900/80">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 pt-3 sm:px-6">
          <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-50">
            {title}
            <span className="ml-2 inline-block rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500">
              v{APP_VERSION}
            </span>
          </h1>
          <div className="flex items-center gap-2">
            {/* PWA badge — desktop only */}
            <span className="hidden rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400 md:inline-block">
              PWA
            </span>
            {/* Sync status — desktop only */}
            {state === 'authenticated' && (
              <span className="hidden items-center gap-1 text-xs text-zinc-400 dark:text-zinc-500 md:inline-flex">
                {lastSync ? timeAgo(lastSync) : 'never'}
              </span>
            )}
            {state === 'authenticated' && (
              <>
                {/* Desktop: sync button */}
                <button
                  onClick={handleSync}
                  disabled={isSyncing}
                  className="hidden rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 md:inline-block"
                  aria-label="Sync now"
                >
                  <RefreshIcon className={`h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`} />
                </button>
                <span className="hidden text-xs text-zinc-400 dark:text-zinc-500 md:inline" title={user?.email ?? ''}>
                  {user?.email ?? ''}
                </span>
                {/* Desktop: text sign-out button */}
                <button
                  onClick={handleSignOut}
                  className="hidden rounded-lg px-2.5 py-1 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 md:inline-block"
                >
                  Sign out
                </button>
                {/* Mobile: sync status + button */}
                <span className="truncate text-[10px] text-zinc-400 dark:text-zinc-500 md:hidden">
                  {lastSync ? timeAgo(lastSync) : 'never'}
                </span>
                <button
                  onClick={handleSync}
                  disabled={isSyncing}
                  className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 md:hidden"
                  aria-label="Sync now"
                >
                  <RefreshIcon className={`h-5 w-5 ${isSyncing ? 'animate-spin' : ''}`} />
                </button>
                {/* Mobile: icon sign-out button */}
                <button
                  onClick={handleSignOut}
                  className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 md:hidden"
                  aria-label="Sign out"
                >
                  <ArrowRightOnRectangleIcon className="h-5 w-5" />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Desktop tab navigation — hidden on mobile */}
        {showTabs && (
          <nav className="mx-auto hidden max-w-4xl gap-1 overflow-x-auto px-4 pb-0 sm:px-6 md:flex">
            {visibleTabs.map((tab) => (
              <TabLink key={tab.href} href={tab.href} pathname={pathname}>{tab.label}</TabLink>
            ))}
          </nav>
        )}
      </header>

      {/* Mobile bottom tab bar */}
      {showTabs && <MobileBottomNav tabs={visibleTabs} pathname={pathname} />}
    </>
  );
}

// ============================================================
// Tab link sub-component
// ============================================================

function TabLink({ href, pathname, children }: { href: string; pathname: string; children: React.ReactNode }) {
  const p = pathname === '/' ? '/' : pathname.replace(/\/+$/, '');
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

// ============================================================
// Helpers
// ============================================================

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

// ============================================================
// Mobile bottom tab bar
// ============================================================

function MobileBottomNav({ tabs, pathname }: { tabs: TabDef[]; pathname: string }) {
  const router = useRouter();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-20 border-t border-zinc-200 bg-white/95 backdrop-blur-md dark:border-zinc-700 dark:bg-zinc-900/95 md:hidden"
         style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
      <div className="mx-auto flex max-w-lg items-center justify-around">
        {tabs.map((tab) => {
          const p = pathname === '/' ? '/' : pathname.replace(/\/+$/, '');
          const h = tab.href.replace(/\/+$/, '') || '/';
          const isActive = h === '/' ? p === '/' : p === h || p.startsWith(h + '/');

          return (
            <button
              key={tab.href}
              onClick={() => router.push(tab.href)}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors ${
                isActive
                  ? 'text-blue-600 dark:text-blue-400'
                  : 'text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300'
              }`}
            >
              <tab.icon className={`h-6 w-6 ${isActive ? 'stroke-[2.5]' : 'stroke-2'}`} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
