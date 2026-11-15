import React from 'react';
import { render, screen, act, cleanup, waitFor } from '@testing-library/react';
import type { Account, Category, Transaction } from '@/types';
import { TransactionProvider, useTransactionContext } from './TransactionContext';
import { backgroundSync } from '@/lib/sync';
import { getAllTransactions } from '@/lib/idb';
import { publishAuthIdentity } from '@/lib/auth-scope';

let mockTransactions: Transaction[];
let mockAccounts: Account[];
let mockCategories: Category[];

const mockUser = { id: 'test-user', email: 'test@example.com' };

const mockAuthState = {
  state: 'authenticated' as const,
  user: mockUser,
  authGeneration: 0,
};

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => mockAuthState,
}));

jest.mock('@/lib/sync', () => ({
  backgroundSync: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/lib/idb', () => ({
  getAllTransactions: jest.fn(() => Promise.resolve(mockTransactions)),
  getAllAccounts: jest.fn(() => Promise.resolve(mockAccounts)),
  getAllCategories: jest.fn(() => Promise.resolve(mockCategories)),
  addTransaction: jest.fn(),
  updateTransaction: jest.fn(),
  deleteTransaction: jest.fn(),
  clearAllLocalData: jest.fn(() => Promise.resolve()),
  hasAnyLocalData: jest.fn(() => Promise.resolve(false)),
}));

const mockBackgroundSync = backgroundSync as jest.MockedFunction<typeof backgroundSync>;
const mockGetAllTransactions = getAllTransactions as jest.MockedFunction<typeof getAllTransactions>;

function localTransaction(): Transaction {
  return {
    id: 'tx-local',
    amount: 25,
    date: '2026-11-01',
    type: 'expense',
    category: 'Food',
    fromAccount: null,
    toAccount: 'acct-checking',
    description: 'Local only',
    createdAt: 1,
    updatedAt: 1,
  };
}

function remoteTransaction(): Transaction {
  return {
    id: 'tx-remote',
    amount: 40,
    date: '2026-11-02',
    type: 'expense',
    category: 'Food',
    fromAccount: null,
    toAccount: 'acct-checking',
    description: 'Remote change',
    createdAt: 2,
    updatedAt: 2,
  };
}

function localAccount(): Account {
  return {
    id: 'acct-checking',
    name: 'Checking',
    startingBalance: 100,
    createdAt: 1,
    updatedAt: 1,
  };
}

function remoteAccount(): Account {
  return {
    id: 'acct-savings',
    name: 'Savings',
    startingBalance: 0,
    createdAt: 2,
    updatedAt: 2,
  };
}

function localCategory(): Category {
  return {
    id: 'cat-food',
    name: 'Food',
    type: 'expense',
    createdAt: 1,
    updatedAt: 1,
  };
}

function remoteCategory(): Category {
  return {
    id: 'cat-salary',
    name: 'Salary',
    type: 'income',
    createdAt: 2,
    updatedAt: 2,
  };
}

function Probe() {
  const { transactions, accounts, categories, isLoading, error } = useTransactionContext();
  return (
    <div>
      <div data-testid="loading">{String(isLoading)}</div>
      <div data-testid="transactions">{transactions.map((tx) => tx.description ?? tx.id).join(',')}</div>
      <div data-testid="accounts">{accounts.map((account) => account.name).join(',')}</div>
      <div data-testid="categories">{categories.map((category) => category.name).join(',')}</div>
      <div data-testid="error">{error ?? ''}</div>
    </div>
  );
}

function setVisibility(visibilityState: DocumentVisibilityState, hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState,
  });
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
}

async function renderLoadedProvider() {
  render(
    <TransactionProvider>
      <Probe />
    </TransactionProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
  await act(async () => {});
}

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
  // Mirror AuthProvider: publish the account identity (with its shared
  // generation) and claim the local cache before the provider renders.
  localStorage.setItem('lastUserId', 'test-user');
  mockAuthState.authGeneration = publishAuthIdentity({
    state: 'authenticated',
    userId: 'test-user',
  });
  mockTransactions = [localTransaction()];
  mockAccounts = [localAccount()];
  mockCategories = [localCategory()];
  setVisibility('visible', false);
});

