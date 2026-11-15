// ============================================================
// page.scope.test.tsx — Available Balance verification-only scope
//
// Renders the real AvailableBalancePage under a React.Profiler. Only the
// external transaction/auth boundary, the page's IDB snapshot adapter, and
// the two layout children are doubled. Verification is an independent
// dimension of the external-store snapshot: revoking it must not change the
// authenticated identity, generation, context rows, or loading state.
//
// The regression under test: the page keeps owner A's snapshots in local
// state until a passive effect clears them, and it renders reconciliation
// rows from transaction-context data even while the scope is locked. The
// first committed DOM after verification is revoked must therefore contain no
// owner A financial data. Snapshots are captured from Profiler onRender,
// before passive effects can clear state.
// ============================================================

import React from 'react';
import type * as ReactNamespace from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Account, Transaction } from '@/types';
import {
  getAuthGeneration,
  publishAuthIdentity,
  type AuthIdentity,
} from '@/lib/auth-scope';
import { getBalanceSnapshots, upsertBalanceSnapshot } from '@/lib/idb';
import { calculateExpectedBalances } from '@/lib/reconciliation';
import { formatCurrency, getToday } from '@/lib/utils';
import AvailableBalancePage from './page';

// ---------------------------------------------------------------------------
// External-store boundary double
//
// Auth identity (state/user/generation), verification, and loading are
// separate dimensions of the same snapshot. Identity transitions publish
// through the real auth-scope module, so the generation mirrored here is the
// one the page and getAuthGeneration observe. Flipping verification leaves the
// authenticated owner, generation, rows, and loading state untouched.
// ---------------------------------------------------------------------------

type MockAuthState = 'authenticated' | 'unauthenticated' | 'loading' | 'disabled';

interface MockBoundary {
  readonly authState: MockAuthState;
  readonly userId: string | null;
  readonly generation: number;
  readonly isScopeVerified: boolean;
  readonly isLoading: boolean;
  readonly accounts: Account[];
  readonly transactions: Transaction[];
}

const mockBoundaryListeners = new Set<() => void>();

let mockBoundary: MockBoundary = {
  authState: 'loading',
  userId: null,
  generation: 0,
  isScopeVerified: false,
  isLoading: true,
  accounts: [],
  transactions: [],
};

function mockGetBoundary(): MockBoundary {
  return mockBoundary;
}

interface MockAuthSnapshot {
  readonly state: MockAuthState;
  readonly user: { readonly id: string } | null;
  readonly authGeneration: number;
}

/** The exact object shape the authenticated page reads from useAuth(). */
function mockGetAuthSnapshot(
  boundary: MockBoundary = mockGetBoundary(),
): MockAuthSnapshot {
  return {
    state: boundary.authState,
    user:
      boundary.authState === 'authenticated' && boundary.userId
        ? { id: boundary.userId }
        : null,
    authGeneration: boundary.generation,
  };
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

/** Flips only transaction-context verification; every other dimension stays. */
function mockSetVerification(isScopeVerified: boolean): void {
  mockBoundary = { ...mockBoundary, isScopeVerified };
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
      return {
        transactions: boundary.transactions,
        accounts: boundary.accounts,
        categories: [],
        isLoading: boundary.isLoading,
        isScopeVerified: boundary.isScopeVerified,
        error: null,
      };
    },
  };
});

// ---------------------------------------------------------------------------
// Auth boundary double
//
// The planned page fence reads authenticated identity/generation from
// useAuth(). It shares the transaction-context store, so verification can be
// revoked without moving the authenticated owner or generation.
// ---------------------------------------------------------------------------

jest.mock('@/context/AuthContext', () => {
  const ReactModule = jest.requireActual<typeof ReactNamespace>('react');
  return {
    useAuth: () => {
      const boundary = ReactModule.useSyncExternalStore(
        mockSubscribeBoundary,
        mockGetBoundary,
        mockGetBoundary,
      );
      return mockGetAuthSnapshot(boundary);
    },
  };
});
let mockCashTotalChange: ((total: number) => void) | null = null;

jest.mock('@/lib/idb', () => ({
  getBalanceSnapshots: jest.fn(),
  upsertBalanceSnapshot: jest.fn(),
}));

jest.mock('@/components/layout/Header', () => ({
  Header: () => null,
}));

jest.mock('@/components/available-balance/CashDenominationInput', () => ({
  CashDenominationInput: ({
    onTotalChange,
  }: {
    onTotalChange: (total: number) => void;
  }) => {
    mockCashTotalChange = onTotalChange;
    return null;
  },
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: 'a',
}));

const mockGetBalanceSnapshots = jest.mocked(getBalanceSnapshots);
const mockUpsertBalanceSnapshot = jest.mocked(upsertBalanceSnapshot);

// ---------------------------------------------------------------------------
// Owner A fixtures
// ---------------------------------------------------------------------------

const OWNER_A_USER_ID = 'scope-owner-a';
let ownerAGeneration = 0;

/**
 * Publishes Owner A through the real auth-scope module and returns the
 * generation it actually issued for this identity transition.
 */
function publishOwnerAIdentity(): number {
  ownerAGeneration = publishAuthIdentity({
    state: 'authenticated',
    userId: OWNER_A_USER_ID,
  });
  return ownerAGeneration;
}

const OWNER_A_ACCOUNT_ID = 'owner-a-checking-account';
const OWNER_A_ACCOUNT_NAME = 'Owner A Alpha Checking';
const OWNER_A_STARTING_BALANCE = 10_000;
const OWNER_A_TRANSACTION_ID = 'owner-a-reconciliation-transaction';
const OWNER_A_TRANSACTION_AMOUNT = 1_250;
const OWNER_A_CURRENT_VALUE = 8_125.5;
const OWNER_A_UPDATED_AT = new Date(2026, 0, 15, 12, 0, 0).getTime();
const OWNER_A_SPLIT_ID = 'owner-a-split-alpha';
const OWNER_A_SPLIT_LABEL = 'Owner A Split Alpha';
const OWNER_A_UPDATED_DATE = new Date(OWNER_A_UPDATED_AT).toLocaleDateString(
  'en-US',
  { month: 'short', day: 'numeric' },
);

const OWNER_A_ACCOUNT: Account = {
  id: OWNER_A_ACCOUNT_ID,
  name: OWNER_A_ACCOUNT_NAME,
  startingBalance: OWNER_A_STARTING_BALANCE,
  sortOrder: 0,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};
