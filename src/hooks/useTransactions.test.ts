// ============================================================
// useTransactions.test.ts — Tests for the useTransactions hook
// ============================================================

import { renderHook, act } from '@testing-library/react';
import { useTransactions } from './useTransactions';
import { TransactionProvider } from '@/context/TransactionContext';
import type { Transaction } from '@/types';
import React from 'react';

// ---------------------------------------------------------------------------
// Mock the idb module
// ---------------------------------------------------------------------------
// We use `var` (not let/const) so the variable declaration is hoisted before
// the jest.mock factory runs. The closures capture the variable *reference*,
// so by the time they execute, mockStore has been initialised to [].
// eslint-disable-next-line no-var
var mockStore: Transaction[] = [];

jest.mock('@/lib/idb', () => ({
  getAllTransactions: jest.fn(() => Promise.resolve([...mockStore])),
  getAllAccounts: jest.fn(() => Promise.resolve([])),
  addTransaction: jest.fn(
    async (
      tx: Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>
    ): Promise<string> => {
      const id = `mock-id-${mockStore.length}`;
      const now = Date.now();
      const newTx: Transaction = { ...tx, id, createdAt: now, updatedAt: now };
      mockStore.push(newTx);
      return id;
    }
  ),
  deleteTransaction: jest.fn(async (id: string): Promise<void> => {
    mockStore = mockStore.filter((t) => t.id !== id);
  }),
  updateTransaction: jest.fn(async (): Promise<void> => {}),
  seedTransactionsIfEmpty: jest.fn(async (): Promise<void> => {}),
}));

// ---------------------------------------------------------------------------
// Test wrapper — provides the TransactionContext needed by useTransactions
// ---------------------------------------------------------------------------

function Wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(TransactionProvider, null, children);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Reset the mock store before each test so state is fully isolated
  mockStore = [];
});

describe('useTransactions', () => {
  it('should add a transaction and include it in the transactions array', async () => {
    const { result } = renderHook(() => useTransactions(), { wrapper: Wrapper });

    // Wait for the initial fetch (refreshTransactions) to complete
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const newTransaction = {
      description: 'Groceries',
      amount: 50,
      type: 'expense' as const,
      date: '2026-06-26',
      category: 'Food',
      fromAccount: 'gcash',
      toAccount: null,
    };

    await act(async () => {
      await result.current.addTransaction(newTransaction);
    });

    expect(result.current.transactions).toHaveLength(1);
    expect(result.current.transactions[0]).toMatchObject({
      description: 'Groceries',
      amount: 50,
      type: 'expense',
      date: '2026-06-26',
      category: 'Food',
      fromAccount: 'gcash',
      toAccount: null,
    });
    expect(result.current.transactions[0].id).toBeDefined();
  });

  it('should delete a transaction and remove it from the transactions array', async () => {
    const { result } = renderHook(() => useTransactions(), { wrapper: Wrapper });

    // Wait for the initial fetch (refreshTransactions) to complete
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Add a transaction first
    const newTransaction = {
      description: 'Groceries',
      amount: 50,
      type: 'expense' as const,
      date: '2026-06-26',
      category: 'Food',
      fromAccount: 'gcash',
      toAccount: null,
    };

    await act(async () => {
      await result.current.addTransaction(newTransaction);
    });

    expect(result.current.transactions).toHaveLength(1);

    const transactionId = result.current.transactions[0].id;

    // Delete the transaction
    await act(async () => {
      await result.current.deleteTransaction(transactionId);
    });

    expect(result.current.transactions).toHaveLength(0);
  });
});
