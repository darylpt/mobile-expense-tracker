// ============================================================
// TransactionContext.phase3a.test.tsx — auth scope / sign-out isolation
// ============================================================

import React from 'react';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import type { Transaction } from '@/types';
import {
  TransactionProvider,
  useTransactionContext,
  type TransactionContextValue,
} from './TransactionContext';
import { backgroundSync } from '@/lib/sync';
import { publishAuthIdentity } from '@/lib/auth-scope';
import {
  getAllTransactions,
  hasAnyLocalData,
  addTransaction as addTransactionToDB,
  updateTransaction as updateTransactionInDB,
  deleteTransaction as deleteTransactionFromDB,
} from '@/lib/idb';

const mockIdbModule = jest.requireMock('@/lib/idb') as { clearAllLocalData: jest.Mock };
const mockClearAllLocalData = mockIdbModule.clearAllLocalData;

let mockAuthState: {
  state: 'authenticated' | 'unauthenticated' | 'loading' | 'disabled';
  user: { id: string; email: string } | null;
  authGeneration: number;
} = {
  state: 'authenticated',
  user: { id: 'user-1', email: 'one@example.com' },
  authGeneration: 0,
};

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => mockAuthState,
}));

jest.mock('@/lib/sync', () => ({
  backgroundSync: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('@/lib/idb', () => ({
  getAllTransactions: jest.fn(() => Promise.resolve([])),
  getAllAccounts: jest.fn(() => Promise.resolve([])),
  getAllCategories: jest.fn(() => Promise.resolve([])),
  hasAnyLocalData: jest.fn(() => Promise.resolve(false)),
  clearAllLocalData: jest.fn(() => Promise.resolve()),
  addTransaction: jest.fn(),
  updateTransaction: jest.fn(),
  deleteTransaction: jest.fn(),
}));

const mockGetAllTransactions = getAllTransactions as jest.MockedFunction<typeof getAllTransactions>;
const mockBackgroundSync = backgroundSync as jest.MockedFunction<typeof backgroundSync>;
const mockHasAnyLocalData = hasAnyLocalData as jest.MockedFunction<typeof hasAnyLocalData>;
const mockAddTransaction = addTransactionToDB as jest.MockedFunction<typeof addTransactionToDB>;
const mockUpdateTransaction = updateTransactionInDB as jest.MockedFunction<typeof updateTransactionInDB>;
const mockDeleteTransaction = deleteTransactionFromDB as jest.MockedFunction<typeof deleteTransactionFromDB>;

// The real AuthProvider publishes the shared identity and then renders the
// generation it returned. Tests mirror that pairing so callback tokens can be
// validated against the generation the provider actually rendered.
function actAsUnauthenticated(): number {
  const authGeneration = publishAuthIdentity({ state: 'unauthenticated' });
  mockAuthState = { state: 'unauthenticated', user: null, authGeneration };
  return authGeneration;
}

function actAsLoading(): number {
  const authGeneration = publishAuthIdentity({ state: 'loading' });
  mockAuthState = { state: 'loading', user: null, authGeneration };
  return authGeneration;
}

function actAsAuthenticated(userId = 'user-1'): number {
  const authGeneration = publishAuthIdentity({ state: 'authenticated', userId });
  mockAuthState = {
    state: 'authenticated',
    user: { id: userId, email: `${userId}@example.com` },
    authGeneration,
  };
  return authGeneration;
}

function actAsDisabled(): number {
  const authGeneration = publishAuthIdentity({ state: 'disabled' });
  mockAuthState = { state: 'disabled', user: null, authGeneration };
  return authGeneration;
}

function Probe() {
  const { transactions, isLoading, error } = useTransactionContext();
  return (
    <div>
      <div data-testid="loading">{String(isLoading)}</div>
      <div data-testid="count">{transactions.length}</div>
      <div data-testid="error">{error ?? ''}</div>
    </div>
  );
}

async function renderProvider() {
  render(
    <TransactionProvider>
      <Probe />
    </TransactionProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
}

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
  // Start every test from a signed-out identity, as AuthProvider would after a
  // previous session ended. Tests that need a scope publish one explicitly.
  actAsUnauthenticated();
  mockAuthState = {
    state: 'authenticated',
    user: { id: 'user-1', email: 'one@example.com' },
    authGeneration: mockAuthState.authGeneration,
  };
  mockHasAnyLocalData.mockResolvedValue(false);
  mockBackgroundSync.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
});

test('loads data when the signed-in account matches the local owner', async () => {
  localStorage.setItem('lastUserId', 'user-1');
  actAsAuthenticated();
  await renderProvider();

  expect(mockGetAllTransactions).toHaveBeenCalled();
  expect(screen.getByTestId('count').textContent).toBe('0');
});

test('fails closed without loading or clearing data when another account owns the cache', async () => {
  localStorage.setItem('lastUserId', 'user-2');
  actAsAuthenticated();
  await renderProvider();

  expect(mockGetAllTransactions).not.toHaveBeenCalled();
  expect(mockBackgroundSync).not.toHaveBeenCalled();
  expect(mockClearAllLocalData).not.toHaveBeenCalled();
  expect(screen.getByTestId('count').textContent).toBe('0');
  expect(screen.getByTestId('error').textContent).toContain('different signed-in account');
  expect(localStorage.getItem('lastUserId')).toBe('user-2');
});

test('sign-out hides cached data without deleting it or removing the owner marker', async () => {
  localStorage.setItem('lastUserId', 'user-1');
  actAsUnauthenticated();
  await renderProvider();

  expect(mockGetAllTransactions).not.toHaveBeenCalled();
  expect(mockClearAllLocalData).not.toHaveBeenCalled();
  expect(screen.getByTestId('count').textContent).toBe('0');
  expect(localStorage.getItem('lastUserId')).toBe('user-1');
});

test('does not assign an unowned local cache to a newly signed-in account', async () => {
  mockHasAnyLocalData.mockResolvedValue(true);
  actAsAuthenticated();
  await renderProvider();

  expect(mockGetAllTransactions).not.toHaveBeenCalled();
  expect(mockBackgroundSync).not.toHaveBeenCalled();
  expect(screen.getByTestId('error').textContent).toContain('no verified account owner');
  expect(localStorage.getItem('lastUserId')).toBeNull();
});

function staleTransaction(): Transaction {
  return {
    id: 'tx-stale',
    amount: 9,
    date: '2026-11-05',
    type: 'expense',
    category: 'Food',
    fromAccount: null,
    toAccount: null,
    description: 'stale read',
    createdAt: 1,
    updatedAt: 1,
  };
}

function mountTree() {
  return (
    <TransactionProvider>
      <Probe />
    </TransactionProvider>
  );
}

test('a read from the previous generation cannot repopulate after same-user re-login', async () => {
  localStorage.setItem('lastUserId', 'user-1');
  actAsAuthenticated();
  const staleRead = Promise.withResolvers<Transaction[]>();
  mockGetAllTransactions.mockReturnValueOnce(staleRead.promise);

  const view = render(mountTree());
  await waitFor(() => expect(mockGetAllTransactions).toHaveBeenCalledTimes(1));

  // A → signed out → A. The local owner marker never changes, so only the
  // identity generation can distinguish the old read from the new one.
  actAsUnauthenticated();
  view.rerender(mountTree());
  actAsAuthenticated();
  view.rerender(mountTree());

  await waitFor(() => expect(mockGetAllTransactions).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
  expect(screen.getByTestId('count').textContent).toBe('0');

  await act(async () => {
    staleRead.resolve([staleTransaction()]);
  });

  expect(screen.getByTestId('count').textContent).toBe('0');
  expect(screen.getByTestId('error').textContent).toBe('');
});

test('a read error from the previous generation cannot publish a stale error', async () => {
  localStorage.setItem('lastUserId', 'user-1');
  actAsAuthenticated();
  const staleRead = Promise.withResolvers<Transaction[]>();
  mockGetAllTransactions.mockReturnValueOnce(staleRead.promise);

  const view = render(mountTree());
  await waitFor(() => expect(mockGetAllTransactions).toHaveBeenCalledTimes(1));

  actAsUnauthenticated();
  view.rerender(mountTree());
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));

  await act(async () => {
    staleRead.reject(new Error('stale read failed'));
  });

  expect(screen.getByTestId('error').textContent).toBe('');
  expect(screen.getByTestId('count').textContent).toBe('0');
});

test('a stale read cannot publish loading after the auth state returns to loading', async () => {
  localStorage.setItem('lastUserId', 'user-1');
  actAsAuthenticated();
  const staleRead = Promise.withResolvers<Transaction[]>();
  mockGetAllTransactions.mockReturnValueOnce(staleRead.promise);

  const view = render(mountTree());
  await waitFor(() => expect(mockGetAllTransactions).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId('loading').textContent).toBe('true');

  actAsLoading();
  view.rerender(mountTree());

  await act(async () => {
    staleRead.resolve([]);
  });

  // The old read's finally block must not end the newer auth-loading state.
  expect(screen.getByTestId('loading').textContent).toBe('true');
  expect(screen.getByTestId('count').textContent).toBe('0');
});

test('a lifecycle refresh is ignored when its sync finishes after a transition', async () => {
  localStorage.setItem('lastUserId', 'user-1');
  actAsAuthenticated();

  const view = render(mountTree());
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
  await act(async () => {});

  mockGetAllTransactions.mockClear();
  mockBackgroundSync.mockClear();
  const syncResult = Promise.withResolvers<boolean>();
  mockBackgroundSync.mockReturnValueOnce(syncResult.promise);

  act(() => {
    window.dispatchEvent(new Event('online'));
  });
  await waitFor(() => expect(mockBackgroundSync).toHaveBeenCalledTimes(1));

  actAsUnauthenticated();
  view.rerender(mountTree());

  await act(async () => {
    syncResult.resolve(true);
  });
  await act(async () => {});

  // The stale cycle's completion must not trigger a refresh for the old scope.
  expect(mockGetAllTransactions).not.toHaveBeenCalled();
});

test('disabled local-only mode still publishes freshly read local data', async () => {
  actAsDisabled();
  mockGetAllTransactions.mockResolvedValueOnce([staleTransaction()]);

  await renderProvider();

  expect(mockGetAllTransactions).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('count').textContent).toBe('1');
  expect(screen.getByTestId('error').textContent).toBe('');
});

