import React from 'react';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { User } from '@supabase/supabase-js';
import { AuthContext } from './AuthContext';
import { TransactionProvider, useTransactionContext } from './TransactionContext';
import { backgroundSync } from '@/lib/sync';
import type { Account, Category, Transaction } from '@/types';

let mockTransactions: Transaction[] = [];
let mockAccounts: Account[] = [];
let mockCategories: Category[] = [];

jest.mock('@/lib/sync', () => ({
  backgroundSync: jest.fn(async () => {}),
}));

jest.mock('@/lib/idb', () => ({
  getAllTransactions: jest.fn(async () => [...mockTransactions]),
  getAllAccounts: jest.fn(async () => [...mockAccounts]),
  getAllCategories: jest.fn(async () => [...mockCategories]),
  clearAllLocalData: jest.fn(async () => {}),
  addTransaction: jest.fn(),
  updateTransaction: jest.fn(),
  deleteTransaction: jest.fn(),
}));

const USER_ID = 'user-1';

const authValue = {
  state: 'authenticated',
  user: { id: USER_ID } as User,
  signIn: async () => ({}),
  signOut: async () => {},
  signInWithOAuth: async () => ({}),
  isLocked: false,
  hasLock: false,
  unlock: async () => true,
  setPin: async () => {},
  clearPin: () => {},
  verifyPin: async () => true,
} as React.ContextType<typeof AuthContext>;

const PULLED_TRANSACTION: Transaction = {
  id: 'pulled-transaction',
  amount: 25,
  date: '2026-02-01',
  type: 'expense',
  category: 'Food',
  fromAccount: null,
  toAccount: null,
  description: 'Remote',
  createdAt: 1,
  updatedAt: 1,
};

const PULLED_ACCOUNT: Account = {
  id: 'pulled-account',
  name: 'Remote Account',
  startingBalance: 0,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

const PULLED_CATEGORY: Category = {
  id: 'pulled-category',
  name: 'Remote Category',
  type: 'expense',
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

const mockBackgroundSync = backgroundSync as jest.Mock;

let visibilityState: DocumentVisibilityState = 'visible';

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <AuthContext.Provider value={authValue}>
      <TransactionProvider>{children}</TransactionProvider>
    </AuthContext.Provider>
  );
}

async function flush() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function renderProvider() {
  const view = renderHook(() => useTransactionContext(), { wrapper });
  await flush();
  return view;
}

beforeEach(() => {
  localStorage.clear();
  mockTransactions = [];
  mockAccounts = [];
  mockCategories = [];
  visibilityState = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState,
  });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  mockBackgroundSync.mockReset();
  mockBackgroundSync.mockImplementation(async () => {});
});

afterEach(cleanup);

it('resumes a visible, authenticated, online session with a sync that becomes visible', async () => {
  const { result } = await renderProvider();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  mockBackgroundSync.mockImplementation(async () => {
    mockTransactions = [PULLED_TRANSACTION];
    mockAccounts = [PULLED_ACCOUNT];
    mockCategories = [PULLED_CATEGORY];
    window.dispatchEvent(
      new CustomEvent('sync-complete', { detail: { userId: USER_ID } })
    );
  });

  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await flush();

  expect(result.current.transactions.map((tx) => tx.id)).toEqual(['pulled-transaction']);
  expect(result.current.accounts.map((account) => account.id)).toEqual(['pulled-account']);
  expect(result.current.categories.map((category) => category.id)).toEqual(['pulled-category']);
});

it('does not sync or display pulled records for a hidden document', async () => {
  const { result } = await renderProvider();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  visibilityState = 'hidden';
  mockBackgroundSync.mockImplementation(async () => {
    mockTransactions = [PULLED_TRANSACTION];
    mockAccounts = [PULLED_ACCOUNT];
    mockCategories = [PULLED_CATEGORY];
    window.dispatchEvent(
      new CustomEvent('sync-complete', { detail: { userId: USER_ID } })
    );
  });

  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await flush();

  expect(result.current.transactions).toHaveLength(0);
  expect(result.current.accounts).toHaveLength(0);
  expect(result.current.categories).toHaveLength(0);
});

it('syncs and displays pulled records on an online event while hidden', async () => {
  const { result } = await renderProvider();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  visibilityState = 'hidden';
  mockBackgroundSync.mockImplementation(async () => {
    mockTransactions = [PULLED_TRANSACTION];
    mockAccounts = [PULLED_ACCOUNT];
    mockCategories = [PULLED_CATEGORY];
    window.dispatchEvent(
      new CustomEvent('sync-complete', { detail: { userId: USER_ID } })
    );
  });

  act(() => {
    window.dispatchEvent(new Event('online'));
  });
  await flush();

  expect(result.current.transactions.map((tx) => tx.id)).toEqual(['pulled-transaction']);
  expect(result.current.accounts.map((account) => account.id)).toEqual(['pulled-account']);
  expect(result.current.categories.map((category) => category.id)).toEqual(['pulled-category']);
});

it('refreshes only for completion events from the authenticated user', async () => {
  const { result } = await renderProvider();
  mockTransactions = [PULLED_TRANSACTION];

  act(() => {
    window.dispatchEvent(new Event('sync-complete'));
    window.dispatchEvent(new CustomEvent('sync-complete', { detail: 'malformed' }));
    window.dispatchEvent(new CustomEvent('sync-complete', { detail: null }));
    window.dispatchEvent(
      new CustomEvent('sync-complete', { detail: { userId: 'someone-else' } })
    );
  });
  await flush();

  expect(result.current.transactions).toHaveLength(0);

  act(() => {
    window.dispatchEvent(
      new CustomEvent('sync-complete', { detail: { userId: USER_ID } })
    );
  });
  await flush();

  expect(result.current.transactions.map((tx) => tx.id)).toEqual(['pulled-transaction']);
});
