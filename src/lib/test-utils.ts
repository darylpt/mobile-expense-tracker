// ============================================================
// test-utils.ts — Shared test fixtures for unit tests
// ============================================================

import type { Transaction } from '@/types';

/**
 * Build a transaction quickly without repeating defaults.
 * Used by aggregation and reconciliation tests.
 */
export function tx(
  overrides: Partial<Transaction> & { date: string; type: Transaction['type']; amount: number }
): Transaction {
  return {
    id: `tx-${Math.random().toString(36).slice(2, 8)}`,
    category: 'Other',
    fromAccount: null,
    toAccount: null,
    description: '',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}
