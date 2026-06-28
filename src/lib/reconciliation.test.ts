// ============================================================
// reconciliation.test.ts — Tests for calculateExpectedBalances
// ============================================================

import { calculateExpectedBalances } from './reconciliation';
import type { Transaction, Account } from '@/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACCOUNTS: Account[] = [
  { id: 'gotyme', name: 'GoTyme', startingBalance: 0 },
  { id: 'cash', name: 'Cash', startingBalance: 0 },
  { id: 'gcash', name: 'Gcash', startingBalance: 0 },
  { id: 'landbank', name: 'Landbank', startingBalance: 0 },
  { id: 'dragonfi', name: 'DragonFi', startingBalance: 0 },
];

function tx(
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('calculateExpectedBalances', () => {
  it('returns startingBalance for all accounts when there are no transactions', () => {
    const result = calculateExpectedBalances([], ACCOUNTS, '2026-06-28');
    expect(result).toHaveLength(ACCOUNTS.length);
    for (const row of result) {
      expect(row.expected).toBe(0);
    }
  });

  it('accounts with non-zero starting balance show that balance with no transactions', () => {
    const accts: Account[] = [
      { id: 'gotyme', name: 'GoTyme', startingBalance: 5000 },
      { id: 'cash', name: 'Cash', startingBalance: 0 },
    ];
    const result = calculateExpectedBalances([], accts, '2026-06-28');
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.accountId === 'gotyme')!.expected).toBe(5000);
    expect(result.find((r) => r.accountId === 'cash')!.expected).toBe(0);
  });

  it('single income to an account', () => {
    const txs: Transaction[] = [
      tx({ date: '2026-06-01', type: 'income', amount: 45000, toAccount: 'gotyme' }),
    ];
    const result = calculateExpectedBalances(txs, ACCOUNTS, '2026-06-28');
    expect(result.find((r) => r.accountId === 'gotyme')!.expected).toBe(45000);
    // Other accounts should be 0
    expect(result.find((r) => r.accountId === 'cash')!.expected).toBe(0);
  });

  it('expense from an account reduces its expected balance', () => {
    const txs: Transaction[] = [
      tx({ date: '2026-06-01', type: 'expense', amount: 500, fromAccount: 'cash' }),
    ];
    const result = calculateExpectedBalances(txs, ACCOUNTS, '2026-06-28');
    expect(result.find((r) => r.accountId === 'cash')!.expected).toBe(-500);
  });

  it('expense with toAccount credits the destination', () => {
    const txs: Transaction[] = [
      tx({
        date: '2026-06-01',
        type: 'expense',
        amount: 1500,
        fromAccount: 'gotyme',
        toAccount: 'dragonfi',
      }),
    ];
    const result = calculateExpectedBalances(txs, ACCOUNTS, '2026-06-28');
    expect(result.find((r) => r.accountId === 'gotyme')!.expected).toBe(-1500);
    expect(result.find((r) => r.accountId === 'dragonfi')!.expected).toBe(1500);
  });

  it('internal transfer debits source and credits destination', () => {
    const txs: Transaction[] = [
      tx({
        date: '2026-06-01',
        type: 'transaction',
        amount: 5000,
        fromAccount: 'gotyme',
        toAccount: 'landbank',
      }),
    ];
    const result = calculateExpectedBalances(txs, ACCOUNTS, '2026-06-28');
    expect(result.find((r) => r.accountId === 'gotyme')!.expected).toBe(-5000);
    expect(result.find((r) => r.accountId === 'landbank')!.expected).toBe(5000);
  });

  it('multiple transaction types compound correctly', () => {
    const txs: Transaction[] = [
      tx({ date: '2026-06-01', type: 'income', amount: 45000, toAccount: 'gotyme' }),
      tx({ date: '2026-06-02', type: 'expense', amount: 200, fromAccount: 'gcash' }),
      tx({
        date: '2026-06-05',
        type: 'expense',
        amount: 1500,
        fromAccount: 'gotyme',
        toAccount: 'dragonfi',
      }),
      tx({
        date: '2026-06-10',
        type: 'transaction',
        amount: 3000,
        fromAccount: 'gotyme',
        toAccount: 'landbank',
      }),
    ];
    const result = calculateExpectedBalances(txs, ACCOUNTS, '2026-06-28');

    // GoTyme: +45000 (income) -1500 (expense) -3000 (transfer) = 40500
    expect(result.find((r) => r.accountId === 'gotyme')!.expected).toBe(40500);
    // Gcash: -200
    expect(result.find((r) => r.accountId === 'gcash')!.expected).toBe(-200);
    // DragonFi: +1500 (expense to)
    expect(result.find((r) => r.accountId === 'dragonfi')!.expected).toBe(1500);
    // Landbank: +3000 (transfer to)
    expect(result.find((r) => r.accountId === 'landbank')!.expected).toBe(3000);
    // Cash: 0 (no transactions)
    expect(result.find((r) => r.accountId === 'cash')!.expected).toBe(0);
  });

  it('only includes transactions on or before asOfDate', () => {
    // Transactions that all happen after the asOfDate
    const txs: Transaction[] = [
      tx({ date: '2026-07-01', type: 'income', amount: 50000, toAccount: 'gotyme' }),
      tx({ date: '2026-07-05', type: 'expense', amount: 1000, fromAccount: 'cash' }),
    ];
    const result = calculateExpectedBalances(txs, ACCOUNTS, '2026-06-28');
    // All should be 0 — no transactions are on/before 2026-06-28
    for (const row of result) {
      expect(row.expected).toBe(0);
    }
  });

  it('includes transactions on the asOfDate itself', () => {
    const txs: Transaction[] = [
      tx({ date: '2026-06-28', type: 'income', amount: 10000, toAccount: 'gotyme' }),
    ];
    const result = calculateExpectedBalances(txs, ACCOUNTS, '2026-06-28');
    expect(result.find((r) => r.accountId === 'gotyme')!.expected).toBe(10000);
  });

  it('returns rows sorted by account name', () => {
    const result = calculateExpectedBalances([], ACCOUNTS, '2026-06-28');
    const names = result.map((r) => r.accountName);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('includes ALL accounts even if they have zero expected balance', () => {
    const result = calculateExpectedBalances([], ACCOUNTS, '2026-06-28');
    const ids = result.map((r) => r.accountId).sort();
    const expectedIds = ACCOUNTS.map((a) => a.id).sort();
    expect(ids).toEqual(expectedIds);
  });
});