// ============================================================
// Callback fencing: signed-out, unverified, and stale callers
// ============================================================

type ContextSnapshot = TransactionContextValue;

function ContextSink({ sinkRef }: { sinkRef: { current: ContextSnapshot | null } }) {
  const snapshot = useTransactionContext();

  // Publish after commit: tests read the snapshot once the rendered tree has
  // settled, so the ref must never be written during render.
  React.useEffect(() => {
    sinkRef.current = snapshot;
  }, [sinkRef, snapshot]);

  return null;
}

function mountTreeWithSink(sinkRef: { current: ContextSnapshot | null }) {
  return (
    <TransactionProvider>
      <Probe />
      <ContextSink sinkRef={sinkRef} />
    </TransactionProvider>
  );
}

function draftTransaction(): Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    amount: 9,
    date: '2026-11-05',
    type: 'expense',
    category: 'Food',
    fromAccount: null,
    toAccount: null,
    description: 'stale mutation',
  };
}

test('a signed-out refresh callback cannot read private IndexedDB rows', async () => {
  localStorage.setItem('lastUserId', 'user-1');
  actAsUnauthenticated();
  const sink: { current: ContextSnapshot | null } = { current: null };

  render(mountTreeWithSink(sink));
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
  expect(mockGetAllTransactions).not.toHaveBeenCalled();

  await act(async () => {
    await sink.current!.refreshTransactions();
  });

  expect(mockGetAllTransactions).not.toHaveBeenCalled();
  expect(screen.getByTestId('count').textContent).toBe('0');
});

