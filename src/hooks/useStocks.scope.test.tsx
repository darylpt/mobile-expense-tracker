// ============================================================
// useStocks.scope.test.tsx — Verification-only scope regression
//
// Observes the public useStocks() result from a real mounted component on
// every render. Only the context boundaries and the IndexedDB adapter are
// doubled; React rendering and the hook implementation stay real.
//
// Auth identity (state/user/generation) and transaction-context verification
// are independent dimensions of the same external-store snapshot. Revoking
// only verification must not advance the shared auth generation, and the
// first render of the locked scope must already be empty. The current hook
// keeps the previous owner's stocks in state until a passive effect clears
// them, so this regression fails on that transition render. Its retained
// refresh callback also keeps believing the old verification value, so it
// still reaches IndexedDB after the scope is locked.
// ============================================================

import React from 'react';
import type * as ReactNamespace from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Stock } from '@/types';
import {
  getAuthGeneration,
  publishAuthIdentity,
  type AuthIdentity,
} from '@/lib/auth-scope';
import {
  addStock as addStockToDB,
  deleteStock as deleteStockFromDB,
  getAllStocks,
  moveStockTo as moveStockToInDB,
  updateStock as updateStockInDB,
} from '@/lib/idb';
import { useStocks } from './useStocks';

// ---------------------------------------------------------------------------
// External-store boundary double
//
// Auth identity (state/user/generation) and transaction-context verification
// are separate dimensions. Publishing an identity goes through the real
// auth-scope module and mirrors its generation; flipping verification leaves
// auth state, user, and generation untouched.
// ---------------------------------------------------------------------------

type MockAuthState = AuthIdentity['state'];

interface MockBoundary {
  readonly authState: MockAuthState;
  readonly userId: string | null;
  readonly generation: number;
  readonly isScopeVerified: boolean;
}

const mockBoundaryListeners = new Set<() => void>();

let mockBoundary: MockBoundary = {
  authState: 'loading',
  userId: null,
  generation: 0,
  isScopeVerified: false,
};

function mockGetBoundary(): MockBoundary {
  return mockBoundary;
}

function mockSubscribeBoundary(listener: () => void): () => void {
  mockBoundaryListeners.add(listener);
  return () => {
    mockBoundaryListeners.delete(listener);
  };
}

function mockNotifyBoundary(): void {
  for (const listener of [...mockBoundaryListeners]) listener();
}

/** Publishes a real auth identity and mirrors the generation it returns. */
function mockPublishAuth(identity: AuthIdentity): void {
  const generation = publishAuthIdentity(identity);
  const isScopeVerified = mockBoundary.isScopeVerified;
  mockBoundary = {
    authState: identity.state,
    userId: identity.state === 'authenticated' ? identity.userId : null,
    generation,
    isScopeVerified,
  };
  mockNotifyBoundary();
}

/** Flips only transaction-context verification; auth identity is untouched. */
function mockSetVerification(isScopeVerified: boolean): void {
  mockBoundary = { ...mockBoundary, isScopeVerified };
  mockNotifyBoundary();
}

/**
 * Overrides part of the external-store snapshot without publishing a new auth
 * identity. Used for runtime snapshots the AuthIdentity type cannot express,
 * such as an authenticated state whose user record is missing.
 */
function mockSetBoundary(patch: Partial<MockBoundary>): void {
  mockBoundary = { ...mockBoundary, ...patch };
  mockNotifyBoundary();
}

jest.mock('@/context/TransactionContext', () => {
  const ReactModule = jest.requireActual<typeof ReactNamespace>('react');
  return {
    useTransactionContext: () => {
      const boundary = ReactModule.useSyncExternalStore(
        mockSubscribeBoundary,
        mockGetBoundary,
        mockGetBoundary,
      );
      return { isScopeVerified: boundary.isScopeVerified };
    },
  };
});

jest.mock('@/context/AuthContext', () => {
  const ReactModule = jest.requireActual<typeof ReactNamespace>('react');
  return {
    useAuth: () => {
      const boundary = ReactModule.useSyncExternalStore(
        mockSubscribeBoundary,
        mockGetBoundary,
        mockGetBoundary,
      );
      return {
        state: boundary.authState,
        user: boundary.userId === null ? null : { id: boundary.userId },
        authGeneration: boundary.generation,
      };
    },
  };
});

jest.mock('@/lib/idb', () => ({
  getAllStocks: jest.fn(),
  addStock: jest.fn(),
  updateStock: jest.fn(),
  deleteStock: jest.fn(),
  moveStockTo: jest.fn(),
}));

const mockGetAllStocks = jest.mocked(getAllStocks);
const mockAddStock = jest.mocked(addStockToDB);
const mockUpdateStock = jest.mocked(updateStockInDB);
const mockDeleteStock = jest.mocked(deleteStockFromDB);
const mockMoveStockTo = jest.mocked(moveStockToInDB);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER_A_USER_ID = 'scope-owner-a';
const OWNER_B_USER_ID = 'scope-owner-b';
const OWNER_A_STOCK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B_STOCK_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/**
 * A complete owner A row. Price state is legitimately nullable and `type` is
 * optional on `Stock`, so both are left at their unset representation.
 */
