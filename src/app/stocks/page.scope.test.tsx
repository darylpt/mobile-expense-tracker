// ============================================================
// page.scope.test.tsx — Stocks page verification-only scope
//
// Renders the real StocksPage under a React.Profiler. Only the external
// auth/transaction boundary, the useStocks hook boundary, IDB/price adapters,
// and the layout Header are doubled. React rendering and the page's bucket
// implementation stay real.
//
// Verification is an independent dimension of the boundary snapshot: revoking
// it must not change the authenticated identity or the shared auth generation.
// The first committed render after revocation must already be empty, and old
// reads, price-refresh continuations, clipboard continuations, and retained
// event handlers must not publish into the new scope.
// ============================================================

import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from '@testing-library/react';
import type { Dividend, Stock, StockTransaction } from '@/types';
import { publishAuthIdentity } from '@/lib/auth-scope';
import {
  addDividend,
  addStockTransaction,
  deleteDividend,
  deleteStockTransaction,
  getAllDividends,
  getAllStockTransactions,
  updateDividend,
  updateStockTransaction,
} from '@/lib/idb';
import { refreshAllPrices, type StockPriceResult } from '@/lib/stock-prices';
import StocksPage from './page';

// ---------------------------------------------------------------------------
// Boundary double
// ---------------------------------------------------------------------------

type MockAuthState = 'authenticated' | 'unauthenticated' | 'loading' | 'disabled';

interface MockBoundary {
  readonly authState: MockAuthState;
  readonly userId: string | null;
  readonly generation: number;
  readonly isScopeVerified: boolean;
}

let mockBoundary: MockBoundary = {
  authState: 'loading',
  userId: null,
  generation: 0,
  isScopeVerified: false,
};

interface MockStocksState {
  stocks: Stock[];
  isLoading: boolean;
  refreshStocks: jest.Mock;
  addStock: jest.Mock;
  updateStock: jest.Mock;
  deleteStock: jest.Mock;
  moveStockTo: jest.Mock;
}

const mockStocksState: MockStocksState = {
  stocks: [],
  isLoading: false,
  refreshStocks: jest.fn(),
  addStock: jest.fn(),
  updateStock: jest.fn(),
  deleteStock: jest.fn(),
  moveStockTo: jest.fn(),
};

jest.mock('@/context/TransactionContext', () => ({
  useTransactionContext: () => ({ isScopeVerified: mockBoundary.isScopeVerified }),
}));

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    state: mockBoundary.authState,
    user: mockBoundary.userId === null ? null : { id: mockBoundary.userId },
    authGeneration: mockBoundary.generation,
  }),
}));

jest.mock('@/hooks/useStocks', () => ({
  useStocks: () => mockStocksState,
}));

jest.mock('@/lib/idb', () => ({
  getAllStockTransactions: jest.fn(),
  getAllDividends: jest.fn(),
  addStockTransaction: jest.fn(),
  deleteStockTransaction: jest.fn(),
  updateStockTransaction: jest.fn(),
  addDividend: jest.fn(),
  deleteDividend: jest.fn(),
  updateDividend: jest.fn(),
}));

jest.mock('@/lib/stock-prices', () => ({
  refreshAllPrices: jest.fn(),
}));

jest.mock('@/components/layout/Header', () => ({
  Header: () => null,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: 'a',
}));

const mockGetAllStockTransactions = jest.mocked(getAllStockTransactions);
const mockGetAllDividends = jest.mocked(getAllDividends);
const mockAddStockTransaction = jest.mocked(addStockTransaction);
const mockDeleteStockTransaction = jest.mocked(deleteStockTransaction);
const mockUpdateStockTransaction = jest.mocked(updateStockTransaction);
const mockAddDividend = jest.mocked(addDividend);
const mockDeleteDividend = jest.mocked(deleteDividend);
const mockUpdateDividend = jest.mocked(updateDividend);
const mockRefreshAllPrices = jest.mocked(refreshAllPrices);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER_A_USER_ID = 'stocks-owner-a';
const STOCK: Stock = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ticker: 'BDO',
  name: 'Owner A Bank',
  currentPrice: 100,
  priceUpdatedAt: 1,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

