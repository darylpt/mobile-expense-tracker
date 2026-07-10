'use client';

import React from 'react';
import { useTransactionContext } from '@/context/TransactionContext';

/**
 * Dismissible error banner that reads from TransactionContext.
 * Renders nothing when there's no error — zero layout impact.
 */
export function GlobalErrorBanner() {
  const ctx = useTransactionContext();
  const [dismissed, setDismissed] = React.useState(false);

  // Reset dismissed state when error changes
  React.useEffect(() => {
    if (ctx.error) setDismissed(false);
  }, [ctx.error]);

  if (!ctx.error || dismissed) return null;

  return (
    <div
      role="alert"
      className="mx-auto mb-4 flex max-w-7xl items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
    >
      <svg className="mt-0.5 h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
      </svg>
      <span className="flex-1">{ctx.error}</span>
      <button
        onClick={() => setDismissed(true)}
        className="shrink-0 rounded p-0.5 text-red-500 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-900/30"
        aria-label="Dismiss error"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