const mockCashAccount: Account = {
  id: 'cash',
  name: 'Cash',
  startingBalance: 0,
  sortOrder: 1,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const OWNER_A_TRANSACTION: Transaction = {
  id: OWNER_A_TRANSACTION_ID,
  amount: OWNER_A_TRANSACTION_AMOUNT,
  date: '2020-01-01',
  type: 'expense',
  category: 'Reconciliation',
  fromAccount: OWNER_A_ACCOUNT_ID,
  toAccount: null,
  description: 'Owner A reconciliation expense',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const mockOwnerAAccounts: Account[] = [OWNER_A_ACCOUNT];
const mockOwnerATransactions: Transaction[] = [OWNER_A_TRANSACTION];

type BalanceSnapshotMap = Awaited<ReturnType<typeof getBalanceSnapshots>>;

const mockOwnerASnapshots: BalanceSnapshotMap = {
  [OWNER_A_ACCOUNT_ID]: {
    value: OWNER_A_CURRENT_VALUE,
    updatedAt: OWNER_A_UPDATED_AT,
    useSubSplit: true,
    subSplits: [
      {
        id: OWNER_A_SPLIT_ID,
        label: OWNER_A_SPLIT_LABEL,
        amount: OWNER_A_CURRENT_VALUE,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Owner B fixtures
//
// B reuses A's account id on purpose. Only the values, labels, timestamps and
// context rows distinguish the two scopes.
// ---------------------------------------------------------------------------

const OWNER_B_USER_ID = 'scope-owner-b';
const OWNER_B_ACCOUNT_NAME = 'Owner B Beta Checking';
const OWNER_B_STARTING_BALANCE = 5_000;
const OWNER_B_TRANSACTION_ID = 'owner-b-reconciliation-transaction';
const OWNER_B_TRANSACTION_AMOUNT = 375;
const OWNER_B_CURRENT_VALUE = 4_321.75;
const OWNER_B_UPDATED_AT = new Date(2026, 1, 20, 9, 30, 0).getTime();
const OWNER_B_SPLIT_ID = 'owner-b-split-beta';
const OWNER_B_SPLIT_LABEL = 'Owner B Split Beta';
const OWNER_B_UPDATED_DATE = new Date(OWNER_B_UPDATED_AT).toLocaleDateString(
  'en-US',
  { month: 'short', day: 'numeric' },
);

const mockOwnerBAccounts: Account[] = [
  {
    id: OWNER_A_ACCOUNT_ID,
    name: OWNER_B_ACCOUNT_NAME,
    startingBalance: OWNER_B_STARTING_BALANCE,
    sortOrder: 0,
    createdAt: 1_700_100_000_000,
    updatedAt: 1_700_100_000_000,
  },
];

const mockOwnerBTransactions: Transaction[] = [
  {
    id: OWNER_B_TRANSACTION_ID,
    amount: OWNER_B_TRANSACTION_AMOUNT,
    date: '2020-01-01',
    type: 'expense',
    category: 'Reconciliation',
    fromAccount: OWNER_A_ACCOUNT_ID,
    toAccount: null,
    description: 'Owner B reconciliation expense',
    createdAt: 1_700_100_000_000,
    updatedAt: 1_700_100_000_000,
  },
];

const mockOwnerBSnapshots: BalanceSnapshotMap = {
  [OWNER_A_ACCOUNT_ID]: {
    value: OWNER_B_CURRENT_VALUE,
    updatedAt: OWNER_B_UPDATED_AT,
    useSubSplit: true,
    subSplits: [
      {
        id: OWNER_B_SPLIT_ID,
        label: OWNER_B_SPLIT_LABEL,
        amount: OWNER_B_CURRENT_VALUE,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Legacy localStorage migration fixture
// ---------------------------------------------------------------------------

const LEGACY_STORAGE_KEY = 'current_balances';
const LEGACY_FIRST_ACCOUNT_ID = 'legacy-first-account';
const LEGACY_SECOND_ACCOUNT_ID = 'legacy-second-account';
const LEGACY_FIRST_VALUE = 111.25;
const LEGACY_SECOND_VALUE = 222.5;
const LEGACY_BALANCES_JSON = JSON.stringify({
  [LEGACY_FIRST_ACCOUNT_ID]: {
    value: LEGACY_FIRST_VALUE,
    updatedAt: 1_600_000_000_000,
  },
  [LEGACY_SECOND_ACCOUNT_ID]: {
    value: LEGACY_SECOND_VALUE,
    updatedAt: 1_600_000_100_000,
  },
});

const OWNER_A_EXPECTED_AMOUNT = calculateExpectedBalances(
  mockOwnerATransactions,
  mockOwnerAAccounts,
  getToday(),
)[0].expected;
const OWNER_A_DIFFERENCE_AMOUNT = Math.abs(
  OWNER_A_EXPECTED_AMOUNT - OWNER_A_CURRENT_VALUE,
);

// ---------------------------------------------------------------------------
// Committed DOM snapshots
// ---------------------------------------------------------------------------

interface CommitSnapshot {
  readonly phase: string;
  readonly authState: MockAuthState;
  readonly userId: string | null;
  readonly generation: number;
  readonly isScopeVerified: boolean;
  readonly isLoading: boolean;
  readonly accounts: Account[];
  readonly transactions: Transaction[];
  readonly text: string;
  readonly inputValues: readonly string[];
}

function isOwnerASourceCommit(commit: CommitSnapshot): boolean {
  return (
    commit.isScopeVerified &&
    commit.text.includes(OWNER_A_ACCOUNT_NAME) &&
    commit.text.includes(formatCurrency(OWNER_A_CURRENT_VALUE)) &&
    commit.text.includes(OWNER_A_UPDATED_DATE) &&
    commit.inputValues.includes(OWNER_A_SPLIT_LABEL) &&
    commit.inputValues.includes(String(OWNER_A_CURRENT_VALUE))
  );
}

function expectNoOwnerAFinancialData(
  commit: CommitSnapshot,
  expectedAmount: number,
  differenceAmount: number,
): void {
  expect(commit.text).not.toContain(OWNER_A_ACCOUNT_NAME);
  expect(commit.text).not.toContain(formatCurrency(OWNER_A_CURRENT_VALUE));
  expect(commit.text).not.toContain(formatCurrency(expectedAmount));
  expect(commit.text).not.toContain(formatCurrency(differenceAmount));
  expect(commit.text).not.toContain(OWNER_A_UPDATED_DATE);
  expect(commit.text).not.toContain(OWNER_A_SPLIT_LABEL);
  expect(commit.text).not.toContain(String(OWNER_A_CURRENT_VALUE));
  expect(commit.inputValues).not.toContain(OWNER_A_SPLIT_LABEL);
  expect(commit.inputValues).not.toContain(String(OWNER_A_CURRENT_VALUE));
}

function expectNoOwnerAFinancialDataIn(
  commits: readonly CommitSnapshot[],
): void {
  for (const commit of commits) {
    expectNoOwnerAFinancialData(
      commit,
      OWNER_A_EXPECTED_AMOUNT,
      OWNER_A_DIFFERENCE_AMOUNT,
    );
  }
}

/**
 * Snapshot-only assertion for legitimate owner A relogin renders, where the
 * context-derived expected row may be visible but the prior local snapshot
 * value, timestamp and split label must not be.
 */
function expectNoOwnerACurrentSnapshot(commit: CommitSnapshot): void {
  expect(commit.text).not.toContain(formatCurrency(OWNER_A_CURRENT_VALUE));
  expect(commit.text).not.toContain(OWNER_A_UPDATED_DATE);
  expect(commit.text).not.toContain(OWNER_A_SPLIT_LABEL);
  expect(commit.text).not.toContain(String(OWNER_A_CURRENT_VALUE));
  expect(commit.inputValues).not.toContain(OWNER_A_SPLIT_LABEL);
  expect(commit.inputValues).not.toContain(String(OWNER_A_CURRENT_VALUE));
}
function getInputValue(element: HTMLElement): string {
  if (element instanceof HTMLInputElement) return element.value;
  throw new Error('Expected an input element');
}

/**
 * Captures every owner A financial control currently mounted in either
 * responsive copy: rendered text, all input values, and the split controls.
 */
function captureOwnerAVisibleState(): {
  readonly text: string;
  readonly inputValues: readonly string[];
  readonly currentBalanceValues: readonly string[];
  readonly subSplitLabels: readonly string[];
  readonly subSplitAmounts: readonly string[];
  readonly subSplitControlCounts: {
    readonly disable: number;
    readonly enable: number;
    readonly add: number;
    readonly remove: number;
  };
} {
  return {
    text: document.body.textContent ?? '',
    inputValues: Array.from(document.querySelectorAll('input'), getInputValue),
    currentBalanceValues: screen
      .queryAllByLabelText(`Current balance for ${OWNER_A_ACCOUNT_NAME}`)
      .map(getInputValue),
    subSplitLabels: screen
      .queryAllByLabelText('Sub-split label')
      .map(getInputValue),
    subSplitAmounts: screen
      .queryAllByLabelText('Sub-split amount')
      .map(getInputValue),
    subSplitControlCounts: {
      disable: screen.queryAllByRole('button', { name: 'Disable sub-split' })
        .length,
      enable: screen.queryAllByRole('button', { name: 'Enable sub-split' })
        .length,
      add: screen.queryAllByRole('button', { name: '+ Add sub-split' }).length,
      remove: screen.queryAllByRole('button', { name: 'Remove sub-split' })
        .length,
    },
  };
}

function isOwnerBSourceCommit(commit: CommitSnapshot): boolean {
  return (
    commit.isScopeVerified &&
    commit.userId === OWNER_B_USER_ID &&
    commit.text.includes(OWNER_B_ACCOUNT_NAME) &&
    commit.text.includes(formatCurrency(OWNER_B_CURRENT_VALUE)) &&
    commit.text.includes(OWNER_B_UPDATED_DATE) &&
    commit.inputValues.includes(OWNER_B_SPLIT_LABEL) &&
    commit.inputValues.includes(String(OWNER_B_CURRENT_VALUE))
  );
}

function createCommitRecorder(): {
  readonly commits: CommitSnapshot[];
  readonly onRender: React.ProfilerOnRenderCallback;
} {
  const commits: CommitSnapshot[] = [];
  const onRender: React.ProfilerOnRenderCallback = (_id, phase) => {
    const boundary = mockGetBoundary();
    commits.push({
      phase,
      authState: boundary.authState,
      userId: boundary.userId,
      generation: boundary.generation,
      isScopeVerified: boundary.isScopeVerified,
      isLoading: boundary.isLoading,
      accounts: boundary.accounts,
      transactions: boundary.transactions,
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
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type DeferredOutcome = 'resolve' | 'reject';

async function settleDeferred<T>(
  pending: Deferred<T>,
  outcome: DeferredOutcome,
  value: T,
  failure: Error,
): Promise<void> {
  await act(async () => {
    if (outcome === 'resolve') pending.resolve(value);
    else pending.reject(failure);
    await pending.promise.catch(() => {});
  });
}

type BoundaryOverrides = Partial<
  Pick<
    MockBoundary,
    'isLoading' | 'isScopeVerified' | 'accounts' | 'transactions'
  >
>;

/** Publishes a real identity and mirrors it into the external-store double. */
function mockPublishIdentity(
  identity: AuthIdentity,
  overrides: BoundaryOverrides = {},
): number {
  const generation = publishAuthIdentity(identity);
  mockBoundary = {
    authState: identity.state,
    userId: identity.state === 'authenticated' ? identity.userId : null,
    generation,
    isScopeVerified: false,
    isLoading: false,
    accounts: [],
    transactions: [],
    ...overrides,
  };
  mockNotifyBoundary();
  return generation;
}

// ---------------------------------------------------------------------------
// Regression
// ---------------------------------------------------------------------------

describe('AvailableBalancePage verification-only scope', () => {
  beforeEach(() => {
    mockBoundaryListeners.clear();
    // Marker absent: the legacy localStorage migration must not be involved.
    window.localStorage.removeItem('current_balances');

    const generation = publishOwnerAIdentity();

    mockBoundary = {
      authState: 'authenticated',
      userId: OWNER_A_USER_ID,
      generation,
      isScopeVerified: true,
      isLoading: false,
      accounts: mockOwnerAAccounts,
      transactions: mockOwnerATransactions,
    };

    mockGetBalanceSnapshots.mockReset();
    mockUpsertBalanceSnapshot.mockReset();
    mockGetBalanceSnapshots.mockResolvedValue(mockOwnerASnapshots);
    mockUpsertBalanceSnapshot.mockResolvedValue(undefined);
    mockCashTotalChange = null;
  });

  afterEach(() => {
    cleanup();
    mockCashTotalChange = null;
    window.localStorage.removeItem('current_balances');
  });

  it('does not render owner A financial data on the first commit after verification is revoked', async () => {
    expect(window.localStorage.getItem('current_balances')).toBeNull();

    const expectedAmount = calculateExpectedBalances(
      mockOwnerATransactions,
      mockOwnerAAccounts,
      getToday(),
    )[0].expected;
    const differenceAmount = Math.abs(expectedAmount - OWNER_A_CURRENT_VALUE);

    const commits: CommitSnapshot[] = [];
    const recordCommit: React.ProfilerOnRenderCallback = (_id, phase) => {
      const boundary = mockGetBoundary();
      commits.push({
        phase,
        authState: boundary.authState,
        userId: boundary.userId,
        generation: boundary.generation,
        isScopeVerified: boundary.isScopeVerified,
        isLoading: boundary.isLoading,
        accounts: boundary.accounts,
        transactions: boundary.transactions,
        text: document.body.textContent ?? '',
        inputValues: Array.from(
          document.querySelectorAll('input'),
          (input) => input.value,
        ),
      });
    };

    render(
      <React.Profiler id="available-balance-scope" onRender={recordCommit}>
        <AvailableBalancePage />
      </React.Profiler>,
    );

    // Owner A's source snapshot must be visible before invalidation, proving
    // the locked-commit assertion below is about real prior financial data.
    await waitFor(() => {
      expect(commits.some(isOwnerASourceCommit)).toBe(true);
    });

    // The initial persistence pass is the only write allowed before the lock.
    await waitFor(() => {
      expect(mockUpsertBalanceSnapshot).toHaveBeenCalled();
    });

    const readsBeforeLock = mockGetBalanceSnapshots.mock.calls.length;
    const upsertsBeforeLock = mockUpsertBalanceSnapshot.mock.calls.length;
    const boundaryBeforeLock = mockGetBoundary();
    const authBeforeLock = mockGetAuthSnapshot(boundaryBeforeLock);
    const generationBeforeLock = getAuthGeneration();

    expect(readsBeforeLock).toBe(1);
    expect(upsertsBeforeLock).toBeGreaterThan(0);
    expect(boundaryBeforeLock.isScopeVerified).toBe(true);
    expect(boundaryBeforeLock.authState).toBe('authenticated');
    expect(boundaryBeforeLock.userId).toBe(OWNER_A_USER_ID);
    expect(boundaryBeforeLock.generation).toBe(ownerAGeneration);
    expect(generationBeforeLock).toBe(ownerAGeneration);
    expect(authBeforeLock).toEqual({
      state: 'authenticated',
      user: { id: OWNER_A_USER_ID },
      authGeneration: ownerAGeneration,
    });

    await act(async () => {
      mockSetVerification(false);
    });

    const boundaryAfterLock = mockGetBoundary();
    expect(boundaryAfterLock.isScopeVerified).toBe(false);
    expect(boundaryAfterLock.authState).toBe(boundaryBeforeLock.authState);
    expect(boundaryAfterLock.userId).toBe(boundaryBeforeLock.userId);
    expect(boundaryAfterLock.generation).toBe(boundaryBeforeLock.generation);
    expect(boundaryAfterLock.isLoading).toBe(boundaryBeforeLock.isLoading);
    expect(boundaryAfterLock.accounts).toBe(boundaryBeforeLock.accounts);
    expect(boundaryAfterLock.transactions).toBe(
      boundaryBeforeLock.transactions,
    );
    expect(mockGetAuthSnapshot(boundaryAfterLock)).toEqual(authBeforeLock);
    expect(getAuthGeneration()).toBe(generationBeforeLock);

    const lockedCommits = commits.filter((commit) => !commit.isScopeVerified);
    expect(lockedCommits.length).toBeGreaterThan(0);

    // The first locked commit was captured before the passive effect cleared
    // the page's local snapshot state. The current page still renders owner
    // A's reconciliation row here, so this is the regression location.
    const firstLockedCommit = lockedCommits[0];
    expect(firstLockedCommit.text).not.toContain(OWNER_A_ACCOUNT_NAME);

    for (const lockedCommit of lockedCommits) {
      // Only verification changed; the identity and context data did not.
      expect(lockedCommit.authState).toBe('authenticated');
      expect(lockedCommit.userId).toBe(OWNER_A_USER_ID);
      expect(lockedCommit.generation).toBe(ownerAGeneration);
      expect(lockedCommit.isLoading).toBe(false);
      expect(lockedCommit.accounts).toBe(boundaryBeforeLock.accounts);
      expect(lockedCommit.transactions).toBe(boundaryBeforeLock.transactions);

      // No owner A row content may be present in the committed DOM or in any
      // input value, including the transition commit itself.
      expectNoOwnerAFinancialData(
        lockedCommit,
        expectedAmount,
        differenceAmount,
      );
    }

    // Revoking verification alone must not start another snapshot read,
    // migration write, or persistence write.
    expect(mockGetBalanceSnapshots).toHaveBeenCalledTimes(readsBeforeLock);
    expect(mockUpsertBalanceSnapshot).toHaveBeenCalledTimes(upsertsBeforeLock);
  });

  it.each(['resolve', 'reject'] as const)(
    'stops the legacy migration after verification is revoked while the first upsert is pending (%s)',
    async (outcome) => {
      window.localStorage.setItem(LEGACY_STORAGE_KEY, LEGACY_BALANCES_JSON);

      const firstUpsert = deferred<void>();
      mockUpsertBalanceSnapshot.mockReturnValueOnce(firstUpsert.promise);

      render(<AvailableBalancePage />);

      await waitFor(() => {
        expect(mockUpsertBalanceSnapshot).toHaveBeenCalledTimes(1);
      });
      const [firstAccountId, firstPayload] =
        mockUpsertBalanceSnapshot.mock.calls[0];
      expect(firstAccountId).toBe(LEGACY_FIRST_ACCOUNT_ID);
      expect(firstPayload.value).toBe(LEGACY_FIRST_VALUE);
      expect(mockGetBalanceSnapshots).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(LEGACY_STORAGE_KEY)).toBe(
        LEGACY_BALANCES_JSON,
      );

      await act(async () => {
        mockSetVerification(false);
      });

      await settleDeferred(
        firstUpsert,
        outcome,
        undefined,
        new Error('migration failed'),
      );

      expect(mockUpsertBalanceSnapshot).toHaveBeenCalledTimes(1);
      expect(mockGetBalanceSnapshots).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(LEGACY_STORAGE_KEY)).toBe(
        LEGACY_BALANCES_JSON,
      );
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'never publishes owner A data when verification is revoked before the initial read settles (%s)',
    async (outcome) => {
      const initialRead = deferred<BalanceSnapshotMap>();
      mockGetBalanceSnapshots.mockReturnValueOnce(initialRead.promise);

      const { commits, onRender } = createCommitRecorder();
      render(
        <React.Profiler id="available-balance-scope" onRender={onRender}>
          <AvailableBalancePage />
        </React.Profiler>,
      );

      await waitFor(() => {
        expect(mockGetBalanceSnapshots).toHaveBeenCalledTimes(1);
      });

      const commitCountBeforeLock = commits.length;
      await act(async () => {
        mockSetVerification(false);
      });

      const lockedCommits = commits.slice(commitCountBeforeLock);
      expect(lockedCommits.length).toBeGreaterThan(0);
      for (const commit of lockedCommits) {
        expect(commit.isScopeVerified).toBe(false);
      }
      expectNoOwnerAFinancialDataIn(lockedCommits);

      await settleDeferred(
        initialRead,
        outcome,
        mockOwnerASnapshots,
        new Error('snapshot read failed'),
      );

      expect(mockGetBalanceSnapshots).toHaveBeenCalledTimes(1);
      expect(mockUpsertBalanceSnapshot).not.toHaveBeenCalled();

      const settledCommits = commits.slice(commitCountBeforeLock);
      for (const commit of settledCommits) {
        expect(commit.isScopeVerified).toBe(false);
      }
      expectNoOwnerAFinancialDataIn(settledCommits);
    },
  );

  it('shows only owner B data when B reuses owner A account id', async () => {
    const { commits, onRender } = createCommitRecorder();
    render(
      <React.Profiler id="available-balance-scope" onRender={onRender}>
        <AvailableBalancePage />
      </React.Profiler>,
    );

    await waitFor(() => {
      expect(commits.some(isOwnerASourceCommit)).toBe(true);
    });
    await waitFor(() => {
      expect(mockUpsertBalanceSnapshot).toHaveBeenCalled();
    });

    const upsertsBeforeB = mockUpsertBalanceSnapshot.mock.calls.length;
    const commitCountBeforeB = commits.length;
    const bRead = deferred<BalanceSnapshotMap>();
    mockGetBalanceSnapshots.mockReturnValueOnce(bRead.promise);

    let bGeneration = 0;
    await act(async () => {
      bGeneration = mockPublishIdentity(
        { state: 'authenticated', userId: OWNER_B_USER_ID },
        {
          isScopeVerified: true,
          accounts: mockOwnerBAccounts,
          transactions: mockOwnerBTransactions,
        },
      );
    });

    await waitFor(() => {
      expect(mockGetBalanceSnapshots).toHaveBeenCalledTimes(2);
    });

    const transitionCommits = commits.slice(commitCountBeforeB);
    expect(transitionCommits.length).toBeGreaterThan(0);
    for (const commit of transitionCommits) {
      expect(commit.authState).toBe('authenticated');
      expect(commit.userId).toBe(OWNER_B_USER_ID);
      expect(commit.generation).toBe(bGeneration);
      expect(commit.isScopeVerified).toBe(true);
      expectNoOwnerAFinancialData(
        commit,
        OWNER_A_EXPECTED_AMOUNT,
        OWNER_A_DIFFERENCE_AMOUNT,
      );
    }

    await settleDeferred(
      bRead,
      'resolve',
      mockOwnerBSnapshots,
      new Error('unused'),
    );

    await waitFor(() => {
      expect(commits.some(isOwnerBSourceCommit)).toBe(true);
    });

    const ownerBCommits = commits.filter(
      (commit) => commit.userId === OWNER_B_USER_ID,
    );
    expect(ownerBCommits.length).toBeGreaterThan(0);
    for (const commit of ownerBCommits) {
      expectNoOwnerAFinancialData(
        commit,
        OWNER_A_EXPECTED_AMOUNT,
        OWNER_A_DIFFERENCE_AMOUNT,
      );
    }

    await waitFor(() => {
      expect(mockUpsertBalanceSnapshot.mock.calls.length).toBeGreaterThan(
        upsertsBeforeB,
      );
    });
    const ownerBUpserts = mockUpsertBalanceSnapshot.mock.calls.slice(
      upsertsBeforeB,
    );
    for (const [accountId, payload] of ownerBUpserts) {
      expect(accountId).toBe(OWNER_A_ACCOUNT_ID);
      expect(payload.value).toBe(OWNER_B_CURRENT_VALUE);
      expect((payload.subSplits ?? []).map((split) => split.label)).toEqual([
        OWNER_B_SPLIT_LABEL,
      ]);
    }
    expect(mockGetBalanceSnapshots).toHaveBeenCalledTimes(2);
  });

  it('does not revive owner A local snapshot after sign-out and a new-generation relogin', async () => {
    const { commits, onRender } = createCommitRecorder();
    render(
      <React.Profiler id="available-balance-scope" onRender={onRender}>
        <AvailableBalancePage />
      </React.Profiler>,
    );

    await waitFor(() => {
      expect(commits.some(isOwnerASourceCommit)).toBe(true);
    });
    await waitFor(() => {
      expect(mockUpsertBalanceSnapshot).toHaveBeenCalled();
    });
    const upsertsBeforeSignOut = mockUpsertBalanceSnapshot.mock.calls.length;
    const generationBeforeSignOut = mockGetBoundary().generation;

    const reloginRead = deferred<BalanceSnapshotMap>();
    mockGetBalanceSnapshots.mockReturnValueOnce(reloginRead.promise);

    const commitCountBeforeSignOut = commits.length;
    await act(async () => {
      mockPublishIdentity(
        { state: 'unauthenticated' },
        {
          isScopeVerified: false,
          accounts: mockOwnerAAccounts,
          transactions: mockOwnerATransactions,
        },
      );
    });

    const signOutCommits = commits.slice(commitCountBeforeSignOut);
    expect(signOutCommits.length).toBeGreaterThan(0);
    for (const commit of signOutCommits) {
      expect(commit.authState).toBe('unauthenticated');
      expect(commit.userId).toBeNull();
      expect(commit.isScopeVerified).toBe(false);
    }
    expectNoOwnerAFinancialDataIn(signOutCommits);

    const commitCountBeforeRelogin = commits.length;
    let reloginGeneration = 0;
    await act(async () => {
      reloginGeneration = mockPublishIdentity(
        { state: 'authenticated', userId: OWNER_A_USER_ID },
        {
          isScopeVerified: true,
          accounts: mockOwnerAAccounts,
          transactions: mockOwnerATransactions,
        },
      );
    });

    await waitFor(() => {
      expect(mockGetBalanceSnapshots).toHaveBeenCalledTimes(2);
    });
    expect(reloginGeneration).toBeGreaterThan(generationBeforeSignOut);

    const pendingReloginCommits = commits
      .slice(commitCountBeforeRelogin)
      .filter((commit) => commit.generation === reloginGeneration);
    expect(pendingReloginCommits.length).toBeGreaterThan(0);
    for (const commit of pendingReloginCommits) {
      expect(commit.userId).toBe(OWNER_A_USER_ID);
      expect(commit.isScopeVerified).toBe(true);
      expectNoOwnerACurrentSnapshot(commit);
    }

    await settleDeferred(reloginRead, 'resolve', {}, new Error('unused'));

    const reloginCommits = commits
      .slice(commitCountBeforeRelogin)
      .filter((commit) => commit.generation === reloginGeneration);
    expect(reloginCommits.length).toBeGreaterThan(0);
    for (const commit of reloginCommits) {
      expectNoOwnerACurrentSnapshot(commit);
    }
    expect(mockUpsertBalanceSnapshot).toHaveBeenCalledTimes(
      upsertsBeforeSignOut,
    );
    expect(mockGetBalanceSnapshots).toHaveBeenCalledTimes(2);
  });

  async function renderBlockedContext(): Promise<CommitSnapshot[]> {
    const { commits, onRender } = createCommitRecorder();
    render(
      <React.Profiler id="available-balance-scope" onRender={onRender}>
        <AvailableBalancePage />
      </React.Profiler>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(commits.length).toBeGreaterThan(0);
    expectNoOwnerAFinancialDataIn(commits);
    for (const commit of commits) {
      expect(commit.text).not.toContain(formatCurrency(LEGACY_FIRST_VALUE));
      expect(commit.text).not.toContain(formatCurrency(LEGACY_SECOND_VALUE));
    }
    expect(mockGetBalanceSnapshots).not.toHaveBeenCalled();
    expect(mockUpsertBalanceSnapshot).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LEGACY_STORAGE_KEY)).toBe(
      LEGACY_BALANCES_JSON,
    );
    return commits;
  }

  it('performs no IDB work and shows no financial content while verification is locked', async () => {
    window.localStorage.setItem(LEGACY_STORAGE_KEY, LEGACY_BALANCES_JSON);
    mockBoundary = {
      ...mockBoundary,
      isScopeVerified: false,
      isLoading: false,
      accounts: mockOwnerAAccounts,
      transactions: mockOwnerATransactions,
    };

    await renderBlockedContext();
  });

  it('performs no IDB work and shows no financial content while unauthenticated', async () => {
    window.localStorage.setItem(LEGACY_STORAGE_KEY, LEGACY_BALANCES_JSON);
    mockPublishIdentity(
      { state: 'unauthenticated' },
      {
        isScopeVerified: false,
        accounts: mockOwnerAAccounts,
        transactions: mockOwnerATransactions,
      },
    );

    await renderBlockedContext();
  });

  it('performs no IDB work for an authenticated context with no user despite verification', async () => {
    window.localStorage.setItem(LEGACY_STORAGE_KEY, LEGACY_BALANCES_JSON);
    mockBoundary = {
      ...mockBoundary,
      authState: 'authenticated',
      userId: null,
      isScopeVerified: true,
      isLoading: false,
      accounts: mockOwnerAAccounts,
      transactions: mockOwnerATransactions,
    };

    await renderBlockedContext();
  });

  it('loads and persists for verified local-only auth', async () => {
    mockPublishIdentity(
      { state: 'disabled' },
      {
        isScopeVerified: true,
        isLoading: false,
        accounts: mockOwnerAAccounts,
        transactions: mockOwnerATransactions,
      },
    );

    const { commits, onRender } = createCommitRecorder();
    render(
      <React.Profiler id="available-balance-scope" onRender={onRender}>
        <AvailableBalancePage />
      </React.Profiler>,
    );

    await waitFor(() => {
      expect(mockGetBalanceSnapshots).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(commits.some(isOwnerASourceCommit)).toBe(true);
    });
    await waitFor(() => {
      expect(mockUpsertBalanceSnapshot).toHaveBeenCalled();
    });

    expect(mockGetBalanceSnapshots).toHaveBeenCalledTimes(1);
    const [accountId, payload] = mockUpsertBalanceSnapshot.mock.calls[0];
    expect(accountId).toBe(OWNER_A_ACCOUNT_ID);
    expect(payload.value).toBe(OWNER_A_CURRENT_VALUE);
  });

  it('stays blocked for unverified local-only auth', async () => {
    window.localStorage.setItem(LEGACY_STORAGE_KEY, LEGACY_BALANCES_JSON);
    mockPublishIdentity(
      { state: 'disabled' },
      {
        isScopeVerified: false,
        accounts: mockOwnerAAccounts,
        transactions: mockOwnerATransactions,
      },
    );

    await renderBlockedContext();
  });

  it('does not repeat the snapshot read or legacy migration on a same-scope rerender', async () => {
    window.localStorage.setItem(LEGACY_STORAGE_KEY, LEGACY_BALANCES_JSON);

    const { commits, onRender } = createCommitRecorder();
    const { rerender } = render(
      <React.Profiler id="available-balance-scope" onRender={onRender}>
        <AvailableBalancePage />
      </React.Profiler>,
    );

    await waitFor(() => {
      expect(commits.some(isOwnerASourceCommit)).toBe(true);
    });
    await waitFor(() => {
      expect(mockGetBalanceSnapshots).toHaveBeenCalledTimes(1);
      expect(
        mockUpsertBalanceSnapshot.mock.calls.some(
          ([accountId]) => accountId === OWNER_A_ACCOUNT_ID,
        ),
      ).toBe(true);
      expect(window.localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    });

    const readsBeforeRerender = mockGetBalanceSnapshots.mock.calls.length;
    const upsertsBeforeRerender = mockUpsertBalanceSnapshot.mock.calls.length;
    const commitCountBeforeRerender = commits.length;

    // A same-scope rerender must not re-run the load effect. Re-seeding the
    // legacy key makes a repeated migration observable instead of vacuous.
    window.localStorage.setItem(LEGACY_STORAGE_KEY, LEGACY_BALANCES_JSON);

    rerender(
      <React.Profiler id="available-balance-scope" onRender={onRender}>
        <AvailableBalancePage />
      </React.Profiler>,
    );
    await act(async () => {
      mockBoundary = { ...mockBoundary };
      mockNotifyBoundary();
    });

    expect(mockGetBalanceSnapshots).toHaveBeenCalledTimes(readsBeforeRerender);
    expect(mockUpsertBalanceSnapshot).toHaveBeenCalledTimes(
      upsertsBeforeRerender,
    );
    expect(window.localStorage.getItem(LEGACY_STORAGE_KEY)).toBe(
      LEGACY_BALANCES_JSON,
    );

    const rerenderCommits = commits.slice(commitCountBeforeRerender);
    expect(rerenderCommits.length).toBeGreaterThan(0);
    expect(rerenderCommits.some(isOwnerASourceCommit)).toBe(true);
  });

  it.each(['resolve', 'reject'] as const)(
    'fences the pending legacy migration after unmount (%s)',
    async (outcome) => {
      window.localStorage.setItem(LEGACY_STORAGE_KEY, LEGACY_BALANCES_JSON);

      const firstUpsert = deferred<void>();
      mockUpsertBalanceSnapshot.mockReturnValueOnce(firstUpsert.promise);

      const { commits, onRender } = createCommitRecorder();
      const { unmount } = render(
        <React.Profiler id="available-balance-scope" onRender={onRender}>
          <AvailableBalancePage />
        </React.Profiler>,
      );

      await waitFor(() => {
        expect(mockUpsertBalanceSnapshot).toHaveBeenCalledTimes(1);
      });
      unmount();
      const commitsAfterUnmount = commits.length;

      await settleDeferred(
        firstUpsert,
        outcome,
        undefined,
        new Error('migration failed'),
      );

      expect(mockUpsertBalanceSnapshot).toHaveBeenCalledTimes(1);
      expect(mockGetBalanceSnapshots).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(LEGACY_STORAGE_KEY)).toBe(
        LEGACY_BALANCES_JSON,
      );
      expect(commits.length).toBe(commitsAfterUnmount);
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'fences the pending snapshot read after unmount (%s)',
    async (outcome) => {
      const pendingRead = deferred<BalanceSnapshotMap>();
      mockGetBalanceSnapshots.mockReturnValueOnce(pendingRead.promise);

      const { commits, onRender } = createCommitRecorder();
      const { unmount } = render(
        <React.Profiler id="available-balance-scope" onRender={onRender}>
          <AvailableBalancePage />
        </React.Profiler>,
      );

      await waitFor(() => {
        expect(mockGetBalanceSnapshots).toHaveBeenCalledTimes(1);
      });
      unmount();
      const commitsAfterUnmount = commits.length;

      await settleDeferred(
        pendingRead,
        outcome,
        mockOwnerASnapshots,
        new Error('snapshot read failed'),
      );

      expect(mockGetBalanceSnapshots).toHaveBeenCalledTimes(1);
      expect(mockUpsertBalanceSnapshot).not.toHaveBeenCalled();
      expect(commits.length).toBe(commitsAfterUnmount);
    },
  );
  it('preserves plain and split edits and fences stale cash callbacks', async () => {
    render(<AvailableBalancePage />);

    await waitFor(() => {
      expect(
        screen.getAllByRole('button', { name: 'Disable sub-split' }),
      ).toHaveLength(2);
    });

    fireEvent.click(
      screen.getAllByRole('button', { name: 'Disable sub-split' })[0],
    );
    const currentInputs = screen.getAllByLabelText(
      `Current balance for ${OWNER_A_ACCOUNT_NAME}`,
    );
    expect(currentInputs).toHaveLength(2);
    expect(getInputValue(currentInputs[0])).toBe(
      String(OWNER_A_CURRENT_VALUE),
    );

    fireEvent.change(currentInputs[0], { target: { value: '5.5' } });
    expect(
      screen
        .getAllByLabelText(`Current balance for ${OWNER_A_ACCOUNT_NAME}`)
        .map(getInputValue),
    ).toEqual(['5.5', '5.5']);
    fireEvent.change(currentInputs[0], { target: { value: '' } });
    expect(
      screen
        .getAllByLabelText(`Current balance for ${OWNER_A_ACCOUNT_NAME}`)
        .map(getInputValue),
    ).toEqual(['', '']);

    fireEvent.click(screen.getAllByRole('button', { name: 'Enable sub-split' })[0]);
    expect(screen.getAllByLabelText('Sub-split label')).toHaveLength(6);
    const labels = screen.getAllByLabelText('Sub-split label');
    const amounts = screen.getAllByLabelText('Sub-split amount');
    fireEvent.change(labels[0], { target: { value: 'Emergency' } });
    fireEvent.change(amounts[0], { target: { value: '25.5' } });
    expect(screen.getAllByText(formatCurrency(25.5))).toHaveLength(2);

    fireEvent.click(
      screen.getAllByRole('button', { name: '+ Add sub-split' })[0],
    );
    expect(screen.getAllByLabelText('Sub-split label')).toHaveLength(8);
    const removeButtons = screen.getAllByRole('button', {
      name: 'Remove sub-split',
    });
    fireEvent.click(removeButtons[3]);
    expect(screen.getAllByLabelText('Sub-split label')).toHaveLength(6);

    fireEvent.click(
      screen.getAllByRole('button', { name: 'Disable sub-split' })[0],
    );
    expect(
      screen
        .getAllByLabelText(`Current balance for ${OWNER_A_ACCOUNT_NAME}`)
        .map(getInputValue),
    ).toEqual(['25.5', '25.5']);
    await waitFor(() => {
      expect(
        mockUpsertBalanceSnapshot.mock.calls.some(
          ([accountId, payload]) =>
            accountId === OWNER_A_ACCOUNT_ID &&
            payload.value === 25.5 &&
            payload.useSubSplit === undefined,
        ),
      ).toBe(true);
    });
    expect(mockBoundary.transactions).toBe(mockOwnerATransactions);

    cleanup();
    mockGetBalanceSnapshots.mockResolvedValue({});
    mockBoundary = {
      ...mockBoundary,
      accounts: [mockCashAccount],
      transactions: [],
      isScopeVerified: true,
    };
    await act(async () => {
      mockNotifyBoundary();
    });
    const cashCommits = createCommitRecorder();
    const cashView = render(
      <React.Profiler
        id="available-balance-cash-callback"
        onRender={cashCommits.onRender}
      >
        <AvailableBalancePage />
      </React.Profiler>,
    );
    await waitFor(() => {
      expect(mockGetBalanceSnapshots.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mockCashTotalChange).not.toBeNull();
    });
    const staleCashCallback = mockCashTotalChange;
    if (staleCashCallback === null) {
      throw new Error('cash denomination callback was not mounted');
    }

    await act(async () => {
      mockSetVerification(false);
      staleCashCallback(444);
    });
    await act(async () => {
      mockSetVerification(true);
    });
    await waitFor(() => {
      expect(mockGetBalanceSnapshots.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(mockCashTotalChange).not.toBeNull();
    });

    const upsertsBeforeStaleCallback = mockUpsertBalanceSnapshot.mock.calls.length;
    await act(async () => {
      staleCashCallback(555);
    });
    expect(mockUpsertBalanceSnapshot).toHaveBeenCalledTimes(
      upsertsBeforeStaleCallback,
    );
    expect(
      mockUpsertBalanceSnapshot.mock.calls.some(
        ([accountId, payload]) => accountId === 'cash' && payload.value === 555,
      ),
    ).toBe(false);

    const currentCashCallback = mockCashTotalChange;
    if (currentCashCallback === null) {
      throw new Error('cash denomination callback was not mounted after reverify');
    }
    await act(async () => {
      currentCashCallback(777);
    });
    await waitFor(() => {
      expect(
        mockUpsertBalanceSnapshot.mock.calls.some(
          ([accountId, payload]) => accountId === 'cash' && payload.value === 777,
        ),
      ).toBe(true);
    });

    const visibleBeforeGenerationInvalidation = captureOwnerAVisibleState();
    const commitsBeforeGenerationInvalidation = cashCommits.commits.length;
    publishAuthIdentity({
      state: 'authenticated',
      userId: OWNER_B_USER_ID,
    });
    await act(async () => {
      currentCashCallback(888);
    });
    expect(captureOwnerAVisibleState()).toEqual(
      visibleBeforeGenerationInvalidation,
    );
    expect(cashCommits.commits).toHaveLength(
      commitsBeforeGenerationInvalidation,
    );
    expect(
      mockUpsertBalanceSnapshot.mock.calls.some(
        ([accountId, payload]) => accountId === 'cash' && payload.value === 888,
      ),
    ).toBe(false);
    cashView.unmount();
  });
  it('migrates every legacy balance before the snapshot read', async () => {
    window.localStorage.setItem(LEGACY_STORAGE_KEY, LEGACY_BALANCES_JSON);
    mockGetBalanceSnapshots.mockResolvedValue({});

    render(<AvailableBalancePage />);

    await waitFor(() => {
      expect(window.localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
      expect(mockGetBalanceSnapshots).toHaveBeenCalledTimes(1);
    });

    const migratedEntries = mockUpsertBalanceSnapshot.mock.calls
      .filter(([accountId]) =>
        [LEGACY_FIRST_ACCOUNT_ID, LEGACY_SECOND_ACCOUNT_ID].includes(accountId),
      )
      .map(([accountId, payload]) => [accountId, payload.value]);
    expect(migratedEntries).toEqual([
      [LEGACY_FIRST_ACCOUNT_ID, LEGACY_FIRST_VALUE],
      [LEGACY_SECOND_ACCOUNT_ID, LEGACY_SECOND_VALUE],
    ]);
  });

  it('stays locked while auth is loading despite retained owner A context rows', async () => {
    mockPublishIdentity(
      { state: 'loading' },
      {
        isScopeVerified: true,
        isLoading: true,
        accounts: mockOwnerAAccounts,
        transactions: mockOwnerATransactions,
      },
    );
    window.localStorage.setItem(LEGACY_STORAGE_KEY, LEGACY_BALANCES_JSON);

    await renderBlockedContext();
  });

  it('keeps an authorized edit when the current-scope snapshot read fails', async () => {
    const pendingRead = deferred<BalanceSnapshotMap>();
    mockGetBalanceSnapshots.mockReturnValueOnce(pendingRead.promise);

    render(<AvailableBalancePage />);
    const inputs = await screen.findAllByLabelText(
      `Current balance for ${OWNER_A_ACCOUNT_NAME}`,
    );
    expect(inputs).toHaveLength(2);
    const input = inputs[0];
    fireEvent.change(input, { target: { value: '33.25' } });
    expect(getInputValue(input)).toBe('33.25');
    expect(mockUpsertBalanceSnapshot).not.toHaveBeenCalled();

    await settleDeferred(
      pendingRead,
      'reject',
      mockOwnerASnapshots,
      new Error('snapshot read failed'),
    );

    await waitFor(() => {
      expect(
        mockUpsertBalanceSnapshot.mock.calls.some(
          ([accountId, payload]) =>
            accountId === OWNER_A_ACCOUNT_ID && payload.value === 33.25,
        ),
      ).toBe(true);
    });
    expect(getInputValue(input)).toBe('33.25');
  });

  it('keeps edits visible when current-scope persistence rejects', async () => {
    mockUpsertBalanceSnapshot.mockResolvedValueOnce(undefined);
    render(<AvailableBalancePage />);

    await waitFor(() => {
      expect(
        screen.getAllByRole('button', { name: 'Disable sub-split' }),
      ).toHaveLength(2);
    });
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Disable sub-split' })[0],
    );
    const input = screen.getAllByLabelText(
      `Current balance for ${OWNER_A_ACCOUNT_NAME}`,
    )[0];

    mockUpsertBalanceSnapshot.mockRejectedValue(
      new Error('snapshot write failed'),
    );
    fireEvent.change(input, { target: { value: '44.5' } });

    await waitFor(() => {
      expect(
        mockUpsertBalanceSnapshot.mock.calls.some(
          ([accountId, payload]) =>
            accountId === OWNER_A_ACCOUNT_ID && payload.value === 44.5,
        ),
      ).toBe(true);
    });
    expect(getInputValue(input)).toBe('44.5');
  });
  it('does not revive a deferred read after same-generation revoke and reverify', async () => {
    const oldRead = deferred<BalanceSnapshotMap>();
    const replacementRead = deferred<BalanceSnapshotMap>();
    mockGetBalanceSnapshots
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(replacementRead.promise);
    const { commits, onRender } = createCommitRecorder();

    render(
      <React.Profiler id="available-balance-scope" onRender={onRender}>
        <AvailableBalancePage />
      </React.Profiler>,
    );
    await waitFor(() => {
      expect(mockGetBalanceSnapshots).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      mockSetVerification(false);
    });
    await act(async () => {
      mockSetVerification(true);
    });
    await waitFor(() => {
      expect(mockGetBalanceSnapshots).toHaveBeenCalledTimes(2);
    });

    await settleDeferred(
      oldRead,
      'resolve',
      mockOwnerASnapshots,
      new Error('unused'),
    );
    for (const commit of commits) {
      expectNoOwnerACurrentSnapshot(commit);
    }
    expect(mockUpsertBalanceSnapshot).not.toHaveBeenCalled();

    await settleDeferred(replacementRead, 'resolve', {}, new Error('unused'));
    for (const commit of commits) {
      expectNoOwnerACurrentSnapshot(commit);
    }
    expect(mockGetBalanceSnapshots).toHaveBeenCalledTimes(2);
    expect(mockUpsertBalanceSnapshot).not.toHaveBeenCalled();
  });

  it('fences a stale plain current-balance change after shared generation advances before rerender', async () => {
    const { commits, onRender } = createCommitRecorder();
    render(
      <React.Profiler id="available-balance-scope" onRender={onRender}>
        <AvailableBalancePage />
      </React.Profiler>,
    );

    await waitFor(() => {
      expect(
        screen.getAllByRole('button', { name: 'Disable sub-split' }),
      ).toHaveLength(2);
    });
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Disable sub-split' })[0],
    );
    await waitFor(() => {
      expect(
        screen
          .getAllByLabelText(`Current balance for ${OWNER_A_ACCOUNT_NAME}`)
          .map(getInputValue),
      ).toEqual([
        String(OWNER_A_CURRENT_VALUE),
        String(OWNER_A_CURRENT_VALUE),
      ]);
      expect(
        mockUpsertBalanceSnapshot.mock.calls.some(
          ([accountId, payload]) =>
            accountId === OWNER_A_ACCOUNT_ID &&
            payload.value === OWNER_A_CURRENT_VALUE &&
            payload.useSubSplit === undefined,
        ),
      ).toBe(true);
    });
    await act(async () => {});

    const visibleBeforeStale = captureOwnerAVisibleState();
    const upsertsBeforeStale = mockUpsertBalanceSnapshot.mock.calls.length;
    expect(upsertsBeforeStale).toBeGreaterThan(0);
    const commitsBeforeStale = commits.length;
    const boundaryBeforeStale = mockGetBoundary();
    const generationBeforeStale = getAuthGeneration();

    const advancedGeneration = publishAuthIdentity({
      state: 'authenticated',
      userId: OWNER_B_USER_ID,
    });

    expect(advancedGeneration).toBeGreaterThan(generationBeforeStale);
    expect(getAuthGeneration()).toBe(advancedGeneration);
    expect(mockGetBoundary()).toBe(boundaryBeforeStale);
    expect(boundaryBeforeStale.userId).toBe(OWNER_A_USER_ID);
    expect(boundaryBeforeStale.generation).toBe(generationBeforeStale);
    expect(boundaryBeforeStale.isScopeVerified).toBe(true);

    const staleInput = screen.getAllByLabelText(
      `Current balance for ${OWNER_A_ACCOUNT_NAME}`,
    )[0];
    fireEvent.change(staleInput, { target: { value: '9999.99' } });
    await act(async () => {});

    expect(captureOwnerAVisibleState()).toEqual(visibleBeforeStale);
    expect(commits).toHaveLength(commitsBeforeStale);
    expect(mockUpsertBalanceSnapshot).toHaveBeenCalledTimes(upsertsBeforeStale);
    const staleUpserts = mockUpsertBalanceSnapshot.mock.calls.slice(
      upsertsBeforeStale,
    );
    expect(staleUpserts.some(([, payload]) => payload.value === 9999.99)).toBe(
      false,
    );
  });

  it('fences a stale sub-split toggle after shared generation advances before rerender', async () => {
    const { commits, onRender } = createCommitRecorder();
    render(
      <React.Profiler id="available-balance-scope" onRender={onRender}>
        <AvailableBalancePage />
      </React.Profiler>,
    );

    await waitFor(() => {
      expect(
        screen.getAllByRole('button', { name: 'Disable sub-split' }),
      ).toHaveLength(2);
    });
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Disable sub-split' })[0],
    );
    await waitFor(() => {
      expect(
        screen.queryAllByLabelText('Sub-split label'),
      ).toHaveLength(0);
      expect(
        screen.getAllByRole('button', { name: 'Enable sub-split' }),
      ).toHaveLength(2);
      expect(
        mockUpsertBalanceSnapshot.mock.calls.some(
          ([accountId, payload]) =>
            accountId === OWNER_A_ACCOUNT_ID &&
            payload.value === OWNER_A_CURRENT_VALUE &&
            payload.useSubSplit === undefined,
        ),
      ).toBe(true);
    });
    await act(async () => {});

    const visibleBeforeStale = captureOwnerAVisibleState();
    const upsertsBeforeStale = mockUpsertBalanceSnapshot.mock.calls.length;
    expect(upsertsBeforeStale).toBeGreaterThan(0);
    const commitsBeforeStale = commits.length;
    const boundaryBeforeStale = mockGetBoundary();
    const generationBeforeStale = getAuthGeneration();

    const advancedGeneration = publishAuthIdentity({
      state: 'authenticated',
      userId: OWNER_B_USER_ID,
    });

    expect(advancedGeneration).toBeGreaterThan(generationBeforeStale);
    expect(getAuthGeneration()).toBe(advancedGeneration);
    expect(mockGetBoundary()).toBe(boundaryBeforeStale);
    expect(boundaryBeforeStale.userId).toBe(OWNER_A_USER_ID);
    expect(boundaryBeforeStale.generation).toBe(generationBeforeStale);
    expect(boundaryBeforeStale.isScopeVerified).toBe(true);

    fireEvent.click(
      screen.getAllByRole('button', { name: 'Enable sub-split' })[0],
    );
    await act(async () => {});

    expect(captureOwnerAVisibleState()).toEqual(visibleBeforeStale);
    expect(screen.queryAllByLabelText('Sub-split label')).toHaveLength(0);
    expect(commits).toHaveLength(commitsBeforeStale);
    expect(mockUpsertBalanceSnapshot).toHaveBeenCalledTimes(upsertsBeforeStale);
    const staleUpserts = mockUpsertBalanceSnapshot.mock.calls.slice(
      upsertsBeforeStale,
    );
    expect(
      staleUpserts.some(([, payload]) => payload.useSubSplit === true),
    ).toBe(false);
    expect(
      staleUpserts.some(
        ([, payload]) => (payload.subSplits ?? []).length > 0,
      ),
    ).toBe(false);
  });

  it('fences stale sub-split label and amount changes after shared generation advances before rerender', async () => {
    const { commits, onRender } = createCommitRecorder();
    render(
      <React.Profiler id="available-balance-scope" onRender={onRender}>
        <AvailableBalancePage />
      </React.Profiler>,
    );

    await waitFor(() => {
      expect(screen.getAllByLabelText('Sub-split label')).toHaveLength(2);
      expect(screen.getAllByLabelText('Sub-split amount')).toHaveLength(2);
    });
    await waitFor(() => {
      expect(mockUpsertBalanceSnapshot).toHaveBeenCalled();
    });
    await act(async () => {});
    expect(
      screen.getAllByLabelText('Sub-split label').map(getInputValue),
    ).toEqual([OWNER_A_SPLIT_LABEL, OWNER_A_SPLIT_LABEL]);
    expect(
      screen.getAllByLabelText('Sub-split amount').map(getInputValue),
    ).toEqual([
      String(OWNER_A_CURRENT_VALUE),
      String(OWNER_A_CURRENT_VALUE),
    ]);

    const visibleBeforeStale = captureOwnerAVisibleState();
    const upsertsBeforeStale = mockUpsertBalanceSnapshot.mock.calls.length;
    expect(upsertsBeforeStale).toBeGreaterThan(0);
    const commitsBeforeStale = commits.length;
    const boundaryBeforeStale = mockGetBoundary();
    const generationBeforeStale = getAuthGeneration();

    const advancedGeneration = publishAuthIdentity({
      state: 'authenticated',
      userId: OWNER_B_USER_ID,
    });

    expect(advancedGeneration).toBeGreaterThan(generationBeforeStale);
    expect(getAuthGeneration()).toBe(advancedGeneration);
    expect(mockGetBoundary()).toBe(boundaryBeforeStale);
    expect(boundaryBeforeStale.userId).toBe(OWNER_A_USER_ID);
    expect(boundaryBeforeStale.generation).toBe(generationBeforeStale);
    expect(boundaryBeforeStale.isScopeVerified).toBe(true);

    const staleLabel = 'Stale generation label';
    const staleAmount = 7777.25;
    const staleLabels = screen.getAllByLabelText('Sub-split label');
    const staleAmounts = screen.getAllByLabelText('Sub-split amount');
    fireEvent.change(staleLabels[0], { target: { value: staleLabel } });
    fireEvent.change(staleAmounts[0], { target: { value: String(staleAmount) } });
    await act(async () => {});

    expect(captureOwnerAVisibleState()).toEqual(visibleBeforeStale);
    expect(commits).toHaveLength(commitsBeforeStale);
    expect(mockUpsertBalanceSnapshot).toHaveBeenCalledTimes(upsertsBeforeStale);
    const staleUpserts = mockUpsertBalanceSnapshot.mock.calls.slice(
      upsertsBeforeStale,
    );
    expect(
      staleUpserts.some(
        ([, payload]) =>
          payload.value === staleAmount ||
          (payload.subSplits ?? []).some(
            (split) =>
              split.label === staleLabel || split.amount === staleAmount,
          ),
      ),
    ).toBe(false);
  });

  it('fences a stale add-sub-split action after shared generation advances before rerender', async () => {
    const { commits, onRender } = createCommitRecorder();
    render(
      <React.Profiler id="available-balance-scope" onRender={onRender}>
        <AvailableBalancePage />
      </React.Profiler>,
    );

    await waitFor(() => {
      expect(screen.getAllByLabelText('Sub-split label')).toHaveLength(2);
    });
    await waitFor(() => {
      expect(mockUpsertBalanceSnapshot).toHaveBeenCalled();
    });
    await act(async () => {});

    const visibleBeforeStale = captureOwnerAVisibleState();
    const upsertsBeforeStale = mockUpsertBalanceSnapshot.mock.calls.length;
    expect(upsertsBeforeStale).toBeGreaterThan(0);
    const commitsBeforeStale = commits.length;
    const boundaryBeforeStale = mockGetBoundary();
    const generationBeforeStale = getAuthGeneration();

    const advancedGeneration = publishAuthIdentity({
      state: 'authenticated',
      userId: OWNER_B_USER_ID,
    });

    expect(advancedGeneration).toBeGreaterThan(generationBeforeStale);
    expect(getAuthGeneration()).toBe(advancedGeneration);
    expect(mockGetBoundary()).toBe(boundaryBeforeStale);
    expect(boundaryBeforeStale.userId).toBe(OWNER_A_USER_ID);
    expect(boundaryBeforeStale.generation).toBe(generationBeforeStale);
    expect(boundaryBeforeStale.isScopeVerified).toBe(true);

    fireEvent.click(
      screen.getAllByRole('button', { name: '+ Add sub-split' })[0],
    );
    await act(async () => {});

    expect(captureOwnerAVisibleState()).toEqual(visibleBeforeStale);
    expect(screen.getAllByLabelText('Sub-split label')).toHaveLength(2);
    expect(commits).toHaveLength(commitsBeforeStale);
    expect(mockUpsertBalanceSnapshot).toHaveBeenCalledTimes(upsertsBeforeStale);
    const staleUpserts = mockUpsertBalanceSnapshot.mock.calls.slice(
      upsertsBeforeStale,
    );
    expect(
      staleUpserts.some(
        ([, payload]) => (payload.subSplits ?? []).length !== 1,
      ),
    ).toBe(false);
    expect(
      staleUpserts.some(([, payload]) =>
        (payload.subSplits ?? []).some((split) => split.label === ''),
      ),
    ).toBe(false);
  });

  it('fences a stale remove-sub-split action after shared generation advances before rerender', async () => {
    const { commits, onRender } = createCommitRecorder();
    render(
      <React.Profiler id="available-balance-scope" onRender={onRender}>
        <AvailableBalancePage />
      </React.Profiler>,
    );

    await waitFor(() => {
      expect(screen.getAllByLabelText('Sub-split label')).toHaveLength(2);
    });
    await waitFor(() => {
      expect(mockUpsertBalanceSnapshot).toHaveBeenCalled();
    });
    await act(async () => {});

    const visibleBeforeStale = captureOwnerAVisibleState();
    const upsertsBeforeStale = mockUpsertBalanceSnapshot.mock.calls.length;
    expect(upsertsBeforeStale).toBeGreaterThan(0);
    const commitsBeforeStale = commits.length;
    const boundaryBeforeStale = mockGetBoundary();
    const generationBeforeStale = getAuthGeneration();

    const advancedGeneration = publishAuthIdentity({
      state: 'authenticated',
      userId: OWNER_B_USER_ID,
    });

    expect(advancedGeneration).toBeGreaterThan(generationBeforeStale);
    expect(getAuthGeneration()).toBe(advancedGeneration);
    expect(mockGetBoundary()).toBe(boundaryBeforeStale);
    expect(boundaryBeforeStale.userId).toBe(OWNER_A_USER_ID);
    expect(boundaryBeforeStale.generation).toBe(generationBeforeStale);
    expect(boundaryBeforeStale.isScopeVerified).toBe(true);

    fireEvent.click(
      screen.getAllByRole('button', { name: 'Remove sub-split' })[0],
    );
    await act(async () => {});

    expect(captureOwnerAVisibleState()).toEqual(visibleBeforeStale);
    expect(screen.getAllByLabelText('Sub-split label')).toHaveLength(2);
    expect(commits).toHaveLength(commitsBeforeStale);
    expect(mockUpsertBalanceSnapshot).toHaveBeenCalledTimes(upsertsBeforeStale);
    const staleUpserts = mockUpsertBalanceSnapshot.mock.calls.slice(
      upsertsBeforeStale,
    );
    expect(
      staleUpserts.some(
        ([, payload]) => (payload.subSplits ?? []).length === 0,
      ),
    ).toBe(false);
    expect(staleUpserts.some(([, payload]) => payload.value === 0)).toBe(false);
  });
});