afterEach(() => {
  cleanup();
  setVisibility('visible', false);
});

test('foreground visibility requests a background sync', async () => {
  await renderLoadedProvider();
  mockBackgroundSync.mockClear();

  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await waitFor(() => expect(mockBackgroundSync).toHaveBeenCalledTimes(1));
  await act(async () => {});
});

test('sync-complete reloads transactions, accounts, and categories from IndexedDB', async () => {
  await renderLoadedProvider();
  expect(screen.getByTestId('transactions').textContent).toBe('Local only');
  expect(screen.getByTestId('accounts').textContent).toBe('Checking');
  expect(screen.getByTestId('categories').textContent).toBe('Food');

  mockTransactions = [localTransaction(), remoteTransaction()];
  mockAccounts = [localAccount(), remoteAccount()];
  mockCategories = [localCategory(), remoteCategory()];

  act(() => {
    window.dispatchEvent(new Event('sync-complete'));
  });

  await waitFor(() => {
    expect(screen.getByTestId('transactions').textContent).toContain('Remote change');
  });
  expect(screen.getByTestId('accounts').textContent).toContain('Savings');
  expect(screen.getByTestId('categories').textContent).toContain('Salary');
});

test('visibilitychange while hidden does not request a background sync', async () => {
  await renderLoadedProvider();
  mockBackgroundSync.mockClear();
  setVisibility('hidden', true);

  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await act(async () => {});

  expect(mockBackgroundSync).not.toHaveBeenCalled();
});

test('local data loads before an in-flight startup background sync completes', async () => {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => true,
  });

  let syncSettled = false;
  const { promise: syncGate, resolve: resolveSync } = Promise.withResolvers<void>();
  mockBackgroundSync.mockImplementation(() =>
    syncGate.then(() => {
      syncSettled = true;
    }),
  );

  const { unmount } = render(
    <TransactionProvider>
      <Probe />
    </TransactionProvider>,
  );

  try {
    // The provider has verified the cached owner and started the network
    // sync, but the sync is deliberately withheld so it cannot supply data.
    await act(async () => {});
    expect(mockBackgroundSync).toHaveBeenCalledTimes(1);

    await act(async () => {});

    expect(syncSettled).toBe(false);
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('transactions').textContent).toBe('Local only');
    expect(screen.getByTestId('accounts').textContent).toBe('Checking');
    expect(screen.getByTestId('categories').textContent).toBe('Food');
  } finally {
    await act(async () => {
      resolveSync();
    });
    unmount();
  }
});

test('a foreground event during the initial local read waits for that read before syncing', async () => {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => true,
  });
  setVisibility('visible', false);
  mockBackgroundSync.mockImplementation(() => Promise.resolve());

  const initialRead = Promise.withResolvers<Transaction[]>();
  mockGetAllTransactions.mockImplementation(() => Promise.resolve(mockTransactions));
  mockGetAllTransactions.mockImplementationOnce(() => initialRead.promise);

  const { unmount } = render(
    <TransactionProvider>
      <Probe />
    </TransactionProvider>,
  );

  try {
    // The cache owner is verified and the online/foreground lifecycle effect
    // has registered, but the local read that startup must finish first is
    // still in flight.
    await act(async () => {});
    expect(mockGetAllTransactions).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('loading').textContent).toBe('true');

    // A foreground event must not start a network sync while the local read
    // startup depends on is unresolved.
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {});

    expect(mockBackgroundSync).not.toHaveBeenCalled();

    // Once the local read lands, startup performs its single reconciliation.
    await act(async () => {
      initialRead.resolve([localTransaction()]);
    });
    await waitFor(() => expect(mockBackgroundSync).toHaveBeenCalledTimes(1));
    await act(async () => {});
  } finally {
    await act(async () => {
      initialRead.resolve([localTransaction()]);
    });
    unmount();
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => true,
    });
  }
});

