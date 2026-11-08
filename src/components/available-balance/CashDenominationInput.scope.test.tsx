// ============================================================
// CashDenominationInput.scope.test.tsx — verification/date scope
//
// Mounts the real CashDenominationInput. Only the external auth/transaction
// boundary and the IDB adapter are doubled.
//
// Verification is independent of the authenticated identity. A locked render
// must already show zero counts and a zero total, and must not report the
// previous owner's total. Loads and saves are fenced by a unique token per
// scope/date transition, so D1 -> D2 -> D1 cannot revive an old D1 read.
// ============================================================

import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { CashDenomination } from '@/types';
import { publishAuthIdentity } from '@/lib/auth-scope';
import {
  addCashDenomination,
  deleteCashDenominationsByDate,
  getAllCashDenominations,
} from '@/lib/idb';
import { formatCurrency } from '@/lib/utils';
import { CashDenominationInput } from './CashDenominationInput';

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

jest.mock('@/lib/idb', () => ({
  getAllCashDenominations: jest.fn(),
  addCashDenomination: jest.fn(),
  deleteCashDenominationsByDate: jest.fn(),
}));

const mockGetAllCashDenominations = jest.mocked(getAllCashDenominations);
const mockAddCashDenomination = jest.mocked(addCashDenomination);
const mockDeleteCashDenominationsByDate = jest.mocked(
  deleteCashDenominationsByDate,
);

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const OWNER_A_USER_ID = 'cash-owner-a';
const DATE_ONE = '2026-01-01';
const DATE_TWO = '2026-01-02';

