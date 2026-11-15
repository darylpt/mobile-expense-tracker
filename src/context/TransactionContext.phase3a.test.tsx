// ============================================================
// TransactionContext.phase3a.test.tsx — auth scope / sign-out isolation
// ============================================================

import React from 'react';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import type { Account, Category, Stock, Transaction } from '@/types';
import {
  TransactionProvider,
  useTransactionContext,
  type TransactionContextValue,
} from './TransactionContext';
import { useAuth } from '@/context/AuthContext';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { useStocks } from '@/hooks/useStocks';
import { backgroundSync } from '@/lib/sync';
import { publishAuthIdentity } from '@/lib/auth-scope';
import {
  getAllTransactions,
  getAllAccounts,
  getAllCategories,
  hasAnyLocalData,
  addTransaction as addTransactionToDB,
  updateTransaction as updateTransactionInDB,
  deleteTransaction as deleteTransactionFromDB,
  addCategory as addCategoryToDB,
  updateCategory as updateCategoryInDB,
  deleteCategory as deleteCategoryFromDB,
  moveCategoryTo as moveCategoryToDB,
  getAllStocks,
  addStock as addStockToDB,
  updateStock as updateStockInDB,
  deleteStock as deleteStockFromDB,
  moveStockTo as moveStockToDB,
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
  addCategory: jest.fn(),
  updateCategory: jest.fn(),
  deleteCategory: jest.fn(),
  moveCategoryTo: jest.fn(),
  getAllStocks: jest.fn(() => Promise.resolve([])),
  addStock: jest.fn(),
  updateStock: jest.fn(),
  deleteStock: jest.fn(),
  moveStockTo: jest.fn(),
}));

const mockGetAllTransactions = getAllTransactions as jest.MockedFunction<typeof getAllTransactions>;
const mockGetAllAccounts = getAllAccounts as jest.MockedFunction<typeof getAllAccounts>;
const mockBackgroundSync = backgroundSync as jest.MockedFunction<typeof backgroundSync>;
const mockHasAnyLocalData = hasAnyLocalData as jest.MockedFunction<typeof hasAnyLocalData>;
const mockAddTransaction = addTransactionToDB as jest.MockedFunction<typeof addTransactionToDB>;
const mockUpdateTransaction = updateTransactionInDB as jest.MockedFunction<typeof updateTransactionInDB>;
const mockDeleteTransaction = deleteTransactionFromDB as jest.MockedFunction<typeof deleteTransactionFromDB>;
const mockGetAllCategories = jest.mocked(getAllCategories);
const mockAddCategory = jest.mocked(addCategoryToDB);
const mockUpdateCategory = jest.mocked(updateCategoryInDB);
const mockDeleteCategory = jest.mocked(deleteCategoryFromDB);
const mockMoveCategoryTo = jest.mocked(moveCategoryToDB);
const mockGetAllStocks = jest.mocked(getAllStocks);
const mockAddStock = jest.mocked(addStockToDB);
const mockUpdateStock = jest.mocked(updateStockInDB);
const mockDeleteStock = jest.mocked(deleteStockFromDB);
const mockMoveStockTo = jest.mocked(moveStockToDB);

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
  mockGetAllAccounts.mockResolvedValue([]);
  mockGetAllCategories.mockResolvedValue([]);
  mockGetAllStocks.mockResolvedValue([]);
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

