// ============================================================
// MonthlySummaryCard.scope.test.tsx — verification-only scope
//
// Mounts the real MonthlySummaryCard. Only the external auth/transaction
// boundary, the categories hook, the IDB adapter, and Next Link are doubled.
//
// The transaction hook derives summaries directly from context rows, so a
// locked render must fail closed before any financial output. Budget targets,
// the editor draft, and category labels are bound to a render-time bucket with
// a unique token per scope transition. Month changes refetch targets without
// erasing drafts or resetting the scope.
// ============================================================

import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  type RenderResult,
} from '@testing-library/react';
import type { Account, BudgetTarget, Category, MonthYear, Transaction } from '@/types';
import { publishAuthIdentity } from '@/lib/auth-scope';
import { getAllBudgetTargets, setBudgetTarget } from '@/lib/idb';
import { formatCurrency } from '@/lib/utils';
import { MonthlySummaryCard } from './MonthlySummaryCard';

// ---------------------------------------------------------------------------
// Boundary double
// ---------------------------------------------------------------------------

type MockAuthState = 'authenticated' | 'unauthenticated' | 'loading' | 'disabled';

interface MockBoundary {
  readonly authState: MockAuthState;
  readonly userId: string | null;
  readonly generation: number;
  readonly isScopeVerified: boolean;
  readonly isLoading: boolean;
  readonly monthYear: MonthYear;
  readonly transactions: Transaction[];
  readonly accounts: Account[];
}

let mockBoundary: MockBoundary = {
  authState: 'loading',
  userId: null,
  generation: 0,
  isScopeVerified: false,
  isLoading: false,
  monthYear: { year: 2026, month: 0 },
  transactions: [],
  accounts: [],
};

const mockGetCategoriesByType = jest.fn();
const mockSetMonthYear = jest.fn();
const mockFormatCurrency = (amount: number): string =>
  new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);

jest.mock('@/context/TransactionContext', () => ({
  useTransactionContext: () => ({
    transactions: mockBoundary.transactions,
    accounts: mockBoundary.accounts,
    categories: [],
    isLoading: mockBoundary.isLoading,
    error: null,
    isScopeVerified: mockBoundary.isScopeVerified,
    monthYear: mockBoundary.monthYear,
    setMonthYear: mockSetMonthYear,
    hideAmounts: false,
    toggleHideAmounts: jest.fn(),
  }),
  formatAmount: (amount: number, hidden: boolean) =>
    hidden ? '****' : mockFormatCurrency(amount),
}));

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    state: mockBoundary.authState,
    user: mockBoundary.userId === null ? null : { id: mockBoundary.userId },
    authGeneration: mockBoundary.generation,
  }),
}));

jest.mock('@/hooks/useCategories', () => ({
  useCategories: () => ({ getCategoriesByType: mockGetCategoriesByType }),
}));

jest.mock('@/lib/idb', () => ({
  getAllBudgetTargets: jest.fn(),
  setBudgetTarget: jest.fn(),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: 'a',
}));

const mockGetAllBudgetTargets = jest.mocked(getAllBudgetTargets);
const mockSetBudgetTarget = jest.mocked(setBudgetTarget);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER_A_USER_ID = 'summary-owner-a';
const OWNER_A_ACCOUNT_NAME = 'Owner A Checking';
const OWNER_A_TRANSACTION_ID = 'summary-owner-a-transaction';
const OWNER_A_TRANSACTION_AMOUNT = 50;
const OWNER_A_MONTHLY_TARGET = 250.75;
const OWNER_A_GLOBAL_TARGET = 123.45;
const RENT_GLOBAL_TARGET = 55.55;

const CATEGORIES: Category[] = [
  {
    id: 'category-food',
    name: 'Food',
    type: 'expense',
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'category-rent',
    name: 'Rent',
    type: 'expense',
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'category-salary',
    name: 'Salary',
    type: 'income',
    createdAt: 1,
    updatedAt: 1,
  },
];