test.each([
  ['missing', null],
  ['mismatched', 'user-2'],
] as const)(
  'an authenticated user with a %s owner marker cannot refresh private IndexedDB rows',
  async (_label, marker) => {
    if (marker) {
      localStorage.setItem('lastUserId', marker);
    } else {
      // A legacy local cache exists but cannot be assigned to this account.
      mockHasAnyLocalData.mockResolvedValue(true);
    }
    actAsAuthenticated();
    const sink: { current: ContextSnapshot | null } = { current: null };

    render(mountTreeWithSink(sink));
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(mockGetAllTransactions).not.toHaveBeenCalled();
    expect(localStorage.getItem('lastUserId')).toBe(marker);

    await act(async () => {
      await sink.current!.refreshTransactions();
    });

    expect(mockGetAllTransactions).not.toHaveBeenCalled();
    expect(screen.getByTestId('count').textContent).toBe('0');
  },
);

test('a refresh callback captured for a previous same-user login cannot recapture the fresh generation', async () => {
  localStorage.setItem('lastUserId', 'user-1');
  actAsAuthenticated();
  const sink: { current: ContextSnapshot | null } = { current: null };

  const view = render(mountTreeWithSink(sink));
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
  const staleRefresh = sink.current!.refreshTransactions;

  // A → signed out.
  actAsUnauthenticated();
  view.rerender(mountTreeWithSink(sink));
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));

  // Signed out → A again. The owner marker never changed, so only the
  // generation distinguishes the old callback from the fresh session.
  actAsAuthenticated();
  view.rerender(mountTreeWithSink(sink));
  await waitFor(() => expect(mockGetAllTransactions).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));

  mockGetAllTransactions.mockClear();
  await act(async () => {
    await staleRefresh();
  });

  expect(mockGetAllTransactions).not.toHaveBeenCalled();
  expect(screen.getByTestId('count').textContent).toBe('0');
});