function makeOwnerAStock(): Stock {
  return {
    id: OWNER_A_STOCK_ID,
    ticker: 'BDO',
    name: 'Owner A Stock',
    currentPrice: null,
    priceUpdatedAt: null,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** A complete owner B row with every optional/nullable field populated. */
function makeOwnerBStock(): Stock {
  return {
    id: OWNER_B_STOCK_ID,
    ticker: 'SM',
    type: 'stock',
    name: 'Owner B Stock',
    currentPrice: 912.5,
    priceUpdatedAt: 2,
    sortOrder: 0,
    createdAt: 2,
    updatedAt: 2,
  };
}

// ---------------------------------------------------------------------------
// Render probe
// ---------------------------------------------------------------------------

type RefreshStocks = () => Promise<void>;
type StockDraft = Omit<Stock, 'id' | 'createdAt' | 'updatedAt'>;
type AddStock = (stock: StockDraft) => Promise<string>;
type UpdateStock = (
  stock: Partial<Stock> & Pick<Stock, 'id'>,
) => Promise<void>;
type DeleteStock = (id: string) => Promise<void>;
type MoveStockTo = (id: string, targetIndex: number) => Promise<void>;

interface ProbeRender {
  readonly stocks: readonly Stock[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refreshStocks: RefreshStocks;
  readonly addStock: AddStock;
  readonly updateStock: UpdateStock;
  readonly deleteStock: DeleteStock;
  readonly moveStockTo: MoveStockTo;
  readonly scope: MockBoundary;
}

function StocksProbe({
  onRender,
}: {
  onRender: (render: ProbeRender) => void;
}): React.ReactElement {
  const {
    stocks,
    isLoading,
    error,
    refreshStocks,
    addStock,
    updateStock,
    deleteStock,
    moveStockTo,
  } = useStocks();

  onRender({
    stocks,
    isLoading,
    error,
    refreshStocks,
    addStock,
    updateStock,
    deleteStock,
    moveStockTo,
    scope: mockGetBoundary(),
  });

  return (
    <ul data-testid="stock-list">
      {stocks.map((stock) => (
        <li key={stock.id}>{stock.name}</li>
      ))}
    </ul>
  );
}

function latestRender(renders: readonly ProbeRender[]): ProbeRender {
  const latest = renders[renders.length - 1];
  if (!latest) {
    throw new Error('probe has not rendered');
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Async and render helpers
// ---------------------------------------------------------------------------

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderProbe() {
  const renders: ProbeRender[] = [];
  const view = render(
    <StocksProbe onRender={(probeRender) => renders.push(probeRender)} />,
  );
  return { renders, view };
}

async function waitForReads(count: number): Promise<void> {
  await waitFor(() => {
    expect(mockGetAllStocks).toHaveBeenCalledTimes(count);
  });
}

async function waitForStocks(
  renders: readonly ProbeRender[],
  stocks: readonly Stock[],
): Promise<ProbeRender> {
  await waitFor(() => {
    const latest = latestRender(renders);
    expect(latest.stocks).toEqual(stocks);
    expect(latest.isLoading).toBe(false);
    expect(latest.error).toBeNull();
  });
  return latestRender(renders);
}

async function waitForStockError(
  renders: readonly ProbeRender[],
  message: string,
): Promise<ProbeRender> {
  await waitFor(() => {
    const latest = latestRender(renders);
    expect(latest.error).toBe(message);
    expect(latest.isLoading).toBe(false);
  });
  return latestRender(renders);
}

function startVerifiedOwnerA(): void {
  mockPublishAuth({ state: 'authenticated', userId: OWNER_A_USER_ID });
  mockSetVerification(true);
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

// ---------------------------------------------------------------------------
// Mutation helpers
// ---------------------------------------------------------------------------

type MutationMethod = 'add' | 'update' | 'delete' | 'move';
type MutationOutcome = 'resolve' | 'reject';

const MATRIX_ADD_ID = 'matrix-add-id';
const MATRIX_DRAFT: StockDraft = {
  ticker: 'TEL',
  type: 'stock',
  name: 'Matrix Draft',
  currentPrice: 123.45,
  priceUpdatedAt: 9,
  sortOrder: 2,
};
const MATRIX_UPDATE: Partial<Stock> & Pick<Stock, 'id'> = {
  id: OWNER_A_STOCK_ID,
  name: 'Matrix Update',
};
const MATRIX_TARGET_INDEX = 4;

function invokeMutation(
  method: MutationMethod,
  probeRender: ProbeRender,
): Promise<unknown> {
  switch (method) {
    case 'add':
      return probeRender.addStock(MATRIX_DRAFT);
    case 'update':
      return probeRender.updateStock(MATRIX_UPDATE);
    case 'delete':
      return probeRender.deleteStock(OWNER_A_STOCK_ID);
    case 'move':
      return probeRender.moveStockTo(OWNER_A_STOCK_ID, MATRIX_TARGET_INDEX);
  }
}

function arrangeMutationDeferred(
  method: MutationMethod,
  addDeferred: Deferred<string>,
  voidDeferred: Deferred<void>,
): void {
  switch (method) {
    case 'add':
      mockAddStock.mockReturnValueOnce(addDeferred.promise);
      break;
    case 'update':
      mockUpdateStock.mockReturnValueOnce(voidDeferred.promise);
      break;
    case 'delete':
      mockDeleteStock.mockReturnValueOnce(voidDeferred.promise);
      break;
    case 'move':
      mockMoveStockTo.mockReturnValueOnce(voidDeferred.promise);
      break;
  }
}

function settleMutationDeferred(
  method: MutationMethod,
  outcome: MutationOutcome,
  addDeferred: Deferred<string>,
  voidDeferred: Deferred<void>,
  failure: Error,
): void {
  if (method === 'add') {
    if (outcome === 'resolve') addDeferred.resolve(MATRIX_ADD_ID);
    else addDeferred.reject(failure);
    return;
  }

  if (outcome === 'resolve') voidDeferred.resolve();
  else voidDeferred.reject(failure);
}

function arrangeMutationFailure(method: MutationMethod, failure: Error): void {
  switch (method) {
    case 'add':
      mockAddStock.mockRejectedValueOnce(failure);
      break;
    case 'update':
      mockUpdateStock.mockRejectedValueOnce(failure);
      break;
    case 'delete':
      mockDeleteStock.mockRejectedValueOnce(failure);
      break;
    case 'move':
      mockMoveStockTo.mockRejectedValueOnce(failure);
      break;
  }
}

function mutationCallTotals(): Record<MutationMethod, number> {
  return {
    add: mockAddStock.mock.calls.length,
    update: mockUpdateStock.mock.calls.length,
    delete: mockDeleteStock.mock.calls.length,
    move: mockMoveStockTo.mock.calls.length,
  };
}

function expectedMutationCalls(
  method: MutationMethod,
): Record<MutationMethod, number> {
  const calls: Record<MutationMethod, number> = {
    add: 0,
    update: 0,
    delete: 0,
    move: 0,
  };
  calls[method] = 1;
  return calls;
}

function expectMutationArguments(method: MutationMethod): void {
  switch (method) {
    case 'add':
      expect(mockAddStock).toHaveBeenCalledWith(MATRIX_DRAFT);
      break;
    case 'update':
      expect(mockUpdateStock).toHaveBeenCalledWith(MATRIX_UPDATE);
      break;
    case 'delete':
      expect(mockDeleteStock).toHaveBeenCalledWith(OWNER_A_STOCK_ID);
      break;
    case 'move':
      expect(mockMoveStockTo).toHaveBeenCalledWith(
        OWNER_A_STOCK_ID,
        MATRIX_TARGET_INDEX,
      );
      break;
  }
}

describe('useStocks auth-scope isolation', () => {
  let errorSpy: jest.SpyInstance;

  function useStocksLogCalls(): unknown[][] {
    return errorSpy.mock.calls.filter(
      ([message]) => message === '[useStocks] Error loading stocks:',
    );
  }

  beforeEach(() => {
    mockBoundaryListeners.clear();
    mockPublishAuth({ state: 'unauthenticated' });
    mockSetVerification(false);
    mockGetAllStocks.mockReset();
    mockAddStock.mockReset();
    mockUpdateStock.mockReset();
    mockDeleteStock.mockReset();
    mockMoveStockTo.mockReset();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
  });

  it('does not expose the previous owner stocks on the first render after verification is revoked', async () => {
    const stockA = makeOwnerAStock();
    mockGetAllStocks.mockResolvedValue([stockA]);

    mockPublishAuth({ state: 'authenticated', userId: OWNER_A_USER_ID });
    mockSetVerification(true);

    const renders: ProbeRender[] = [];
    render(<StocksProbe onRender={(probeRender) => renders.push(probeRender)} />);

    await waitFor(() => {
      expect(screen.queryByText(stockA.name)).not.toBeNull();
      expect(latestRender(renders).isLoading).toBe(false);
    });

    // Owner A's verified result is visible before invalidation. This proves
    // the locked-scope leak assertion below is about a real prior row, not an
    // empty fixture.
    const ownerARender = latestRender(renders);
    expect(ownerARender.scope.isScopeVerified).toBe(true);
    expect(ownerARender.scope.authState).toBe('authenticated');
    expect(ownerARender.scope.userId).toBe(OWNER_A_USER_ID);
    expect(ownerARender.stocks).toEqual([stockA]);
    expect(ownerARender.isLoading).toBe(false);
    expect(ownerARender.error).toBeNull();

    const savedOwnerARefresh = ownerARender.refreshStocks;
    const readsAfterOwnerALoad = mockGetAllStocks.mock.calls.length;
    expect(readsAfterOwnerALoad).toBe(1);

    const generationBeforeLock = mockGetBoundary().generation;
    const authStateBeforeLock = mockGetBoundary().authState;
    const userIdBeforeLock = mockGetBoundary().userId;

    // Revoke only verification. Auth state, user, and generation must stay
    // exactly owner A's.
    act(() => {
      mockSetVerification(false);
    });

    const lockedBoundary = mockGetBoundary();
    expect(lockedBoundary.isScopeVerified).toBe(false);
    expect(lockedBoundary.authState).toBe(authStateBeforeLock);
    expect(lockedBoundary.userId).toBe(userIdBeforeLock);
    expect(lockedBoundary.generation).toBe(generationBeforeLock);
    expect(getAuthGeneration()).toBe(generationBeforeLock);

    // The render immediately preceding the lock had owner A's row.
    expect(ownerARender.stocks).toContainEqual(stockA);

    // The first locked invocation, before any passive effect can clear state,
    // must already be empty and settled.
    const firstLockedRender = renders.find(
      (probeRender) =>
        !probeRender.scope.isScopeVerified &&
        probeRender.scope.authState === 'authenticated' &&
        probeRender.scope.userId === OWNER_A_USER_ID &&
        probeRender.scope.generation === generationBeforeLock,
    );
    if (!firstLockedRender) {
      throw new Error('first locked render was not recorded');
    }
    expect(firstLockedRender.stocks).toEqual([]);
    expect(firstLockedRender.isLoading).toBe(false);
    expect(firstLockedRender.error).toBeNull();

    // Let the current hook's passive-effect clear settle; the regression is
    // that a render before that effect already exposed owner A's row.
    await waitFor(() => expect(screen.queryByText(stockA.name)).toBeNull());

    const lockedRenders = renders.filter(
      (probeRender) =>
        !probeRender.scope.isScopeVerified &&
        probeRender.scope.authState === 'authenticated' &&
        probeRender.scope.userId === OWNER_A_USER_ID &&
        probeRender.scope.generation === generationBeforeLock,
    );
    expect(lockedRenders.length).toBeGreaterThan(0);

    // Every invocation in the locked scope, including the first one, must
    // already be empty and settled.
    for (const lockedRender of lockedRenders) {
      expect(lockedRender.stocks).toEqual([]);
      expect(lockedRender.isLoading).toBe(false);
      expect(lockedRender.error).toBeNull();
    }

    // Revoking verification alone must not start another read.
    expect(mockGetAllStocks).toHaveBeenCalledTimes(readsAfterOwnerALoad);

    // A refresh callback retained from owner A's scope must not issue another
    // IndexedDB read while the scope is locked.
    const readsBeforeSavedRefresh = mockGetAllStocks.mock.calls.length;
    await act(async () => {
      await savedOwnerARefresh().catch(() => {});
    });
    expect(mockGetAllStocks).toHaveBeenCalledTimes(readsBeforeSavedRefresh);
  });

  it('fences retained owner A callbacks on the shared generation before React rerenders', async () => {
    const stockA = makeOwnerAStock();
    const stockB = makeOwnerBStock();
    mockGetAllStocks.mockResolvedValue([stockA]);

    mockPublishAuth({ state: 'authenticated', userId: OWNER_A_USER_ID });
    mockSetVerification(true);

    const renders: ProbeRender[] = [];
    render(<StocksProbe onRender={(probeRender) => renders.push(probeRender)} />);

    await waitFor(() => {
      expect(screen.queryByText(stockA.name)).not.toBeNull();
      expect(latestRender(renders).isLoading).toBe(false);
    });

    const ownerARender = latestRender(renders);
    expect(ownerARender.scope.isScopeVerified).toBe(true);
    expect(ownerARender.scope.authState).toBe('authenticated');
    expect(ownerARender.scope.userId).toBe(OWNER_A_USER_ID);
    expect(ownerARender.stocks).toEqual([stockA]);
    expect(ownerARender.error).toBeNull();

    const savedOwnerARefresh = ownerARender.refreshStocks;
    const savedOwnerAAdd = ownerARender.addStock;
    const savedOwnerAUpdate = ownerARender.updateStock;
    const savedOwnerADelete = ownerARender.deleteStock;
    const savedOwnerAMove = ownerARender.moveStockTo;

    const ownerAGeneration = ownerARender.scope.generation;
    expect(getAuthGeneration()).toBe(ownerAGeneration);
    expect(mockGetAllStocks).toHaveBeenCalledTimes(1);
    const renderCountBeforeSharedPublish = renders.length;

    // Publish a new shared identity directly, without notifying the
    // React-facing external store. React does not rerender, its mocked
    // useAuth snapshot still reports owner A, and no scope token has been
    // committed for owner B yet.
    const ownerBGeneration = publishAuthIdentity({
      state: 'authenticated',
      userId: OWNER_B_USER_ID,
    });
    expect(ownerBGeneration).not.toBe(ownerAGeneration);
    expect(getAuthGeneration()).toBe(ownerBGeneration);
    expect(mockGetBoundary().generation).toBe(ownerAGeneration);
    expect(mockGetBoundary().authState).toBe('authenticated');
    expect(mockGetBoundary().userId).toBe(OWNER_A_USER_ID);
    expect(renders).toHaveLength(renderCountBeforeSharedPublish);

    // The retained callbacks must be fenced by the shared generation even
    // though their token still points at owner A's live bucket. Relying on
    // the token alone would still reach IndexedDB during this interval.
    const readsBeforeStaleRefresh = mockGetAllStocks.mock.calls.length;
    await act(async () => {
      await expect(savedOwnerARefresh()).resolves.toBeUndefined();

      await expect(
        savedOwnerAAdd({
          ticker: 'SM',
          name: 'Scope Stale Add',
          currentPrice: null,
          priceUpdatedAt: null,
          sortOrder: 1,
        }),
      ).rejects.toThrow('Local data is locked to another account');

      await expect(
        savedOwnerAUpdate({ id: OWNER_A_STOCK_ID, name: 'Scope Stale Update' }),
      ).rejects.toThrow('Local data is locked to another account');

      await expect(savedOwnerADelete(OWNER_A_STOCK_ID)).rejects.toThrow(
        'Local data is locked to another account',
      );

      // Reorder keeps its existing swallow contract.
      await expect(savedOwnerAMove(OWNER_A_STOCK_ID, 1)).resolves.toBeUndefined();
    });

    expect(mockGetAllStocks).toHaveBeenCalledTimes(readsBeforeStaleRefresh);
    expect(mockAddStock).not.toHaveBeenCalled();
    expect(mockUpdateStock).not.toHaveBeenCalled();
    expect(mockDeleteStock).not.toHaveBeenCalled();
    expect(mockMoveStockTo).not.toHaveBeenCalled();
    expect(renders).toHaveLength(renderCountBeforeSharedPublish);

    // Now let React observe owner B and commit the new scope token.
    mockGetAllStocks.mockResolvedValue([stockB]);
    act(() => {
      mockPublishAuth({ state: 'authenticated', userId: OWNER_B_USER_ID });
    });

    expect(mockGetBoundary().authState).toBe('authenticated');
    expect(mockGetBoundary().userId).toBe(OWNER_B_USER_ID);
    expect(mockGetBoundary().generation).toBe(ownerBGeneration);
    expect(mockGetBoundary().isScopeVerified).toBe(true);

    await waitFor(() => {
      expect(screen.queryByText(stockA.name)).toBeNull();
      expect(screen.queryByText(stockB.name)).not.toBeNull();
    });

    const ownerBRenders = renders.filter(
      (probeRender) => probeRender.scope.userId === OWNER_B_USER_ID,
    );
    expect(ownerBRenders.length).toBeGreaterThan(0);

    // The new scope only ever sees its own rows, including its first render
    // after React catches up to the shared identity.
    for (const ownerBRender of ownerBRenders) {
      expect(ownerBRender.stocks).not.toContainEqual(stockA);
      expect(ownerBRender.stocks.some((stock) => stock.id === stockA.id)).toBe(
        false,
      );
    }

    const ownerBReadRender = latestRender(renders);
    expect(ownerBReadRender.stocks).toEqual([stockB]);
    expect(ownerBReadRender.isLoading).toBe(false);
    expect(ownerBReadRender.error).toBeNull();
    expect(mockGetAllStocks).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Scope transitions and loading
  // -------------------------------------------------------------------------

  it('resets to an empty loading bucket for owner B and only publishes B data', async () => {
    const stockA = makeOwnerAStock();
    const stockB = makeOwnerBStock();
    mockGetAllStocks.mockResolvedValueOnce([stockA]);

    startVerifiedOwnerA();
    const { renders } = renderProbe();
    await waitForStocks(renders, [stockA]);

    const bLoad = deferred<Stock[]>();
    mockGetAllStocks.mockReturnValueOnce(bLoad.promise);

    act(() => {
      mockPublishAuth({ state: 'authenticated', userId: OWNER_B_USER_ID });
    });
    await waitForReads(2);

    const ownerBRenders = renders.filter(
      (probeRender) => probeRender.scope.userId === OWNER_B_USER_ID,
    );
    expect(ownerBRenders.length).toBeGreaterThan(0);
    for (const ownerBRender of ownerBRenders) {
      expect(ownerBRender.scope.isScopeVerified).toBe(true);
      expect(ownerBRender.stocks).toEqual([]);
      expect(ownerBRender.error).toBeNull();
      expect(ownerBRender.isLoading).toBe(true);
      expect(
        ownerBRender.stocks.some((stock) => stock.id === stockA.id),
      ).toBe(false);
    }

    await act(async () => {
      bLoad.resolve([stockB]);
      await bLoad.promise;
    });

    const ownerBLoaded = await waitForStocks(renders, [stockB]);
    expect(ownerBLoaded.scope.userId).toBe(OWNER_B_USER_ID);
    expect(ownerBLoaded.stocks).toEqual([stockB]);
    expect(mockGetAllStocks).toHaveBeenCalledTimes(2);

    for (const ownerBRender of renders.filter(
      (probeRender) => probeRender.scope.userId === OWNER_B_USER_ID,
    )) {
      expect(
        ownerBRender.stocks.some((stock) => stock.id === stockA.id),
      ).toBe(false);
      expect(ownerBRender.error).toBeNull();
    }
  });

  it('starts a fresh read after re-login and fences the previous owner A load', async () => {
    const staleStock = { ...makeOwnerAStock(), name: 'Stale Owner A' };
    const freshStock = { ...makeOwnerAStock(), name: 'Fresh Owner A' };
    const firstLoad = deferred<Stock[]>();
    mockGetAllStocks.mockReturnValueOnce(firstLoad.promise);

    startVerifiedOwnerA();
    const { renders } = renderProbe();
    await waitForReads(1);
    expect(latestRender(renders).isLoading).toBe(true);
    expect(latestRender(renders).stocks).toEqual([]);
    const originalGeneration = mockGetBoundary().generation;

    act(() => {
      mockPublishAuth({ state: 'unauthenticated' });
    });

    const unauthenticatedRender = latestRender(renders);
    expect(unauthenticatedRender.scope.authState).toBe('unauthenticated');
    expect(unauthenticatedRender.scope.generation).toBeGreaterThan(
      originalGeneration,
    );
    expect(unauthenticatedRender.stocks).toEqual([]);
    expect(unauthenticatedRender.error).toBeNull();
    expect(unauthenticatedRender.isLoading).toBe(false);
    expect(mockGetAllStocks).toHaveBeenCalledTimes(1);

    const reloginLoad = deferred<Stock[]>();
    mockGetAllStocks.mockReturnValueOnce(reloginLoad.promise);
    act(() => {
      mockPublishAuth({ state: 'authenticated', userId: OWNER_A_USER_ID });
    });
    await waitForReads(2);

    const reloginGeneration = mockGetBoundary().generation;
    expect(reloginGeneration).toBeGreaterThan(originalGeneration);
    const reloginRenders = renders.filter(
      (probeRender) => probeRender.scope.generation === reloginGeneration,
    );
    expect(reloginRenders.length).toBeGreaterThan(0);
    for (const reloginRender of reloginRenders) {
      expect(reloginRender.stocks).toEqual([]);
      expect(reloginRender.error).toBeNull();
      expect(reloginRender.isLoading).toBe(true);
    }

    // The old initial load settles only after the new token owns the scope.
    await act(async () => {
      firstLoad.resolve([staleStock]);
      await firstLoad.promise;
    });

    expect(latestRender(renders).stocks).toEqual([]);
    expect(latestRender(renders).isLoading).toBe(true);
    expect(latestRender(renders).error).toBeNull();
    expect(latestRender(renders).scope.generation).toBe(reloginGeneration);

    await act(async () => {
      reloginLoad.resolve([freshStock]);
      await reloginLoad.promise;
    });

    const reloginLoaded = await waitForStocks(renders, [freshStock]);
    expect(reloginLoaded.scope.generation).toBe(reloginGeneration);
    expect(reloginLoaded.stocks).not.toContainEqual(staleStock);
    expect(mockGetAllStocks).toHaveBeenCalledTimes(2);
  });

  it('drops to an empty settled bucket when auth enters loading without reading', async () => {
    const stockA = makeOwnerAStock();
    mockGetAllStocks.mockResolvedValueOnce([stockA]);

    startVerifiedOwnerA();
    const { renders } = renderProbe();
    await waitForStocks(renders, [stockA]);
    const readsBeforeLoading = mockGetAllStocks.mock.calls.length;

    act(() => {
      mockPublishAuth({ state: 'loading' });
    });

    const loadingRenders = renders.filter(
      (probeRender) => probeRender.scope.authState === 'loading',
    );
    expect(loadingRenders.length).toBeGreaterThan(0);
    for (const loadingRender of loadingRenders) {
      expect(loadingRender.stocks).toEqual([]);
      expect(loadingRender.error).toBeNull();
      expect(loadingRender.isLoading).toBe(false);
    }
    expect(mockGetAllStocks).toHaveBeenCalledTimes(readsBeforeLoading);
  });

  it.each([
    {
      label: 'an authenticated snapshot with no user',
      arrange: () => {
        mockSetBoundary({ authState: 'authenticated', userId: null });
        mockSetVerification(true);
      },
    },
    {
      label: 'disabled auth with verification withheld',
      arrange: () => {
        mockPublishAuth({ state: 'disabled' });
        mockSetVerification(false);
      },
    },
  ])(
    'does not read or write for ineligible startup: $label',
    async ({ arrange }) => {
      arrange();
      const { renders } = renderProbe();
      const first = latestRender(renders);

      expect(first.stocks).toEqual([]);
      expect(first.error).toBeNull();
      expect(first.isLoading).toBe(false);
      expect(mockGetAllStocks).not.toHaveBeenCalled();
      expect(mockAddStock).not.toHaveBeenCalled();
      expect(mockUpdateStock).not.toHaveBeenCalled();
      expect(mockDeleteStock).not.toHaveBeenCalled();
      expect(mockMoveStockTo).not.toHaveBeenCalled();

      await act(async () => {
        await expect(first.refreshStocks()).resolves.toBeUndefined();
      });

      expect(mockGetAllStocks).not.toHaveBeenCalled();
      expect(useStocksLogCalls()).toEqual([]);
    },
  );

  // -------------------------------------------------------------------------
  // Deferred initial loads
  // -------------------------------------------------------------------------

  it.each(['resolve', 'reject'] as const)(
    'does not publish an owner A initial load that %s after owner B starts',
    async (staleOutcome) => {
      const stockA = makeOwnerAStock();
      const stockB = makeOwnerBStock();
      const aLoad = deferred<Stock[]>();
      const bLoad = deferred<Stock[]>();
      mockGetAllStocks
        .mockReturnValueOnce(aLoad.promise)
        .mockReturnValueOnce(bLoad.promise);

      startVerifiedOwnerA();
      const { renders } = renderProbe();
      await waitForReads(1);

      act(() => {
        mockPublishAuth({ state: 'authenticated', userId: OWNER_B_USER_ID });
      });
      await waitForReads(2);

      await act(async () => {
        if (staleOutcome === 'resolve') aLoad.resolve([stockA]);
        else aLoad.reject(new Error('stale owner A load failed'));
        await aLoad.promise.catch(() => {});
      });

      const ownerBRenders = renders.filter(
        (probeRender) => probeRender.scope.userId === OWNER_B_USER_ID,
      );
      expect(ownerBRenders.length).toBeGreaterThan(0);
      for (const ownerBRender of ownerBRenders) {
        expect(ownerBRender.stocks).toEqual([]);
        expect(ownerBRender.error).toBeNull();
        expect(ownerBRender.isLoading).toBe(true);
        expect(
          ownerBRender.stocks.some((stock) => stock.id === stockA.id),
        ).toBe(false);
      }
      if (staleOutcome === 'reject') {
        expect(useStocksLogCalls()).toEqual([]);
      }

      await act(async () => {
        bLoad.resolve([stockB]);
        await bLoad.promise;
      });

      const ownerBLoaded = await waitForStocks(renders, [stockB]);
      expect(ownerBLoaded.scope.userId).toBe(OWNER_B_USER_ID);
      expect(ownerBLoaded.stocks).not.toContainEqual(stockA);
      expect(mockGetAllStocks).toHaveBeenCalledTimes(2);
      expect(useStocksLogCalls()).toEqual([]);

      for (const ownerBRender of renders.filter(
        (probeRender) => probeRender.scope.userId === OWNER_B_USER_ID,
      )) {
        expect(ownerBRender.stocks).not.toContainEqual(stockA);
        expect(ownerBRender.error).toBeNull();
      }
    },
  );

  it.each([
    {
      label: 'an Error message',
      rejection: new Error('IndexedDB read failed'),
      expectedMessage: 'IndexedDB read failed',
    },
    {
      label: 'a non-Error rejection',
      rejection: 'indexeddb offline',
      expectedMessage: 'Failed to load stocks',
    },
  ])(
    'settles a current-scope initial load rejection with $label',
    async ({ rejection, expectedMessage }) => {
      mockGetAllStocks.mockRejectedValueOnce(rejection);
      startVerifiedOwnerA();
      const { renders } = renderProbe();

      const failed = await waitForStockError(renders, expectedMessage);
      expect(failed.stocks).toEqual([]);
      expect(failed.isLoading).toBe(false);
      expect(failed.scope.isScopeVerified).toBe(true);
      expect(useStocksLogCalls()).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith(
        '[useStocks] Error loading stocks:',
        rejection,
      );
    },
  );

  // -------------------------------------------------------------------------
  // Refresh
  // -------------------------------------------------------------------------

  it('does not let an in-flight owner A refresh overwrite owner B or settle B loading', async () => {
    const stockA = makeOwnerAStock();
    const refreshedA = { ...makeOwnerAStock(), name: 'Owner A Refreshed' };
    const stockB = makeOwnerBStock();
    mockGetAllStocks.mockResolvedValueOnce([stockA]);

    startVerifiedOwnerA();
    const { renders } = renderProbe();
    const ownerARender = await waitForStocks(renders, [stockA]);
    const savedOwnerARefresh = ownerARender.refreshStocks;

    const refreshLoad = deferred<Stock[]>();
    mockGetAllStocks.mockReturnValueOnce(refreshLoad.promise);
    const renderIndexBeforeRefresh = renders.length;
    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = savedOwnerARefresh();
    });
    await waitForReads(2);

    // A same-scope refresh clears the error without toggling loading.
    for (const refreshRender of renders.slice(renderIndexBeforeRefresh)) {
      expect(refreshRender.isLoading).toBe(false);
    }
    expect(latestRender(renders).isLoading).toBe(false);
    expect(latestRender(renders).error).toBeNull();

    const bLoad = deferred<Stock[]>();
    mockGetAllStocks.mockReturnValueOnce(bLoad.promise);
    act(() => {
      mockPublishAuth({ state: 'authenticated', userId: OWNER_B_USER_ID });
    });
    await waitForReads(3);

    await act(async () => {
      refreshLoad.resolve([refreshedA]);
      await refreshPromise;
    });

    const ownerBRenders = renders.filter(
      (probeRender) => probeRender.scope.userId === OWNER_B_USER_ID,
    );
    expect(ownerBRenders.length).toBeGreaterThan(0);
    for (const ownerBRender of ownerBRenders) {
      expect(ownerBRender.stocks).toEqual([]);
      expect(ownerBRender.error).toBeNull();
      expect(ownerBRender.isLoading).toBe(true);
    }
    expect(mockGetAllStocks).toHaveBeenCalledTimes(3);

    await act(async () => {
      bLoad.resolve([stockB]);
      await bLoad.promise;
    });

    const ownerBLoaded = await waitForStocks(renders, [stockB]);
    expect(ownerBLoaded.scope.userId).toBe(OWNER_B_USER_ID);
    for (const ownerBRender of renders.filter(
      (probeRender) => probeRender.scope.userId === OWNER_B_USER_ID,
    )) {
      expect(ownerBRender.stocks).not.toContainEqual(stockA);
      expect(ownerBRender.stocks).not.toContainEqual(refreshedA);
      expect(ownerBRender.error).toBeNull();
    }
  });

  it('does not publish or log an owner A refresh rejection that settles after lock', async () => {
    const stockA = makeOwnerAStock();
    mockGetAllStocks.mockResolvedValueOnce([stockA]);
    startVerifiedOwnerA();
    const { renders } = renderProbe();
    const ownerARender = await waitForStocks(renders, [stockA]);

    const refreshLoad = deferred<Stock[]>();
    mockGetAllStocks.mockReturnValueOnce(refreshLoad.promise);
    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = ownerARender.refreshStocks();
    });
    await waitForReads(2);

    act(() => {
      mockSetVerification(false);
    });
    await waitFor(() => {
      expect(latestRender(renders).scope.isScopeVerified).toBe(false);
      expect(latestRender(renders).stocks).toEqual([]);
    });

    await act(async () => {
      refreshLoad.reject(new Error('stale refresh failed'));
      await refreshPromise;
    });

    expect(latestRender(renders).error).toBeNull();
    expect(latestRender(renders).stocks).toEqual([]);
    expect(latestRender(renders).isLoading).toBe(false);
    expect(useStocksLogCalls()).toEqual([]);
    expect(mockGetAllStocks).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite the new scope error when an in-flight owner A refresh rejects', async () => {
    const stockA = makeOwnerAStock();
    mockGetAllStocks.mockResolvedValueOnce([stockA]);
    startVerifiedOwnerA();
    const { renders } = renderProbe();
    const ownerARender = await waitForStocks(renders, [stockA]);

    const refreshLoad = deferred<Stock[]>();
    mockGetAllStocks.mockReturnValueOnce(refreshLoad.promise);
    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = ownerARender.refreshStocks();
    });
    await waitForReads(2);

    const bLoad = deferred<Stock[]>();
    mockGetAllStocks.mockReturnValueOnce(bLoad.promise);
    act(() => {
      mockPublishAuth({ state: 'authenticated', userId: OWNER_B_USER_ID });
    });
    await waitForReads(3);

    await act(async () => {
      bLoad.reject(new Error('owner B load failed'));
      await bLoad.promise.catch(() => {});
    });
    const ownerBFailed = await waitForStockError(
      renders,
      'owner B load failed',
    );
    expect(ownerBFailed.scope.userId).toBe(OWNER_B_USER_ID);
    expect(useStocksLogCalls()).toHaveLength(1);

    await act(async () => {
      refreshLoad.reject(new Error('stale owner A refresh failed'));
      await refreshPromise;
    });

    expect(latestRender(renders).error).toBe('owner B load failed');
    expect(latestRender(renders).stocks).toEqual([]);
    expect(latestRender(renders).isLoading).toBe(false);
    expect(latestRender(renders).scope.userId).toBe(OWNER_B_USER_ID);
    expect(useStocksLogCalls()).toHaveLength(1);
    expect(mockGetAllStocks).toHaveBeenCalledTimes(3);
  });

  it('keeps a retained owner A refresh inert after invalidation without clearing the new error', async () => {
    const stockA = makeOwnerAStock();
    mockGetAllStocks.mockResolvedValueOnce([stockA]);
    startVerifiedOwnerA();
    const { renders } = renderProbe();
    const ownerARender = await waitForStocks(renders, [stockA]);
    const savedOwnerARefresh = ownerARender.refreshStocks;

    const bLoad = deferred<Stock[]>();
    mockGetAllStocks.mockReturnValueOnce(bLoad.promise);
    act(() => {
      mockPublishAuth({ state: 'authenticated', userId: OWNER_B_USER_ID });
    });
    await waitForReads(2);

    await act(async () => {
      bLoad.reject(new Error('owner B load failed'));
      await bLoad.promise.catch(() => {});
    });
    await waitForStockError(renders, 'owner B load failed');
    expect(useStocksLogCalls()).toHaveLength(1);

    await act(async () => {
      await expect(savedOwnerARefresh()).resolves.toBeUndefined();
    });

    expect(latestRender(renders).error).toBe('owner B load failed');
    expect(latestRender(renders).stocks).toEqual([]);
    expect(latestRender(renders).isLoading).toBe(false);
    expect(latestRender(renders).scope.userId).toBe(OWNER_B_USER_ID);
    expect(mockGetAllStocks).toHaveBeenCalledTimes(2);
    expect(useStocksLogCalls()).toHaveLength(1);
  });

  it('settles a current-scope refresh rejection with the non-Error fallback', async () => {
    const stockA = makeOwnerAStock();
    mockGetAllStocks
      .mockResolvedValueOnce([stockA])
      .mockRejectedValueOnce('refresh offline');
    startVerifiedOwnerA();
    const { renders } = renderProbe();
    const ownerARender = await waitForStocks(renders, [stockA]);

    await act(async () => {
      await expect(ownerARender.refreshStocks()).resolves.toBeUndefined();
    });

    const failed = latestRender(renders);
    expect(failed.error).toBe('Failed to load stocks');
    expect(failed.stocks).toEqual([stockA]);
    expect(failed.isLoading).toBe(false);
    expect(mockGetAllStocks).toHaveBeenCalledTimes(2);
    expect(useStocksLogCalls()).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '[useStocks] Error loading stocks:',
      'refresh offline',
    );
  });

  it.each([
    ['add', MATRIX_ADD_ID],
    ['update', undefined],
    ['delete', undefined],
    ['move', undefined],
  ] as const)(
    'lets %s succeed when its follow-up refresh rejects',
    async (method, expectedValue) => {
      const stockA = makeOwnerAStock();
      mockGetAllStocks
        .mockResolvedValueOnce([stockA])
        .mockRejectedValueOnce('refresh offline');
      startVerifiedOwnerA();
      const { renders } = renderProbe();
      const ownerARender = await waitForStocks(renders, [stockA]);

      switch (method) {
        case 'add':
          mockAddStock.mockResolvedValueOnce(MATRIX_ADD_ID);
          break;
        case 'update':
          mockUpdateStock.mockResolvedValueOnce(undefined);
          break;
        case 'delete':
          mockDeleteStock.mockResolvedValueOnce(undefined);
          break;
        case 'move':
          mockMoveStockTo.mockResolvedValueOnce(undefined);
          break;
      }

      let result!: PromiseSettledResult<unknown>;
      await act(async () => {
        [result] = await Promise.allSettled([
          invokeMutation(method, ownerARender),
        ]);
      });

      expect(result.status).toBe('fulfilled');
      if (result.status !== 'fulfilled') {
        throw new Error('expected mutation to succeed');
      }
      expect(result.value).toBe(expectedValue);

      const latest = latestRender(renders);
      expect(latest.stocks).toEqual([stockA]);
      expect(latest.error).toBe('Failed to load stocks');
      expect(latest.isLoading).toBe(false);
      expect(mockGetAllStocks).toHaveBeenCalledTimes(2);
      expect(mutationCallTotals()).toEqual(expectedMutationCalls(method));
      expectMutationArguments(method);
      expect(useStocksLogCalls()).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith(
        '[useStocks] Error loading stocks:',
        'refresh offline',
      );
    },
  );

  // -------------------------------------------------------------------------
  // Revocation and reverification
  // -------------------------------------------------------------------------

  it('re-reads for a fresh token on reverify while old callbacks stay inert', async () => {
    const stockA = makeOwnerAStock();
    const reloadedStock = {
      ...makeOwnerAStock(),
      name: 'Reverified Owner A',
    };
    mockGetAllStocks.mockResolvedValueOnce([stockA]);

    startVerifiedOwnerA();
    const { renders } = renderProbe();
    const ownerARender = await waitForStocks(renders, [stockA]);
    const generationBefore = ownerARender.scope.generation;
    const oldRefresh = ownerARender.refreshStocks;
    const oldAdd = ownerARender.addStock;
    const oldUpdate = ownerARender.updateStock;
    const oldDelete = ownerARender.deleteStock;
    const oldMove = ownerARender.moveStockTo;

    act(() => {
      mockSetVerification(false);
    });

    expect(mockGetBoundary().generation).toBe(generationBefore);
    expect(mockGetBoundary().isScopeVerified).toBe(false);
    expect(latestRender(renders).stocks).toEqual([]);
    expect(latestRender(renders).error).toBeNull();
    expect(mockGetAllStocks).toHaveBeenCalledTimes(1);

    const reverifiedLoad = deferred<Stock[]>();
    mockGetAllStocks.mockReturnValueOnce(reverifiedLoad.promise);
    act(() => {
      mockSetVerification(true);
    });
    await waitForReads(2);

    expect(mockGetBoundary().generation).toBe(generationBefore);
    const reverifiedPending = latestRender(renders);
    expect(reverifiedPending.scope.isScopeVerified).toBe(true);
    expect(reverifiedPending.stocks).toEqual([]);
    expect(reverifiedPending.error).toBeNull();
    expect(reverifiedPending.isLoading).toBe(true);

    // A new token, same generation: the old callbacks are still fenced.
    await act(async () => {
      await expect(oldRefresh()).resolves.toBeUndefined();
      await expect(oldAdd(MATRIX_DRAFT)).rejects.toThrow(
        'Local data is locked to another account',
      );
      await expect(oldUpdate(MATRIX_UPDATE)).rejects.toThrow(
        'Local data is locked to another account',
      );
      await expect(oldDelete(OWNER_A_STOCK_ID)).rejects.toThrow(
        'Local data is locked to another account',
      );
      await expect(
        oldMove(OWNER_A_STOCK_ID, MATRIX_TARGET_INDEX),
      ).resolves.toBeUndefined();
    });

    expect(mockGetAllStocks).toHaveBeenCalledTimes(2);
    expect(mutationCallTotals()).toEqual({
      add: 0,
      update: 0,
      delete: 0,
      move: 0,
    });

    await act(async () => {
      reverifiedLoad.reject(new Error('reverified load failed'));
      await reverifiedLoad.promise.catch(() => {});
    });
    const reverifiedFailed = await waitForStockError(
      renders,
      'reverified load failed',
    );
    expect(reverifiedFailed.scope.isScopeVerified).toBe(true);
    expect(useStocksLogCalls()).toHaveLength(1);

    // The old refresh must not clear the new scope's error either.
    await act(async () => {
      await expect(oldRefresh()).resolves.toBeUndefined();
      await expect(oldAdd(MATRIX_DRAFT)).rejects.toThrow(
        'Local data is locked to another account',
      );
      await expect(oldUpdate(MATRIX_UPDATE)).rejects.toThrow(
        'Local data is locked to another account',
      );
      await expect(oldDelete(OWNER_A_STOCK_ID)).rejects.toThrow(
        'Local data is locked to another account',
      );
      await expect(
        oldMove(OWNER_A_STOCK_ID, MATRIX_TARGET_INDEX),
      ).resolves.toBeUndefined();
    });

    expect(latestRender(renders).error).toBe('reverified load failed');
    expect(mockGetAllStocks).toHaveBeenCalledTimes(2);
    expect(mutationCallTotals()).toEqual({
      add: 0,
      update: 0,
      delete: 0,
      move: 0,
    });
    expect(useStocksLogCalls()).toHaveLength(1);

    // Current-scope callbacks for the new token keep working.
    const currentRender = latestRender(renders);
    mockGetAllStocks.mockResolvedValueOnce([reloadedStock]);
    await act(async () => {
      await currentRender.refreshStocks();
    });
    const refreshed = await waitForStocks(renders, [reloadedStock]);
    expect(refreshed.error).toBeNull();
    expect(mockGetAllStocks).toHaveBeenCalledTimes(3);

    mockAddStock.mockResolvedValueOnce('reverified-add-id');
    mockGetAllStocks.mockResolvedValueOnce([reloadedStock]);
    const currentAfterRefresh = latestRender(renders);
    await act(async () => {
      await expect(currentAfterRefresh.addStock(MATRIX_DRAFT)).resolves.toBe(
        'reverified-add-id',
      );
    });
    expect(mockAddStock).toHaveBeenCalledTimes(1);
    expect(mockAddStock).toHaveBeenCalledWith(MATRIX_DRAFT);
    expect(mockGetAllStocks).toHaveBeenCalledTimes(4);
    const afterAdd = await waitForStocks(renders, [reloadedStock]);
    expect(afterAdd.error).toBeNull();
  });

  // -------------------------------------------------------------------------
  // In-flight mutations
  // -------------------------------------------------------------------------

  it.each([
    ['add', 'resolve'],
    ['add', 'reject'],
    ['update', 'resolve'],
    ['update', 'reject'],
    ['delete', 'resolve'],
    ['delete', 'reject'],
    ['move', 'resolve'],
    ['move', 'reject'],
  ] as const)(
    'fences an in-flight %s %s after verification is revoked',
    async (method, outcome) => {
      const stockA = makeOwnerAStock();
      mockGetAllStocks.mockResolvedValueOnce([stockA]);
      startVerifiedOwnerA();
      const { renders } = renderProbe();
      const ownerARender = await waitForStocks(renders, [stockA]);

      const addDeferred = deferred<string>();
      const voidDeferred = deferred<void>();
      arrangeMutationDeferred(method, addDeferred, voidDeferred);

      const failure = new Error(`${method} adapter failed`);
      let settledPromise!: Promise<Array<PromiseSettledResult<unknown>>>;
      act(() => {
        settledPromise = Promise.allSettled([
          invokeMutation(method, ownerARender),
        ]);
        mockSetVerification(false);
      });

      await waitFor(() => {
        expect(latestRender(renders).scope.isScopeVerified).toBe(false);
        expect(latestRender(renders).stocks).toEqual([]);
      });
      expect(mutationCallTotals()).toEqual(expectedMutationCalls(method));
      expectMutationArguments(method);
      expect(mockGetAllStocks).toHaveBeenCalledTimes(1);

      let result!: PromiseSettledResult<unknown>;
      await act(async () => {
        settleMutationDeferred(
          method,
          outcome,
          addDeferred,
          voidDeferred,
          failure,
        );
        [result] = await settledPromise;
      });

      if (outcome === 'resolve' || method === 'move') {
        expect(result.status).toBe('fulfilled');
        if (result.status !== 'fulfilled') {
          throw new Error('expected mutation to settle successfully');
        }
        if (method === 'add') {
          expect(result.value).toBe(MATRIX_ADD_ID);
        } else {
          expect(result.value).toBeUndefined();
        }
      } else {
        expect(result.status).toBe('rejected');
        if (result.status !== 'rejected') {
          throw new Error('expected mutation to reject');
        }
        expect(result.reason).toBeInstanceOf(Error);
        expect(errorMessage(result.reason)).toBe(failure.message);
      }

      // Revocation already dropped the previous rows: a late adapter result
      // must not resurrect them, claim a rollback, or publish anything.
      const lockedRenders = renders.filter(
        (probeRender) => !probeRender.scope.isScopeVerified,
      );
      expect(lockedRenders.length).toBeGreaterThan(0);
      for (const lockedRender of lockedRenders) {
        expect(lockedRender.stocks).toEqual([]);
        expect(lockedRender.error).toBeNull();
        expect(lockedRender.isLoading).toBe(false);
      }
      expect(mockGetAllStocks).toHaveBeenCalledTimes(1);
      expect(mutationCallTotals()).toEqual(expectedMutationCalls(method));
      expect(useStocksLogCalls()).toEqual([]);
    },
  );

  // -------------------------------------------------------------------------
  // Current-scope behavior
  // -------------------------------------------------------------------------

  it('loads and refreshes nullable stock fields in verified disabled mode without a user', async () => {
    const stockA = makeOwnerAStock();
    const refreshedStock = {
      ...makeOwnerAStock(),
      name: 'Disabled Refreshed',
      sortOrder: 1,
    };
    mockGetAllStocks.mockResolvedValueOnce([stockA]);
    mockPublishAuth({ state: 'disabled' });
    mockSetVerification(true);

    const { renders } = renderProbe();
    const loaded = await waitForStocks(renders, [stockA]);

    expect(loaded.scope.authState).toBe('disabled');
    expect(loaded.scope.userId).toBeNull();
    expect(loaded.scope.isScopeVerified).toBe(true);
    expect(loaded.stocks).toEqual([makeOwnerAStock()]);
    expect(loaded.stocks[0]).not.toHaveProperty('type');
    expect(loaded.stocks[0]?.currentPrice).toBeNull();
    expect(loaded.stocks[0]?.priceUpdatedAt).toBeNull();
    expect(useStocksLogCalls()).toEqual([]);

    mockGetAllStocks.mockResolvedValueOnce([refreshedStock]);
    await act(async () => {
      await loaded.refreshStocks();
    });

    const afterRefresh = await waitForStocks(renders, [refreshedStock]);
    expect(afterRefresh.scope.authState).toBe('disabled');
    expect(mockGetAllStocks).toHaveBeenCalledTimes(2);
  });

  it('passes exact CRUD arguments and refreshes after each current-scope mutation', async () => {
    const stockA = makeOwnerAStock();
    const addedStock: Stock = {
      ...makeOwnerAStock(),
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      name: 'Added Stock',
      sortOrder: 1,
    };
    const updatedStockA: Stock = { ...stockA, name: 'Updated Stock' };
    const draft: StockDraft = {
      ticker: 'TEL',
      type: 'stock',
      name: 'Current Draft',
      currentPrice: 88.25,
      priceUpdatedAt: 4,
      sortOrder: 1,
    };
    const updatePatch: Partial<Stock> & Pick<Stock, 'id'> = {
      id: OWNER_A_STOCK_ID,
      name: 'Updated Stock',
    };
    const addId = 'current-add-id';

    mockGetAllStocks.mockResolvedValueOnce([stockA]);
    mockAddStock.mockResolvedValueOnce(addId);
    mockUpdateStock.mockResolvedValueOnce(undefined);
    mockDeleteStock.mockResolvedValueOnce(undefined);
    mockMoveStockTo.mockResolvedValueOnce(undefined);

    startVerifiedOwnerA();
    const { renders } = renderProbe();
    const loaded = await waitForStocks(renders, [stockA]);

    mockGetAllStocks.mockResolvedValueOnce([stockA, addedStock]);
    await act(async () => {
      await expect(loaded.addStock(draft)).resolves.toBe(addId);
    });
    expect(mockAddStock).toHaveBeenCalledTimes(1);
    expect(mockAddStock).toHaveBeenCalledWith(draft);
    expect(mockGetAllStocks).toHaveBeenCalledTimes(2);
    await waitForStocks(renders, [stockA, addedStock]);

    mockGetAllStocks.mockResolvedValueOnce([updatedStockA]);
    await act(async () => {
      await expect(loaded.updateStock(updatePatch)).resolves.toBeUndefined();
    });
    expect(mockUpdateStock).toHaveBeenCalledTimes(1);
    expect(mockUpdateStock).toHaveBeenCalledWith(updatePatch);
    expect(mockGetAllStocks).toHaveBeenCalledTimes(3);
    await waitForStocks(renders, [updatedStockA]);

    mockGetAllStocks.mockResolvedValueOnce([]);
    await act(async () => {
      await expect(
        loaded.deleteStock(OWNER_A_STOCK_ID),
      ).resolves.toBeUndefined();
    });
    expect(mockDeleteStock).toHaveBeenCalledTimes(1);
    expect(mockDeleteStock).toHaveBeenCalledWith(OWNER_A_STOCK_ID);
    expect(mockGetAllStocks).toHaveBeenCalledTimes(4);
    await waitForStocks(renders, []);

    mockGetAllStocks.mockResolvedValueOnce([stockA]);
    await act(async () => {
      await expect(
        loaded.moveStockTo(OWNER_A_STOCK_ID, MATRIX_TARGET_INDEX),
      ).resolves.toBeUndefined();
    });
    expect(mockMoveStockTo).toHaveBeenCalledTimes(1);
    expect(mockMoveStockTo).toHaveBeenCalledWith(
      OWNER_A_STOCK_ID,
      MATRIX_TARGET_INDEX,
    );
    expect(mockGetAllStocks).toHaveBeenCalledTimes(5);
    await waitForStocks(renders, [stockA]);
    expect(useStocksLogCalls()).toEqual([]);
  });

  it('does not restart the initial load when the same scope rerenders', async () => {
    const stockA = makeOwnerAStock();
    mockGetAllStocks.mockResolvedValueOnce([stockA]);
    startVerifiedOwnerA();

    const renders: ProbeRender[] = [];
    const view = render(
      <StocksProbe onRender={(probeRender) => renders.push(probeRender)} />,
    );
    await waitForStocks(renders, [stockA]);
    const renderCountBefore = renders.length;

    view.rerender(
      <StocksProbe onRender={(probeRender) => renders.push(probeRender)} />,
    );

    const rerendered = latestRender(renders);
    expect(renders.length).toBeGreaterThan(renderCountBefore);
    expect(rerendered.stocks).toEqual([stockA]);
    expect(rerendered.isLoading).toBe(false);
    expect(rerendered.error).toBeNull();
    expect(mockGetAllStocks).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['add', 'add adapter exploded'],
    ['update', 'update adapter exploded'],
    ['delete', 'delete adapter exploded'],
    ['move', 'move adapter exploded'],
  ] as const)(
    'publishes the current-scope error when %s fails',
    async (method, message) => {
      const stockA = makeOwnerAStock();
      mockGetAllStocks.mockResolvedValueOnce([stockA]);
      startVerifiedOwnerA();
      const { renders } = renderProbe();
      const loaded = await waitForStocks(renders, [stockA]);

      arrangeMutationFailure(method, new Error(message));

      let result!: PromiseSettledResult<unknown>;
      await act(async () => {
        [result] = await Promise.allSettled([
          invokeMutation(method, loaded),
        ]);
      });

      if (method === 'move') {
        expect(result.status).toBe('fulfilled');
        if (result.status !== 'fulfilled') {
          throw new Error('expected move to settle successfully');
        }
        expect(result.value).toBeUndefined();
      } else {
        expect(result.status).toBe('rejected');
        if (result.status !== 'rejected') {
          throw new Error('expected mutation to reject');
        }
        expect(result.reason).toBeInstanceOf(Error);
        expect(errorMessage(result.reason)).toBe(message);
      }

      const failed = latestRender(renders);
      expect(failed.error).toBe(message);
      expect(failed.stocks).toEqual([stockA]);
      expect(failed.isLoading).toBe(false);
      expect(mockGetAllStocks).toHaveBeenCalledTimes(1);
      expect(mutationCallTotals()).toEqual(expectedMutationCalls(method));
      expectMutationArguments(method);
      expect(useStocksLogCalls()).toEqual([]);
    },
  );
});