function mountTree(extra?: React.ReactNode) {
  return (
    <TransactionProvider>
      <Probe />
      {extra}
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
// Account switch: ownership proof is bound to the rendered identity
// ============================================================

interface ScopeRender {
  readonly authUserId: string | null;
  readonly isScopeVerified: boolean;
  readonly accountIds: readonly string[];
}

function ScopeRenderProbe({
  onRender,
  refreshRef,
}: {
  onRender: (rendered: ScopeRender) => void;
  refreshRef: { current: (() => Promise<void>) | null };
}) {
  const { isScopeVerified } = useTransactionContext();
  const { user } = useAuth();
  const { accounts, refreshAccounts } = useAccounts();

  // Capture the callback only while owner A's verified scope is committed, so
  // the later transition cannot replace it with an account-B callback. Never
  // written during render.
  React.useEffect(() => {
    if (isScopeVerified && user?.id === 'user-1') {
      refreshRef.current = refreshAccounts;
    }
  }, [isScopeVerified, user?.id, refreshAccounts, refreshRef]);

  // Record during render, not after commit: the first render of the new
  // identity is the one that must not consume the previous owner's
  // verification, even when a render-phase bucket reset re-runs it.
  onRender({
    authUserId: user?.id ?? null,
    isScopeVerified,
    accountIds: accounts.map((account) => account.id),
  });

  return null;
}

test('an account switch cannot inherit verification or read the previous owner cache', async () => {
  localStorage.setItem('lastUserId', 'user-1');
  const accountA: Account = {
    id: 'account-owner-a',
    name: 'Owner A Checking',
    startingBalance: 125,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  mockGetAllAccounts.mockResolvedValue([accountA]);

  // Keep the startup sync pending. A resolved sync would start another owner-A
  // read and make the post-transition account-read count ambiguous.
  const syncResult = Promise.withResolvers<boolean>();
  mockBackgroundSync.mockReturnValue(syncResult.promise);

  actAsAuthenticated('user-1');
  const renders: ScopeRender[] = [];
  const refreshRef: { current: (() => Promise<void>) | null } = { current: null };
  const tree = () =>
    mountTree(
      <ScopeRenderProbe
        onRender={(rendered) => renders.push(rendered)}
        refreshRef={refreshRef}
      />,
    );

  const view = render(tree());
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
  await waitFor(() =>
    expect(
      renders.some(
        (rendered) =>
          rendered.authUserId === 'user-1' &&
          rendered.isScopeVerified &&
          rendered.accountIds.includes(accountA.id),
      ),
    ).toBe(true),
  );
  expect(refreshRef.current).not.toBeNull();

  const ownerAReads = mockGetAllAccounts.mock.calls.length;
  const staleRefreshAccounts = refreshRef.current!;

  // A → B with the same provider instance. The storage marker still says A,
  // so only the rendered identity/generation distinguishes the sessions.
  actAsAuthenticated('user-2');
  view.rerender(tree());

  await waitFor(() =>
    expect(screen.getByTestId('error').textContent).toContain(
      'different signed-in account',
    ),
  );
  await act(async () => {});

  // The first B render happens before the provider's passive initialization
  // effect can clear A's verification. No B render may observe it as true or
  // see owner A's account rows.
  const ownerBRenders = renders.filter(
    (rendered) => rendered.authUserId === 'user-2',
  );
  expect(ownerBRenders.length).toBeGreaterThan(0);
  for (const rendered of ownerBRenders) {
    expect(rendered.isScopeVerified).toBe(false);
    expect(rendered.accountIds).not.toContain(accountA.id);
  }

  // Verification is not inherited, so no account read starts for B.
  expect(mockGetAllAccounts).toHaveBeenCalledTimes(ownerAReads);

  // A callback captured under owner A's verified scope is inert afterwards.
  await act(async () => {
    await staleRefreshAccounts();
  });
  expect(mockGetAllAccounts).toHaveBeenCalledTimes(ownerAReads);

  expect(localStorage.getItem('lastUserId')).toBe('user-1');
  expect(mockClearAllLocalData).not.toHaveBeenCalled();
  expect(mockAddTransaction).not.toHaveBeenCalled();
  expect(mockUpdateTransaction).not.toHaveBeenCalled();
  expect(mockDeleteTransaction).not.toHaveBeenCalled();

  await act(async () => {
    syncResult.resolve(true);
  });
});

// ============================================================
// Category switch: useCategories is bound to provider verification
// ============================================================

interface CategoryScopeRender {
  readonly authUserId: string | null;
  readonly isScopeVerified: boolean;
  readonly categoryIds: readonly string[];
  readonly filteredIds: readonly string[];
}

function CategoryScopeProbe({
  onRender,
  refreshRef,
}: {
  onRender: (rendered: CategoryScopeRender) => void;
  refreshRef: { current: (() => Promise<void>) | null };
}) {
  const { isScopeVerified } = useTransactionContext();
  const { user } = useAuth();
  const { categories, refreshCategories, getCategoriesByType } = useCategories();

  // Capture the callback only while owner A's verified scope is committed, so
  // the later transition cannot replace it with a scope-B callback. Never
  // written during render.
  React.useEffect(() => {
    if (isScopeVerified && user?.id === 'user-1') {
      refreshRef.current = refreshCategories;
    }
  }, [isScopeVerified, user?.id, refreshCategories, refreshRef]);

  // Record during render, not after commit: the first render of the new
  // identity is the one that must not expose the previous owner's categories,
  // even before the provider's passive initialization effect can run.
  onRender({
    authUserId: user?.id ?? null,
    isScopeVerified,
    categoryIds: categories.map((category) => category.id),
    filteredIds: (['income', 'expense', 'transaction'] as const)
      .flatMap((type) => getCategoriesByType(type))
      .map((category) => category.id),
  });

  return null;
}

test('a category switch cannot expose or re-read the previous owner cache', async () => {
  localStorage.setItem('lastUserId', 'user-1');
  const categoryAExpense: Category = {
    id: 'category-owner-a-expense',
    name: 'Owner A Groceries',
    type: 'expense',
    sortOrder: 0,
    hasDestinationAccount: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const categoryAIncome: Category = {
    id: 'category-owner-a-income',
    name: 'Owner A Salary',
    type: 'income',
    sortOrder: 0,
    hasDestinationAccount: false,
    createdAt: 2,
    updatedAt: 2,
  };
  mockGetAllCategories.mockResolvedValue([categoryAExpense, categoryAIncome]);

  // Keep the startup sync pending. A resolved sync would start another owner-A
  // category read and make the post-transition category-read count ambiguous.
  const syncResult = Promise.withResolvers<boolean>();
  mockBackgroundSync.mockReturnValue(syncResult.promise);

  actAsAuthenticated('user-1');
  const renders: CategoryScopeRender[] = [];
  const refreshRef: { current: (() => Promise<void>) | null } = { current: null };
  const tree = () =>
    mountTree(
      <CategoryScopeProbe
        onRender={(rendered) => renders.push(rendered)}
        refreshRef={refreshRef}
      />,
    );

  const view = render(tree());
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
  await waitFor(() =>
    expect(
      renders.some(
        (rendered) =>
          rendered.authUserId === 'user-1' &&
          rendered.isScopeVerified &&
          rendered.categoryIds.includes(categoryAExpense.id) &&
          rendered.categoryIds.includes(categoryAIncome.id),
      ),
    ).toBe(true),
  );
  expect(refreshRef.current).not.toBeNull();

  const ownerAReads = mockGetAllCategories.mock.calls.length;
  expect(ownerAReads).toBeGreaterThan(0);
  const staleRefreshCategories = refreshRef.current!;

  // A → B with the same provider and hook instances. The storage marker still
  // says A, so only the rendered identity/generation distinguishes the
  // sessions.
  actAsAuthenticated('user-2');
  view.rerender(tree());

  await waitFor(() =>
    expect(screen.getByTestId('error').textContent).toContain(
      'different signed-in account',
    ),
  );
  await act(async () => {});

  const firstOwnerBRender = renders.findIndex(
    (rendered) => rendered.authUserId === 'user-2',
  );
  expect(firstOwnerBRender).toBeGreaterThan(0);

  // The render immediately before the transition saw owner A's verified rows
  // and both filter groups, so the empty transition render is meaningful.
  const lastOwnerARender = renders[firstOwnerBRender - 1];
  expect(lastOwnerARender.authUserId).toBe('user-1');
  expect(lastOwnerARender.isScopeVerified).toBe(true);
  expect(lastOwnerARender.categoryIds).toEqual(
    expect.arrayContaining([categoryAExpense.id, categoryAIncome.id]),
  );
  expect(lastOwnerARender.filteredIds).toEqual(
    expect.arrayContaining([categoryAExpense.id, categoryAIncome.id]),
  );

  // Every render of the new scope, starting with the transition render, is
  // locked and empty. Checking the whole slice, not only the final DOM, proves
  // no intermediate render exposed the previous owner's categories.
  const ownerBRenders = renders.slice(firstOwnerBRender);
  expect(ownerBRenders.length).toBeGreaterThan(0);
  for (const rendered of ownerBRenders) {
    expect(rendered.authUserId).toBe('user-2');
    expect(rendered.isScopeVerified).toBe(false);
    expect(rendered.categoryIds).toEqual([]);
    expect(rendered.filteredIds).toEqual([]);
  }

  // B is unverified, so neither the provider nor the hook starts a category
  // read after the switch.
  expect(mockGetAllCategories).toHaveBeenCalledTimes(ownerAReads);

  // A refresh captured under owner A's verified scope is inert afterwards.
  await act(async () => {
    await staleRefreshCategories();
  });
  expect(mockGetAllCategories).toHaveBeenCalledTimes(ownerAReads);

  expect(localStorage.getItem('lastUserId')).toBe('user-1');
  expect(mockClearAllLocalData).not.toHaveBeenCalled();
  expect(mockAddCategory).not.toHaveBeenCalled();
  expect(mockUpdateCategory).not.toHaveBeenCalled();
  expect(mockDeleteCategory).not.toHaveBeenCalled();
  expect(mockMoveCategoryTo).not.toHaveBeenCalled();
  expect(mockAddTransaction).not.toHaveBeenCalled();
  expect(mockUpdateTransaction).not.toHaveBeenCalled();
  expect(mockDeleteTransaction).not.toHaveBeenCalled();

  await act(async () => {
    syncResult.resolve(true);
  });
});

// ============================================================
// Stock switch: useStocks is bound to provider verification
// ============================================================

interface StockScopeRender {
  readonly authUserId: string | null;
  readonly isScopeVerified: boolean;
  readonly stockIds: readonly string[];
  readonly isLoading: boolean;
  readonly error: string | null;
}

function StockScopeProbe({
  onRender,
  refreshRef,
}: {
  onRender: (rendered: StockScopeRender) => void;
  refreshRef: { current: (() => Promise<void>) | null };
}) {
  const { isScopeVerified } = useTransactionContext();
  const { user } = useAuth();
  const { stocks, isLoading, error, refreshStocks } = useStocks();

  // Capture the callback only while owner A's verified scope is committed, so
  // the later transition cannot replace it with a scope-B callback. Never
  // written during render.
  React.useEffect(() => {
    if (isScopeVerified && user?.id === 'user-1') {
      refreshRef.current = refreshStocks;
    }
  }, [isScopeVerified, user?.id, refreshStocks, refreshRef]);

  // Record during render, not after commit: the first render of the new
  // identity is the one that must not expose the previous owner's stocks,
  // even before the provider's passive initialization effect can run.
  onRender({
    authUserId: user?.id ?? null,
    isScopeVerified,
    stockIds: stocks.map((stock) => stock.id),
    isLoading,
    error,
  });

  return null;
}

test('a stock switch cannot expose or re-read the previous owner cache', async () => {
  localStorage.setItem('lastUserId', 'user-1');
  const stockA: Stock = {
    id: 'stock-owner-a',
    ticker: 'BDO',
    name: 'Owner A BDO',
    currentPrice: null,
    priceUpdatedAt: null,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  mockGetAllStocks.mockResolvedValue([stockA]);

  // Keep the startup sync pending. A resolved sync would start another owner-A
  // read and make the post-transition stock-read count ambiguous.
  const syncResult = Promise.withResolvers<boolean>();
  mockBackgroundSync.mockReturnValue(syncResult.promise);

  actAsAuthenticated('user-1');
  const renders: StockScopeRender[] = [];
  const refreshRef: { current: (() => Promise<void>) | null } = { current: null };
  const tree = () =>
    mountTree(
      <StockScopeProbe
        onRender={(rendered) => renders.push(rendered)}
        refreshRef={refreshRef}
      />,
    );

  const view = render(tree());
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
  await waitFor(() =>
    expect(
      renders.some(
        (rendered) =>
          rendered.authUserId === 'user-1' &&
          rendered.isScopeVerified &&
          rendered.stockIds.includes(stockA.id),
      ),
    ).toBe(true),
  );
  expect(refreshRef.current).not.toBeNull();

  const ownerAReads = mockGetAllStocks.mock.calls.length;
  expect(ownerAReads).toBeGreaterThan(0);
  const staleRefreshStocks = refreshRef.current!;

  // A → B with the same provider and hook instances. The storage marker still
  // says A, so only the rendered identity/generation distinguishes the
  // sessions.
  actAsAuthenticated('user-2');
  view.rerender(tree());

  await waitFor(() =>
    expect(screen.getByTestId('error').textContent).toContain(
      'different signed-in account',
    ),
  );
  await act(async () => {});

  const firstOwnerBRender = renders.findIndex(
    (rendered) => rendered.authUserId === 'user-2',
  );
  expect(firstOwnerBRender).toBeGreaterThan(0);

  // The render immediately before the transition saw owner A's verified rows,
  // so the empty transition render is meaningful.
  const lastOwnerARender = renders[firstOwnerBRender - 1];
  expect(lastOwnerARender.authUserId).toBe('user-1');
  expect(lastOwnerARender.isScopeVerified).toBe(true);
  expect(lastOwnerARender.stockIds).toEqual([stockA.id]);

  // Every render of the new scope, starting with the transition render, is
  // locked and empty with no loading or error state carried over. Checking the
  // whole slice proves no intermediate render exposed the previous owner's
  // stocks.
  const ownerBRenders = renders.slice(firstOwnerBRender);
  expect(ownerBRenders.length).toBeGreaterThan(0);
  for (const rendered of ownerBRenders) {
    expect(rendered.authUserId).toBe('user-2');
    expect(rendered.isScopeVerified).toBe(false);
    expect(rendered.stockIds).toEqual([]);
    expect(rendered.isLoading).toBe(false);
    expect(rendered.error).toBeNull();
  }

  // B is unverified, so the hook never starts a stock read after the switch.
  expect(mockGetAllStocks).toHaveBeenCalledTimes(ownerAReads);

  // A refresh captured under owner A's verified scope is inert afterwards.
  await act(async () => {
    await staleRefreshStocks();
  });
  expect(mockGetAllStocks).toHaveBeenCalledTimes(ownerAReads);

  expect(localStorage.getItem('lastUserId')).toBe('user-1');
  expect(mockClearAllLocalData).not.toHaveBeenCalled();
  expect(mockAddStock).not.toHaveBeenCalled();
  expect(mockUpdateStock).not.toHaveBeenCalled();
  expect(mockDeleteStock).not.toHaveBeenCalled();
  expect(mockMoveStockTo).not.toHaveBeenCalled();
  expect(mockAddTransaction).not.toHaveBeenCalled();
  expect(mockUpdateTransaction).not.toHaveBeenCalled();
  expect(mockDeleteTransaction).not.toHaveBeenCalled();

  await act(async () => {
    syncResult.resolve(true);
  });
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