function record(date: string, denomination: number, count: number): CashDenomination {
  return { id: `${date}-${denomination}`, date, denomination, count };
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

function setVerified(isScopeVerified: boolean): void {
  mockBoundary = { ...mockBoundary, isScopeVerified };
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

function thousandInput(): HTMLInputElement {
  const input = document.getElementById('denom-1000');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('denomination input not found');
  }
  return input;
}

interface CommitSnapshot {
  readonly isScopeVerified: boolean;
  readonly text: string;
  readonly inputValues: readonly string[];
}

function createCommitRecorder(): {
  readonly commits: CommitSnapshot[];
  readonly onRender: React.ProfilerOnRenderCallback;
} {
  const commits: CommitSnapshot[] = [];
  const onRender: React.ProfilerOnRenderCallback = () => {
    commits.push({
      isScopeVerified: mockBoundary.isScopeVerified,
      text: document.body.textContent ?? '',
      inputValues: Array.from(
        document.querySelectorAll('input'),
        (input) => input.value,
      ),
    });
  };
  return { commits, onRender };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

// ---------------------------------------------------------------------------
// Regression
// ---------------------------------------------------------------------------

describe('CashDenominationInput scope and date isolation', () => {
  beforeEach(() => {
    publishAuthIdentity({ state: 'unauthenticated' });
    mockBoundary = {
      authState: 'unauthenticated',
      userId: null,
      generation: 0,
      isScopeVerified: false,
    };
    mockGetAllCashDenominations.mockReset();
    mockAddCashDenomination.mockReset();
    mockDeleteCashDenominationsByDate.mockReset();
    mockDeleteCashDenominationsByDate.mockResolvedValue(undefined);
    mockAddCashDenomination.mockResolvedValue('saved-id');
  });

  afterEach(() => {
    cleanup();
  });

  it('loads date-filtered counts and uses the latest callback ref', async () => {
    startVerifiedOwnerA();
    const read = deferred<CashDenomination[]>();
    mockGetAllCashDenominations.mockReturnValueOnce(read.promise);

    const firstCallback = jest.fn();
    const secondCallback = jest.fn();
    const view = render(
      <CashDenominationInput date={DATE_ONE} onTotalChange={firstCallback} />,
    );

    await waitFor(() => {
      expect(mockGetAllCashDenominations).toHaveBeenCalledTimes(1);
    });

    view.rerender(
      <CashDenominationInput date={DATE_ONE} onTotalChange={secondCallback} />,
    );

    await act(async () => {
      read.resolve([
        record(DATE_ONE, 1000, 2),
        record(DATE_TWO, 1000, 9),
      ]);
      await read.promise;
    });

    await waitFor(() => {
      expect(thousandInput().value).toBe('2');
    });
    expect(secondCallback).toHaveBeenLastCalledWith(2000);
    expect(firstCallback).not.toHaveBeenCalledWith(2000);
  });

  it('does not start an IDB read while the scope is unverified', async () => {
    mockBoundary = {
      authState: 'authenticated',
      userId: OWNER_A_USER_ID,
      generation: publishAuthIdentity({
        state: 'authenticated',
        userId: OWNER_A_USER_ID,
      }),
      isScopeVerified: false,
    };

    render(<CashDenominationInput date={DATE_ONE} />);
    await flushPromises();

    expect(mockGetAllCashDenominations).not.toHaveBeenCalled();
    expect(thousandInput().value).toBe('0');
  });

  it('shows zero counts and total on the first commit after verification is revoked', async () => {
    startVerifiedOwnerA();
    mockGetAllCashDenominations.mockResolvedValue([record(DATE_ONE, 1000, 2)]);

    const onTotalChange = jest.fn();
    const { commits, onRender } = createCommitRecorder();
    const view = render(
      <React.Profiler id="cash-scope" onRender={onRender}>
        <CashDenominationInput date={DATE_ONE} onTotalChange={onTotalChange} />
      </React.Profiler>,
    );

    await waitFor(() => {
      expect(thousandInput().value).toBe('2');
    });
    expect(screen.getByText(formatCurrency(2000))).toBeTruthy();

    onTotalChange.mockClear();
    const commitCountBeforeLock = commits.length;

    await act(async () => {
      setVerified(false);
      view.rerender(
        <React.Profiler id="cash-scope" onRender={onRender}>
          <CashDenominationInput date={DATE_ONE} onTotalChange={onTotalChange} />
        </React.Profiler>,
      );
    });

    const lockedCommits = commits
      .slice(commitCountBeforeLock)
      .filter((commit) => !commit.isScopeVerified);
    expect(lockedCommits.length).toBeGreaterThan(0);

    for (const commit of lockedCommits) {
      expect(commit.text).not.toContain(formatCurrency(2000));
      expect(commit.inputValues.every((value) => value === '0')).toBe(true);
    }

    expect(thousandInput().value).toBe('0');
    expect(onTotalChange).not.toHaveBeenCalledWith(2000);
  });

  it('never publishes a stale read after verification is revoked', async () => {
    startVerifiedOwnerA();
    const read = deferred<CashDenomination[]>();
    mockGetAllCashDenominations.mockReturnValueOnce(read.promise);

    const onTotalChange = jest.fn();
    const view = render(
      <CashDenominationInput date={DATE_ONE} onTotalChange={onTotalChange} />,
    );

    await waitFor(() => {
      expect(mockGetAllCashDenominations).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      setVerified(false);
      view.rerender(
        <CashDenominationInput date={DATE_ONE} onTotalChange={onTotalChange} />,
      );
    });

    await act(async () => {
      read.resolve([record(DATE_ONE, 1000, 4)]);
      await read.promise;
    });

    expect(thousandInput().value).toBe('0');
    expect(onTotalChange).not.toHaveBeenCalledWith(4000);
    expect(screen.queryByText(formatCurrency(4000))).toBeNull();
  });

  it('fences D1 -> D2 -> D1 so an old D1 read cannot publish into the new D1 scope', async () => {
    startVerifiedOwnerA();
    const firstD1Read = deferred<CashDenomination[]>();
    const d2Read = deferred<CashDenomination[]>();
    const secondD1Read = deferred<CashDenomination[]>();
    mockGetAllCashDenominations
      .mockReturnValueOnce(firstD1Read.promise)
      .mockReturnValueOnce(d2Read.promise)
      .mockReturnValueOnce(secondD1Read.promise);

    const onTotalChange = jest.fn();
    const view = render(
      <CashDenominationInput date={DATE_ONE} onTotalChange={onTotalChange} />,
    );

    await waitFor(() => {
      expect(mockGetAllCashDenominations).toHaveBeenCalledTimes(1);
    });

    view.rerender(
      <CashDenominationInput date={DATE_TWO} onTotalChange={onTotalChange} />,
    );
    await waitFor(() => {
      expect(mockGetAllCashDenominations).toHaveBeenCalledTimes(2);
    });

    view.rerender(
      <CashDenominationInput date={DATE_ONE} onTotalChange={onTotalChange} />,
    );
    await waitFor(() => {
      expect(mockGetAllCashDenominations).toHaveBeenCalledTimes(3);
    });

    // The first D1 load belongs to an earlier token and must stay inert even
    // though the current date is D1 again.
    await act(async () => {
      firstD1Read.resolve([record(DATE_ONE, 1000, 1)]);
      await firstD1Read.promise;
    });
    expect(thousandInput().value).toBe('0');
    expect(onTotalChange).not.toHaveBeenCalledWith(1000);

    // A D2 load must not leak into the current D1 scope either.
    await act(async () => {
      d2Read.resolve([record(DATE_TWO, 1000, 2)]);
      await d2Read.promise;
    });
    expect(thousandInput().value).toBe('0');

    await act(async () => {
      secondD1Read.resolve([record(DATE_ONE, 1000, 3)]);
      await secondD1Read.promise;
    });
    await waitFor(() => {
      expect(thousandInput().value).toBe('3');
    });
    expect(onTotalChange).toHaveBeenLastCalledWith(3000);
  });

  it('loads for verified local-only auth', async () => {
    publishAuthIdentity({ state: 'disabled' });
    mockBoundary = {
      authState: 'disabled',
      userId: null,
      generation: publishAuthIdentity({ state: 'disabled' }),
      isScopeVerified: true,
    };
    mockGetAllCashDenominations.mockResolvedValue([record(DATE_ONE, 1000, 2)]);

    render(<CashDenominationInput date={DATE_ONE} />);

    await waitFor(() => {
      expect(thousandInput().value).toBe('2');
    });
    expect(mockGetAllCashDenominations).toHaveBeenCalledTimes(1);
  });

  it('stops a save continuation after verification is revoked', async () => {
    startVerifiedOwnerA();
    mockGetAllCashDenominations.mockResolvedValue([record(DATE_ONE, 1000, 2)]);

    const deleteDeferred = deferred<void>();
    mockDeleteCashDenominationsByDate.mockReturnValueOnce(deleteDeferred.promise);

    const view = render(<CashDenominationInput date={DATE_ONE} />);

    await waitFor(() => {
      expect(thousandInput().value).toBe('2');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save Snapshot' }));
    await waitFor(() => {
      expect(mockDeleteCashDenominationsByDate).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      setVerified(false);
      view.rerender(<CashDenominationInput date={DATE_ONE} />);
    });

    await act(async () => {
      deleteDeferred.resolve();
      await deleteDeferred.promise;
    });

    expect(mockAddCashDenomination).not.toHaveBeenCalled();
    expect(screen.queryByText('Saved!')).toBeNull();
    expect(mockDeleteCashDenominationsByDate).toHaveBeenCalledWith(DATE_ONE);
  });
});