test('a settled false startup sync still refreshes local state', async () => {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => true,
  });

  const { promise: syncGate, resolve: resolveSync } = Promise.withResolvers<void>();
  mockBackgroundSync.mockImplementation(() => syncGate);

  const { unmount } = render(
    <TransactionProvider>
      <Probe />
    </TransactionProvider>,
  );

  try {
    // The initial local read has finished and the withheld network sync has
    // started, so `false` distinguishes this from a completed initial read.
    await waitFor(() => expect(mockBackgroundSync).toHaveBeenCalledTimes(1));
    expect(mockGetAllTransactions).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('transactions').textContent).toBe('Local only');

    // Rows land in IndexedDB while the sync is held.
    mockTransactions = [localTransaction(), remoteTransaction()];
    mockAccounts = [localAccount(), remoteAccount()];
    mockCategories = [localCategory(), remoteCategory()];

    // A settled `false` is not a completed startup read, but the same startup
    // identity still refreshes local state from IndexedDB.
    await act(async () => {
      resolveSync();
    });

    expect(mockGetAllTransactions).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('transactions').textContent).toBe('Local only,Remote change');
    expect(screen.getByTestId('accounts').textContent).toBe('Checking,Savings');
    expect(screen.getByTestId('categories').textContent).toBe('Food,Salary');
    expect(screen.getByTestId('loading').textContent).toBe('false');
  } finally {
    await act(async () => {
      resolveSync();
    });
    unmount();
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => true,
    });
  }
});

test('an equivalent auth user object does not restart startup initialization', async () => {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => true,
  });

  const { promise: syncGate, resolve: resolveSync } = Promise.withResolvers<void>();
  mockBackgroundSync.mockImplementation(() => syncGate);

  const { rerender, unmount } = render(
    <TransactionProvider>
      <Probe />
    </TransactionProvider>,
  );

  try {
    // Startup has loaded the local cache and requested the withheld network
    // sync exactly once.
    await act(async () => {});
    expect(mockBackgroundSync).toHaveBeenCalledTimes(1);
    expect(mockGetAllTransactions).toHaveBeenCalledTimes(1);

    // Auth republishes the same account with a fresh user object; the state
    // name, user id, and generation are unchanged.
    mockAuthState.user = { id: mockUser.id, email: mockUser.email };

    rerender(
      <TransactionProvider>
        <Probe />
      </TransactionProvider>,
    );

    await act(async () => {});

    // Identity is the account id, not the user object identity: startup must
    // not sync or reload the local cache a second time.
    expect(mockBackgroundSync).toHaveBeenCalledTimes(1);
    expect(mockGetAllTransactions).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('transactions').textContent).toBe('Local only');
  } finally {
    mockAuthState.user = mockUser;
    await act(async () => {
      resolveSync();
    });
    unmount();
  }
});

test('an older overlapping read cannot publish while a newer read is pending', async () => {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => false,
  });

  const olderRead = Promise.withResolvers<Transaction[]>();
  const newerRead = Promise.withResolvers<Transaction[]>();
  const olderRows = [{ ...localTransaction(), description: 'Older read' }];

  try {
    // The initial local read has settled, so the lifecycle gate is open and
    // loading is already false while later refreshes are in flight.
    await renderLoadedProvider();
    expect(screen.getByTestId('transactions').textContent).toBe('Local only');

    mockGetAllTransactions.mockClear();
    mockGetAllTransactions
      .mockImplementationOnce(() => olderRead.promise)
      .mockImplementationOnce(() => newerRead.promise);

    // Two completed syncs start overlapping same-generation reads: A is the
    // older read, B the newest one.
    act(() => {
      window.dispatchEvent(new Event('sync-complete'));
      window.dispatchEvent(new Event('sync-complete'));
    });
    await act(async () => {});
    expect(mockGetAllTransactions).toHaveBeenCalledTimes(2);

    // A settles first but is no longer the latest read, so it must not
    // publish its rows while B is still pending.
    await act(async () => {
      olderRead.resolve(olderRows);
    });
    expect(screen.getByTestId('transactions').textContent).toBe('Local only');
    expect(screen.getByTestId('loading').textContent).toBe('false');

    // B is the latest read and publishes its rows when it settles.
    await act(async () => {
      newerRead.resolve([remoteTransaction()]);
    });
    expect(screen.getByTestId('transactions').textContent).toBe('Remote change');
  } finally {
    await act(async () => {
      olderRead.resolve(olderRows);
      newerRead.resolve([remoteTransaction()]);
    });
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => true,
    });
  }
});