test('stale mutation callbacks cannot mutate private data or publish state after a transition', async () => {
  localStorage.setItem('lastUserId', 'user-1');
  actAsAuthenticated();
  const sink: { current: ContextSnapshot | null } = { current: null };

  const view = render(mountTreeWithSink(sink));
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
  const stale = sink.current!;

  actAsUnauthenticated();
  view.rerender(mountTreeWithSink(sink));
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));

  mockAddTransaction.mockClear();
  mockUpdateTransaction.mockClear();
  mockDeleteTransaction.mockClear();

  await act(async () => {
    await expect(stale.addTransaction(draftTransaction())).rejects.toThrow();
    await expect(stale.updateTransaction(staleTransaction())).rejects.toThrow();
    await expect(stale.deleteTransaction('tx-stale')).rejects.toThrow();
  });

  expect(mockAddTransaction).not.toHaveBeenCalled();
  expect(mockUpdateTransaction).not.toHaveBeenCalled();
  expect(mockDeleteTransaction).not.toHaveBeenCalled();
  expect(screen.getByTestId('count').textContent).toBe('0');
  expect(screen.getByTestId('error').textContent).toBe('');
});

test('a mutation started under a valid scope cannot publish after the generation changes', async () => {
  localStorage.setItem('lastUserId', 'user-1');
  actAsAuthenticated();
  const sink: { current: ContextSnapshot | null } = { current: null };

  const view = render(mountTreeWithSink(sink));
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
  const addTransaction = sink.current!.addTransaction;

  const pending = Promise.withResolvers<string>();
  mockAddTransaction.mockReturnValueOnce(pending.promise);
  let mutation!: Promise<string>;
  act(() => {
    mutation = addTransaction(draftTransaction());
  });
  await waitFor(() => expect(mockAddTransaction).toHaveBeenCalledTimes(1));

  actAsUnauthenticated();
  view.rerender(mountTreeWithSink(sink));
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));

  await act(async () => {
    pending.resolve('tx-in-flight');
    await mutation;
  });

  expect(screen.getByTestId('count').textContent).toBe('0');
  expect(screen.getByTestId('error').textContent).toBe('');
});