function makeTransaction(id: string, shares: number): StockTransaction {
  return {
    id,
    stockId: STOCK.id,
    date: '2026-01-01',
    type: 'buy',
    shares,
    pricePerShare: 100,
    fees: 0,
    totalAmount: shares * 100,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeDividend(id: string): Dividend {
  return {
    id,
    stockId: STOCK.id,
    exDate: '2026-01-02',
    payDate: '2026-01-03',
    type: 'cash',
    qty: 1,
    rate: 5,
    amount: 5,
    fee: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

const OWNER_A_TRANSACTION = makeTransaction('owner-a-transaction', 10);
const OWNER_A_DIVIDEND = makeDividend('owner-a-dividend');
const STALE_TRANSACTION = makeTransaction('stale-transaction', 10);
const FRESH_TRANSACTION = makeTransaction('fresh-transaction', 20);

// ---------------------------------------------------------------------------
// Commit recorder and deferred helpers
// ---------------------------------------------------------------------------

interface CommitSnapshot {
  readonly phase: string;
  readonly isScopeVerified: boolean;
  readonly generation: number;
  readonly text: string;
  readonly inputValues: readonly string[];
}

function createCommitRecorder(): {
  readonly commits: CommitSnapshot[];
  readonly onRender: React.ProfilerOnRenderCallback;
} {
  const commits: CommitSnapshot[] = [];
  const onRender: React.ProfilerOnRenderCallback = (_id, phase) => {
    commits.push({
      phase,
      isScopeVerified: mockBoundary.isScopeVerified,
      generation: mockBoundary.generation,
      text: document.body.textContent ?? '',
      inputValues: Array.from(
        document.querySelectorAll('input'),
        (input) => input.value,
      ),
    });
  };
  return { commits, onRender };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
}

function renderPage(onRender: React.ProfilerOnRenderCallback) {
  return render(
    <React.Profiler id="stocks-page-scope" onRender={onRender}>
      <StocksPage />
    </React.Profiler>,
  );
}

function rerenderPage(
  view: RenderResult,
  onRender: React.ProfilerOnRenderCallback,
): void {
  view.rerender(
    <React.Profiler id="stocks-page-scope" onRender={onRender}>
      <StocksPage />
    </React.Profiler>,
  );
}

function startVerifiedOwnerA(): number {
  const generation = publishAuthIdentity({
    state: 'authenticated',
    userId: OWNER_A_USER_ID,
  });
  mockBoundary = {
    authState: 'authenticated',
    userId: OWNER_A_USER_ID,
    generation,
    isScopeVerified: true,
  };
  return generation;
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

// ---------------------------------------------------------------------------
// Regression
// ---------------------------------------------------------------------------

describe('StocksPage verification-only scope', () => {
  beforeEach(() => {
    publishAuthIdentity({ state: 'unauthenticated' });
    mockBoundary = {
      authState: 'unauthenticated',
      userId: null,
      generation: 0,
      isScopeVerified: false,
    };
    mockStocksState.stocks = [STOCK];
    mockStocksState.isLoading = false;
    mockStocksState.refreshStocks.mockReset();
    mockStocksState.addStock.mockReset();
    mockStocksState.updateStock.mockReset();
    mockStocksState.deleteStock.mockReset();
    mockStocksState.moveStockTo.mockReset();

    mockGetAllStockTransactions.mockReset();
    mockGetAllDividends.mockReset();
    mockAddStockTransaction.mockReset();
    mockDeleteStockTransaction.mockReset();
    mockUpdateStockTransaction.mockReset();
    mockAddDividend.mockReset();
    mockDeleteDividend.mockReset();
    mockUpdateDividend.mockReset();
    mockRefreshAllPrices.mockReset();

    mockGetAllStockTransactions.mockResolvedValue([]);
    mockGetAllDividends.mockResolvedValue([OWNER_A_DIVIDEND]);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders no prior-owner financial data on the first commit after verification is revoked', async () => {
    startVerifiedOwnerA();
    mockGetAllStockTransactions.mockResolvedValue([OWNER_A_TRANSACTION]);

    const { commits, onRender } = createCommitRecorder();
    const view = renderPage(onRender);

    await waitFor(() => {
      expect(screen.queryAllByText(STOCK.ticker).length).toBeGreaterThan(0);
    });
    expect(screen.queryAllByText(STOCK.name).length).toBeGreaterThan(0);

    const readsBeforeLock = mockGetAllStockTransactions.mock.calls.length;
    const commitCountBeforeLock = commits.length;

    await act(async () => {
      mockBoundary = { ...mockBoundary, isScopeVerified: false };
      rerenderPage(view, onRender);
    });

    const lockedCommits = commits
      .slice(commitCountBeforeLock)
      .filter((commit) => !commit.isScopeVerified);
    expect(lockedCommits.length).toBeGreaterThan(0);

    for (const commit of lockedCommits) {
      expect(commit.generation).toBe(mockBoundary.generation);
      expect(commit.text).not.toContain(STOCK.ticker);
      expect(commit.text).not.toContain(STOCK.name);
      expect(commit.text).not.toContain('Portfolio');
      expect(commit.text).not.toContain('Refresh Prices');
      expect(commit.inputValues.join(' ')).not.toContain('10.0000');
    }

    expect(mockGetAllStockTransactions).toHaveBeenCalledTimes(readsBeforeLock);
  });

  it('does not start local reads while unverified or while stocks are loading', async () => {
    mockBoundary = {
      authState: 'authenticated',
      userId: OWNER_A_USER_ID,
      generation: publishAuthIdentity({
        state: 'authenticated',
        userId: OWNER_A_USER_ID,
      }),
      isScopeVerified: false,
    };

    const first = renderPage(() => undefined);
    await flushPromises();
    expect(mockGetAllStockTransactions).not.toHaveBeenCalled();
    expect(mockGetAllDividends).not.toHaveBeenCalled();
    first.unmount();

    mockStocksState.isLoading = true;
    mockBoundary = { ...mockBoundary, isScopeVerified: true };
    const { onRender } = createCommitRecorder();
    const second = renderPage(onRender);
    await flushPromises();
    expect(mockGetAllStockTransactions).not.toHaveBeenCalled();

    mockStocksState.isLoading = false;
    rerenderPage(second, onRender);
    await waitFor(() => {
      expect(mockGetAllStockTransactions).toHaveBeenCalledTimes(1);
    });
  });

  it('never publishes a stale initial read after verification is revoked', async () => {
    startVerifiedOwnerA();
    const read = deferred<StockTransaction[]>();
    mockGetAllStockTransactions.mockReturnValueOnce(read.promise);

    const { onRender } = createCommitRecorder();
    const view = renderPage(onRender);

    await waitFor(() => {
      expect(mockGetAllStockTransactions).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      mockBoundary = { ...mockBoundary, isScopeVerified: false };
      rerenderPage(view, onRender);
    });

    await act(async () => {
      read.resolve([STALE_TRANSACTION]);
      await read.promise;
    });

    expect(screen.queryAllByText(STOCK.ticker)).toHaveLength(0);
    expect(screen.queryAllByText('10.0000')).toHaveLength(0);
  });

  it('gives reverified scope a fresh token so an old read cannot publish into it', async () => {
    startVerifiedOwnerA();
    const staleRead = deferred<StockTransaction[]>();
    const freshRead = deferred<StockTransaction[]>();
    mockGetAllStockTransactions
      .mockReturnValueOnce(staleRead.promise)
      .mockReturnValueOnce(freshRead.promise);

    const { onRender } = createCommitRecorder();
    const view = renderPage(onRender);

    await waitFor(() => {
      expect(mockGetAllStockTransactions).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      mockBoundary = { ...mockBoundary, isScopeVerified: false };
      rerenderPage(view, onRender);
    });
    await act(async () => {
      mockBoundary = { ...mockBoundary, isScopeVerified: true };
      rerenderPage(view, onRender);
    });

    await waitFor(() => {
      expect(mockGetAllStockTransactions).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      freshRead.resolve([FRESH_TRANSACTION]);
      await freshRead.promise;
    });
    await waitFor(() => {
      expect(screen.queryAllByText('20.0000').length).toBeGreaterThan(0);
    });

    // The first read belonged to the pre-lock scope and must stay inert even
    // after the new scope has published its own rows.
    await act(async () => {
      staleRead.resolve([STALE_TRANSACTION]);
      await staleRead.promise;
    });
    expect(screen.queryAllByText('20.0000').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('10.0000')).toHaveLength(0);
  });

  it('fences a retained sync-complete handler on the shared generation', async () => {
    startVerifiedOwnerA();
    mockGetAllStockTransactions.mockResolvedValue([OWNER_A_TRANSACTION]);

    const { onRender } = createCommitRecorder();
    renderPage(onRender);

    await waitFor(() => {
      expect(screen.queryAllByText(STOCK.ticker).length).toBeGreaterThan(0);
    });

    const readsBefore = mockGetAllStockTransactions.mock.calls.length;
    mockStocksState.refreshStocks.mockClear();

    await act(async () => {
      // Publish a new shared identity without rerendering the page, leaving
      // the old listener and callbacks retained for one more turn.
      publishAuthIdentity({
        state: 'authenticated',
        userId: 'stocks-owner-b',
      });
      window.dispatchEvent(new Event('sync-complete'));
      await Promise.resolve();
    });

    expect(mockStocksState.refreshStocks).not.toHaveBeenCalled();
    expect(mockGetAllStockTransactions).toHaveBeenCalledTimes(readsBefore);
  });

  it('stops a price-refresh continuation after verification is revoked', async () => {
    startVerifiedOwnerA();
    mockGetAllStockTransactions.mockResolvedValue([OWNER_A_TRANSACTION]);

    const { onRender } = createCommitRecorder();
    const view = renderPage(onRender);

    await waitFor(() => {
      expect(screen.queryAllByText(STOCK.ticker).length).toBeGreaterThan(0);
    });

    const refresh = deferred<StockPriceResult[]>();
    mockRefreshAllPrices.mockReturnValueOnce(refresh.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Prices' }));

    await waitFor(() => {
      expect(mockRefreshAllPrices).toHaveBeenCalledTimes(1);
    });

    const suppliedIsCurrent = mockRefreshAllPrices.mock.calls[0][0];
    expect(suppliedIsCurrent()).toBe(true);

    const readsBeforeLock = mockGetAllStockTransactions.mock.calls.length;
    mockStocksState.refreshStocks.mockClear();

    await act(async () => {
      mockBoundary = { ...mockBoundary, isScopeVerified: false };
      rerenderPage(view, onRender);
    });

    // Revocation keeps the same identity generation; only verification moved.
    expect(suppliedIsCurrent()).toBe(false);

    await act(async () => {
      refresh.resolve([
        { ticker: STOCK.ticker, price: null, currency: null, error: 'offline' },
      ]);
      await refresh.promise;
    });

    expect(screen.queryByText(/Could not fetch any prices/)).toBeNull();
    expect(mockStocksState.refreshStocks).not.toHaveBeenCalled();
    expect(mockGetAllStockTransactions).toHaveBeenCalledTimes(readsBeforeLock);
  });

  it('keeps a supplied refresh predicate false after re-verification or identity publication', async () => {
    startVerifiedOwnerA();
    mockGetAllStockTransactions.mockResolvedValue([OWNER_A_TRANSACTION]);

    const { onRender } = createCommitRecorder();
    const view = renderPage(onRender);

    await waitFor(() => {
      expect(screen.queryAllByText(STOCK.ticker).length).toBeGreaterThan(0);
    });

    const refresh = deferred<StockPriceResult[]>();
    mockRefreshAllPrices.mockReturnValueOnce(refresh.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Prices' }));

    await waitFor(() => {
      expect(mockRefreshAllPrices).toHaveBeenCalledTimes(1);
    });
    const suppliedIsCurrent = mockRefreshAllPrices.mock.calls[0][0];
    expect(suppliedIsCurrent()).toBe(true);

    await act(async () => {
      mockBoundary = { ...mockBoundary, isScopeVerified: false };
      rerenderPage(view, onRender);
    });
    expect(suppliedIsCurrent()).toBe(false);

    // Re-verifying the same identity is a new page scope instance. The old
    // refresh work must not regain authority even though identity is equal.
    await act(async () => {
      mockBoundary = { ...mockBoundary, isScopeVerified: true };
      rerenderPage(view, onRender);
    });
    expect(suppliedIsCurrent()).toBe(false);

    // A changed shared identity revokes the captured generation before the
    // page rerenders.
    await act(async () => {
      publishAuthIdentity({
        state: 'authenticated',
        userId: 'stocks-owner-b',
      });
    });
    expect(suppliedIsCurrent()).toBe(false);

    await act(async () => {
      refresh.resolve([
        { ticker: STOCK.ticker, price: 148.5, currency: 'PHP' },
      ]);
      await refresh.promise;
    });

    expect(screen.queryByText('All prices updated.')).toBeNull();
  });

  it('falsifies the supplied refresh predicate on unmount', async () => {
    startVerifiedOwnerA();
    mockGetAllStockTransactions.mockResolvedValue([OWNER_A_TRANSACTION]);

    const { onRender } = createCommitRecorder();
    const view = renderPage(onRender);

    await waitFor(() => {
      expect(screen.queryAllByText(STOCK.ticker).length).toBeGreaterThan(0);
    });

    const refresh = deferred<StockPriceResult[]>();
    mockRefreshAllPrices.mockReturnValueOnce(refresh.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Prices' }));

    await waitFor(() => {
      expect(mockRefreshAllPrices).toHaveBeenCalledTimes(1);
    });
    const suppliedIsCurrent = mockRefreshAllPrices.mock.calls[0][0];
    expect(suppliedIsCurrent()).toBe(true);

    view.unmount();
    expect(suppliedIsCurrent()).toBe(false);

    await act(async () => {
      refresh.resolve([
        { ticker: STOCK.ticker, price: 148.5, currency: 'PHP' },
      ]);
      await refresh.promise;
    });
  });

  it('supplies a live predicate in verified Supabase-disabled mode', async () => {
    mockBoundary = {
      authState: 'disabled',
      userId: null,
      generation: publishAuthIdentity({ state: 'disabled' }),
      isScopeVerified: true,
    };
    mockGetAllStockTransactions.mockResolvedValue([OWNER_A_TRANSACTION]);
    mockGetAllDividends.mockResolvedValue([]);

    const { onRender } = createCommitRecorder();
    renderPage(onRender);

    await waitFor(() => {
      expect(screen.queryAllByText(STOCK.ticker).length).toBeGreaterThan(0);
    });

    const refresh = deferred<StockPriceResult[]>();
    mockRefreshAllPrices.mockReturnValueOnce(refresh.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Prices' }));

    await waitFor(() => {
      expect(mockRefreshAllPrices).toHaveBeenCalledTimes(1);
    });
    const suppliedIsCurrent = mockRefreshAllPrices.mock.calls[0][0];
    expect(suppliedIsCurrent()).toBe(true);

    await act(async () => {
      refresh.resolve([
        { ticker: STOCK.ticker, price: 148.5, currency: 'PHP' },
      ]);
      await refresh.promise;
    });

    expect(suppliedIsCurrent()).toBe(true);
    await waitFor(() => {
      expect(screen.getByText('All prices updated.')).toBeTruthy();
    });
  });

  it('stops a clipboard continuation after verification is revoked', async () => {
    startVerifiedOwnerA();
    mockGetAllStockTransactions.mockResolvedValue([OWNER_A_TRANSACTION]);

    const writeText = jest.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const clipboardWrite = deferred<void>();
    writeText.mockReturnValueOnce(clipboardWrite.promise);

    const { onRender } = createCommitRecorder();
    const view = renderPage(onRender);

    await waitFor(() => {
      expect(screen.queryAllByText(STOCK.ticker).length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole('button', { name: /Copy Summary/ }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      mockBoundary = { ...mockBoundary, isScopeVerified: false };
      rerenderPage(view, onRender);
    });

    await act(async () => {
      clipboardWrite.resolve();
      await clipboardWrite.promise;
    });

    expect(screen.queryByText('Portfolio summary copied!')).toBeNull();
  });
});