test('a late older read does not overwrite a newer read that already applied', async () => {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => false,
  });

  const olderRead = Promise.withResolvers<Transaction[]>();
  const newerRead = Promise.withResolvers<Transaction[]>();

  try {
    // The initial local read has settled before the overlapping refreshes.
    await renderLoadedProvider();
    expect(screen.getByTestId('transactions').textContent).toBe('Local only');

    mockGetAllTransactions.mockClear();
    mockGetAllTransactions
      .mockImplementationOnce(() => olderRead.promise)
      .mockImplementationOnce(() => newerRead.promise);

    // Two completed syncs start overlapping same-generation reads: A is the
    // older read, B the newest one.
    act(() => {
      window.dispatchEvent(new Event('sync-complete'));
      window.dispatchEvent(new Event('sync-complete'));
    });
    await act(async () => {});
    expect(mockGetAllTransactions).toHaveBeenCalledTimes(2);

    // The newer read settles first and publishes its rows.
    await act(async () => {
      newerRead.resolve([remoteTransaction()]);
    });
    expect(screen.getByTestId('transactions').textContent).toBe('Remote change');

    // The older read settles later. It must not overwrite the newer rows.
    await act(async () => {
      olderRead.resolve([localTransaction()]);
    });
    await act(async () => {});
    expect(screen.getByTestId('transactions').textContent).toBe('Remote change');
  } finally {
    await act(async () => {
      olderRead.resolve([localTransaction()]);
      newerRead.resolve([remoteTransaction()]);
    });
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => true,
    });
  }
});

test('a stale same-generation read rejection cannot publish an error after a newer read succeeds', async () => {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => false,
  });

  const olderRead = Promise.withResolvers<Transaction[]>();
  const newerRead = Promise.withResolvers<Transaction[]>();

  try {
    // The initial local read has settled before the overlapping refreshes.
    await renderLoadedProvider();
    expect(screen.getByTestId('transactions').textContent).toBe('Local only');

    mockGetAllTransactions.mockClear();
    mockGetAllTransactions
      .mockImplementationOnce(() => olderRead.promise)
      .mockImplementationOnce(() => newerRead.promise);

    // Two completed syncs start overlapping same-generation reads: A is the
    // older read, B the newest one.
    act(() => {
      window.dispatchEvent(new Event('sync-complete'));
      window.dispatchEvent(new Event('sync-complete'));
    });
    await act(async () => {});
    expect(mockGetAllTransactions).toHaveBeenCalledTimes(2);

    // The newer read settles first and publishes its rows.
    await act(async () => {
      newerRead.resolve([remoteTransaction()]);
    });
    expect(screen.getByTestId('transactions').textContent).toBe('Remote change');
    expect(screen.getByTestId('error').textContent).toBe('');

    // The older read rejects later. It is no longer the latest read, so its
    // failure must not publish an error over the newer successful result.
    await act(async () => {
      olderRead.reject(new Error('stale read failure'));
    });
    await act(async () => {});
    expect(screen.getByTestId('transactions').textContent).toBe('Remote change');
    expect(screen.getByTestId('error').textContent).toBe('');
  } finally {
    // Resolve any gate a failed assertion left pending; resolving an already
    // rejected gate is a no-op and must never surface as an unhandled
    // rejection.
    await act(async () => {
      olderRead.resolve([localTransaction()]);
      newerRead.resolve([remoteTransaction()]);
    });
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => true,
    });
  }
});