const ACCOUNT: Account = {
  id: 'summary-account-a',
  name: OWNER_A_ACCOUNT_NAME,
  startingBalance: 1_000,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

const TRANSACTION: Transaction = {
  id: OWNER_A_TRANSACTION_ID,
  amount: OWNER_A_TRANSACTION_AMOUNT,
  date: '2026-01-10',
  type: 'expense',
  category: 'Food',
  fromAccount: ACCOUNT.id,
  toAccount: null,
  description: 'Owner A groceries',
  createdAt: 1,
  updatedAt: 1,
};

function budgetTarget(
  category: string,
  month: string | null,
  amount: number,
): BudgetTarget {
  return {
    id: `${category}-${month ?? 'global'}`,
    category,
    month,
    amount,
    createdAt: 1,
    updatedAt: 1,
  };
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
    isLoading: false,
    monthYear: { year: 2026, month: 0 },
    transactions: [TRANSACTION],
    accounts: [ACCOUNT],
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

function renderSummary(onRender: React.ProfilerOnRenderCallback) {
  return render(
    <React.Profiler id="summary-scope" onRender={onRender}>
      <MonthlySummaryCard />
    </React.Profiler>,
  );
}

function rerenderSummary(
  view: RenderResult,
  onRender: React.ProfilerOnRenderCallback,
): void {
  view.rerender(
    <React.Profiler id="summary-scope" onRender={onRender}>
      <MonthlySummaryCard />
    </React.Profiler>,
  );
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

// ---------------------------------------------------------------------------
// Regression
// ---------------------------------------------------------------------------

describe('MonthlySummaryCard verification-only scope', () => {
  beforeEach(() => {
    publishAuthIdentity({ state: 'unauthenticated' });
    mockBoundary = {
      authState: 'unauthenticated',
      userId: null,
      generation: 0,
      isScopeVerified: false,
      isLoading: false,
      monthYear: { year: 2026, month: 0 },
      transactions: [],
      accounts: [],
    };

    mockGetCategoriesByType.mockReset();
    mockGetCategoriesByType.mockImplementation((type: string) =>
      CATEGORIES.filter((category) => category.type === type),
    );
    mockSetMonthYear.mockReset();

    mockGetAllBudgetTargets.mockReset();
    mockSetBudgetTarget.mockReset();
    mockSetBudgetTarget.mockResolvedValue(undefined);
    mockGetAllBudgetTargets.mockResolvedValue([
      budgetTarget('Food', '2026-01', OWNER_A_MONTHLY_TARGET),
      budgetTarget('Rent', null, RENT_GLOBAL_TARGET),
    ]);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders no prior-owner summaries, targets, labels, or drafts on the first locked commit', async () => {
    startVerifiedOwnerA();

    const { commits, onRender } = createCommitRecorder();
    const view = renderSummary(onRender);

    await waitFor(() => {
      expect(screen.getByText(OWNER_A_ACCOUNT_NAME)).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText(formatCurrency(OWNER_A_MONTHLY_TARGET))).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Edit Budgets' }));
    const draftInput = document.querySelector('input[type="number"]');
    if (!(draftInput instanceof HTMLInputElement)) {
      throw new Error('budget draft input not found');
    }
    fireEvent.change(draftInput, { target: { value: '999' } });
    expect(draftInput.value).toBe('999');

    const readsBeforeLock = mockGetAllBudgetTargets.mock.calls.length;
    const commitCountBeforeLock = commits.length;

    await act(async () => {
      setVerified(false);
      rerenderSummary(view, onRender);
    });

    const lockedCommits = commits
      .slice(commitCountBeforeLock)
      .filter((commit) => !commit.isScopeVerified);
    expect(lockedCommits.length).toBeGreaterThan(0);

    for (const commit of lockedCommits) {
      expect(commit.text).not.toContain(OWNER_A_ACCOUNT_NAME);
      expect(commit.text).not.toContain('Food');
      expect(commit.text).not.toContain('Rent');
      expect(commit.text).not.toContain('Budget Targets');
      expect(commit.text).not.toContain('Edit Budgets');
      expect(commit.text).not.toContain(formatCurrency(OWNER_A_MONTHLY_TARGET));
      expect(commit.text).not.toContain('999');
      expect(commit.inputValues).toHaveLength(0);
    }

    expect(mockGetAllBudgetTargets).toHaveBeenCalledTimes(readsBeforeLock);
  });

  it('performs no budget read and renders no financial content while locked', async () => {
    mockBoundary = {
      ...mockBoundary,
      authState: 'authenticated',
      userId: OWNER_A_USER_ID,
      generation: publishAuthIdentity({
        state: 'authenticated',
        userId: OWNER_A_USER_ID,
      }),
      isScopeVerified: false,
      transactions: [TRANSACTION],
      accounts: [ACCOUNT],
    };

    const { commits, onRender } = createCommitRecorder();
    renderSummary(onRender);
    await flushAsync();

    expect(mockGetAllBudgetTargets).not.toHaveBeenCalled();
    expect(commits.length).toBeGreaterThan(0);
    for (const commit of commits) {
      expect(commit.text).not.toContain(OWNER_A_ACCOUNT_NAME);
      expect(commit.text).not.toContain('Food');
      expect(commit.text).not.toContain(formatCurrency(OWNER_A_TRANSACTION_AMOUNT));
    }
  });

  it('never publishes a stale budget read after verification is revoked', async () => {
    startVerifiedOwnerA();
    const read = deferred<BudgetTarget[]>();
    mockGetAllBudgetTargets.mockReturnValueOnce(read.promise);

    const { onRender } = createCommitRecorder();
    const view = renderSummary(onRender);

    await waitFor(() => {
      expect(mockGetAllBudgetTargets).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      setVerified(false);
      rerenderSummary(view, onRender);
    });

    await act(async () => {
      read.resolve([budgetTarget('Food', '2026-01', OWNER_A_MONTHLY_TARGET)]);
      await read.promise;
    });

    expect(screen.queryByText(formatCurrency(OWNER_A_MONTHLY_TARGET))).toBeNull();
    expect(screen.queryByText('Food')).toBeNull();
  });

  it('gives reverified scope a fresh token so an old read cannot publish into it', async () => {
    startVerifiedOwnerA();
    const staleRead = deferred<BudgetTarget[]>();
    const freshRead = deferred<BudgetTarget[]>();
    mockGetAllBudgetTargets
      .mockReturnValueOnce(staleRead.promise)
      .mockReturnValueOnce(freshRead.promise);

    const { onRender } = createCommitRecorder();
    const view = renderSummary(onRender);

    await waitFor(() => {
      expect(mockGetAllBudgetTargets).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      setVerified(false);
      rerenderSummary(view, onRender);
    });
    await act(async () => {
      setVerified(true);
      rerenderSummary(view, onRender);
    });

    await waitFor(() => {
      expect(mockGetAllBudgetTargets).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      freshRead.resolve([budgetTarget('Food', '2026-01', OWNER_A_MONTHLY_TARGET)]);
      await freshRead.promise;
    });
    await waitFor(() => {
      expect(
        screen.getAllByText(formatCurrency(OWNER_A_MONTHLY_TARGET)).length,
      ).toBeGreaterThan(0);
    });

    await act(async () => {
      staleRead.resolve([budgetTarget('Food', '2026-01', 777.25)]);
      await staleRead.promise;
    });
    expect(
      screen.getAllByText(formatCurrency(OWNER_A_MONTHLY_TARGET)).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(formatCurrency(777.25))).toBeNull();
  });

  it('prefers a month override (including zero) over the global target', async () => {
    startVerifiedOwnerA();
    mockGetAllBudgetTargets.mockResolvedValue([
      budgetTarget('Food', '2026-01', 0),
      budgetTarget('Food', null, OWNER_A_GLOBAL_TARGET),
      budgetTarget('Rent', null, RENT_GLOBAL_TARGET),
    ]);

    const { onRender } = createCommitRecorder();
    renderSummary(onRender);

    await waitFor(() => {
      expect(screen.getByText('Food')).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.getAllByText(formatCurrency(RENT_GLOBAL_TARGET)).length).toBeGreaterThan(0);
    });

    const foodRow = screen.getByText('Food').closest('tr') as HTMLTableRowElement | null;
    const rentRow = screen.getByText('Rent').closest('tr') as HTMLTableRowElement | null;
    if (!foodRow || !rentRow) {
      throw new Error('expense breakdown rows not found');
    }

    const foodCells = within(foodRow).getAllByRole('cell');
    const rentCells = within(rentRow).getAllByRole('cell');
    expect(foodCells[1].textContent).toBe(formatCurrency(0));
    expect(rentCells[1].textContent).toBe(formatCurrency(RENT_GLOBAL_TARGET));
    expect(screen.queryByText(formatCurrency(OWNER_A_GLOBAL_TARGET))).toBeNull();
  });

  it('keeps budget drafts and editor state across a month change', async () => {
    startVerifiedOwnerA();

    const { onRender } = createCommitRecorder();
    const view = renderSummary(onRender);

    await waitFor(() => {
      expect(screen.getByText(formatCurrency(OWNER_A_MONTHLY_TARGET))).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Edit Budgets' }));
    const draftInput = document.querySelector('input[type="number"]');
    if (!(draftInput instanceof HTMLInputElement)) {
      throw new Error('budget draft input not found');
    }
    fireEvent.change(draftInput, { target: { value: '321' } });
    expect(draftInput.value).toBe('321');

    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(mockSetMonthYear).toHaveBeenCalledTimes(1);

    const nextMonth = mockSetMonthYear.mock.calls[0][0] as MonthYear;
    mockBoundary = { ...mockBoundary, monthYear: nextMonth };
    mockGetAllBudgetTargets.mockResolvedValue([
      budgetTarget('Food', '2026-02', 88.5),
      budgetTarget('Rent', null, RENT_GLOBAL_TARGET),
    ]);
    rerenderSummary(view, onRender);

    await waitFor(() => {
      expect(mockGetAllBudgetTargets).toHaveBeenCalledTimes(2);
    });

    const nextDraftInput = document.querySelector('input[type="number"]');
    if (!(nextDraftInput instanceof HTMLInputElement)) {
      throw new Error('budget draft input disappeared after month change');
    }
    expect(nextDraftInput.value).toBe('321');
    expect(screen.getByText('Budget Targets')).toBeTruthy();
  });

  it('stops a budget save continuation after verification is revoked', async () => {
    startVerifiedOwnerA();

    const saveDeferred = deferred<void>();
    mockSetBudgetTarget.mockReturnValueOnce(saveDeferred.promise);

    const { onRender } = createCommitRecorder();
    const view = renderSummary(onRender);

    await waitFor(() => {
      expect(screen.getByText(formatCurrency(OWNER_A_MONTHLY_TARGET))).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Edit Budgets' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Budgets' }));

    await waitFor(() => {
      expect(mockSetBudgetTarget).toHaveBeenCalledTimes(1);
    });
    const readsBeforeLock = mockGetAllBudgetTargets.mock.calls.length;

    await act(async () => {
      setVerified(false);
      rerenderSummary(view, onRender);
    });

    await act(async () => {
      saveDeferred.resolve();
      await saveDeferred.promise;
    });

    expect(mockSetBudgetTarget).toHaveBeenCalledTimes(1);
    expect(mockGetAllBudgetTargets).toHaveBeenCalledTimes(readsBeforeLock);
    expect(screen.queryByText('Budget Targets')).toBeNull();
  });
});
