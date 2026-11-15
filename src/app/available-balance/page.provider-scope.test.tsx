// ============================================================
// page.provider-scope.test.tsx — real provider + page scope isolation
//
// Mounts the real AvailableBalancePage inside the real
// TransactionProvider (no AuthGuard), with only auth identity, IndexedDB,
// network sync, and Next navigation doubled. Provider ownership
// verification, retained context rows, auth-scope generations, and the page's
// own state are real.
//
// Case: owner A is verified and rendered. The page and provider then switch
// to owner B while A's verification proof and rows are still committed in the
// provider. Every locked owner B commit is captured with a React Profiler,
// before passive effects clear those rows, and must contain no owner A
// financial content and must start no balance-snapshot read or write.
//
// The provider deliberately never verifies B against a `lastUserId` marker
// that names A. To exercise the verified half of the transition, the test
// hands local ownership to B (the persisted proof the provider reads) and
// drives a fresh B auth startup. The provider still performs its own
// verification and data load; no provider state is written by the test.
// ============================================================

import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Account, Transaction } from '@/types';
import { publishAuthIdentity } from '@/lib/auth-scope';
import { LAST_USER_STORAGE_KEY } from '@/lib/constants';
import {
  getBalanceSnapshots,
  upsertBalanceSnapshot,
  getAllTransactions,
  getAllAccounts,
  getAllCategories,
  hasAnyLocalData,
  addTransaction,
  updateTransaction,
  deleteTransaction,
} from '@/lib/idb';
import { backgroundSync } from '@/lib/sync';
import {
  TransactionProvider,
  useTransactionContext,
} from '@/context/TransactionContext';
import { useAuth } from '@/context/AuthContext';
import { calculateExpectedBalances } from '@/lib/reconciliation';
import { formatCurrency, getToday } from '@/lib/utils';
import AvailableBalancePage from './page';

// ---------------------------------------------------------------------------
// Boundary doubles: auth identity, IndexedDB adapters, sync, Next navigation
// ---------------------------------------------------------------------------

type AuthStateName = 'authenticated' | 'unauthenticated' | 'loading' | 'disabled';

interface MockAuthSnapshot {
  state: AuthStateName;
  user: { id: string; email: string } | null;
  authGeneration: number;
  signOut: jest.Mock;
}

let mockAuthState: MockAuthSnapshot = {
  state: 'loading',
  user: null,
  authGeneration: 0,
  signOut: jest.fn(),
};
let mockCashTotalChange: ((total: number) => void) | null = null;

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => mockAuthState,
}));

jest.mock('next/navigation', () => ({
  usePathname: () => '/available-balance',
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    refresh: jest.fn(),
    prefetch: jest.fn(),
  }),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: 'a',
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

jest.mock('@/lib/sync', () => ({
  backgroundSync: jest.fn(),
  getSyncStatus: jest.fn(),
  retrySyncWork: jest.fn(),
  getFailedSyncCount: jest.fn(() => 0),
  clearFailedSyncCount: jest.fn(),
}));

jest.mock('@/lib/idb', () => ({
  getBalanceSnapshots: jest.fn(),
  upsertBalanceSnapshot: jest.fn(),
  getAllTransactions: jest.fn(),
  getAllAccounts: jest.fn(),
  getAllCategories: jest.fn(),
  hasAnyLocalData: jest.fn(),
  addTransaction: jest.fn(),
  updateTransaction: jest.fn(),
  deleteTransaction: jest.fn(),
  getAllCashDenominations: jest.fn(),
  addCashDenomination: jest.fn(),
  deleteCashDenominationsByDate: jest.fn(),
}));

const mockGetBalanceSnapshots = jest.mocked(getBalanceSnapshots);
const mockUpsertBalanceSnapshot = jest.mocked(upsertBalanceSnapshot);
const mockGetAllTransactions = jest.mocked(getAllTransactions);
const mockGetAllAccounts = jest.mocked(getAllAccounts);
const mockGetAllCategories = jest.mocked(getAllCategories);
const mockHasAnyLocalData = jest.mocked(hasAnyLocalData);
const mockAddTransaction = jest.mocked(addTransaction);
const mockUpdateTransaction = jest.mocked(updateTransaction);
const mockDeleteTransaction = jest.mocked(deleteTransaction);
const mockBackgroundSync = jest.mocked(backgroundSync);

let mockSnapshotDataset: 'A' | 'B' = 'A';
let mockPendingSync: Promise<void> = new Promise<void>(() => {});

/** Mirrors AuthProvider: publish the shared identity, then render its generation. */
function actAsLoading(): number {
  const authGeneration = publishAuthIdentity({ state: 'loading' });
  mockAuthState = { state: 'loading', user: null, authGeneration, signOut: jest.fn() };
  return authGeneration;
}

function actAsAuthenticated(userId: string): number {
  const authGeneration = publishAuthIdentity({ state: 'authenticated', userId });
  mockAuthState = {
    state: 'authenticated',
    user: { id: userId, email: `${userId}@example.com` },
    authGeneration,
    signOut: jest.fn(),
  };
  return authGeneration;
}

// ---------------------------------------------------------------------------
// Owner A fixtures — verified, rendered, then left behind in provider state
// ---------------------------------------------------------------------------

const OWNER_A_USER_ID = 'provider-scope-owner-a';
const OWNER_B_USER_ID = 'provider-scope-owner-b';
const SHARED_ACCOUNT_ID = 'provider-scope-shared-account';

const OWNER_A_ACCOUNT_NAME = 'Owner A Alpha Checking';
const OWNER_A_STARTING_BALANCE = 10_000;
const OWNER_A_TRANSACTION_ID = 'provider-scope-owner-a-transaction';
const OWNER_A_TRANSACTION_AMOUNT = 1_250;
const OWNER_A_CURRENT_VALUE = 8_125.5;
const OWNER_A_UPDATED_AT = new Date(2026, 0, 15, 12, 0, 0).getTime();
const OWNER_A_SPLIT_ID = 'provider-scope-owner-a-split';
const OWNER_A_SPLIT_LABEL = 'Owner A Split Alpha';
const OWNER_A_UPDATED_DATE = new Date(OWNER_A_UPDATED_AT).toLocaleDateString(
  'en-US',
  { month: 'short', day: 'numeric' },
);

const OWNER_A_ACCOUNT: Account = {
  id: SHARED_ACCOUNT_ID,
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
  fromAccount: SHARED_ACCOUNT_ID,
  toAccount: null,
  description: 'Owner A reconciliation expense',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const mockOwnerAAccounts: Account[] = [OWNER_A_ACCOUNT, mockCashAccount];
const mockOwnerATransactions: Transaction[] = [OWNER_A_TRANSACTION];

interface BalanceSnapshotRecord {
  value: number;
  updatedAt: number;
  useSubSplit?: boolean;
  subSplits?: { id: string; label: string; amount: number }[];
}

type BalanceSnapshotMap = Record<string, BalanceSnapshotRecord>;

const mockOwnerASnapshots: BalanceSnapshotMap = {
  [SHARED_ACCOUNT_ID]: {
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

const OWNER_A_EXPECTED = calculateExpectedBalances(
  mockOwnerATransactions,
  mockOwnerAAccounts,
  getToday(),
)[0].expected;
const OWNER_A_DIFFERENCE = Math.abs(
  OWNER_A_EXPECTED - OWNER_A_CURRENT_VALUE,
);

// ---------------------------------------------------------------------------
// Owner B fixtures — same account id, different values, labels, and timestamps
// ---------------------------------------------------------------------------

const OWNER_B_ACCOUNT_NAME = 'Owner B Beta Checking';
const OWNER_B_STARTING_BALANCE = 5_000;
const OWNER_B_TRANSACTION_ID = 'provider-scope-owner-b-transaction';
const OWNER_B_TRANSACTION_AMOUNT = 375;
const OWNER_B_CURRENT_VALUE = 4_321.75;
const OWNER_B_UPDATED_AT = new Date(2026, 1, 20, 9, 30, 0).getTime();
const OWNER_B_SPLIT_ID = 'provider-scope-owner-b-split';
const OWNER_B_SPLIT_LABEL = 'Owner B Split Beta';
const OWNER_B_UPDATED_DATE = new Date(OWNER_B_UPDATED_AT).toLocaleDateString(
  'en-US',
  { month: 'short', day: 'numeric' },
);

const mockOwnerBAccounts: Account[] = [
  {
    id: SHARED_ACCOUNT_ID,
    name: OWNER_B_ACCOUNT_NAME,
    startingBalance: OWNER_B_STARTING_BALANCE,
    sortOrder: 0,
    createdAt: 1_700_100_000_000,
    updatedAt: 1_700_100_000_000,
  },
  mockCashAccount,
];

const mockOwnerBTransactions: Transaction[] = [
  {
    id: OWNER_B_TRANSACTION_ID,
    amount: OWNER_B_TRANSACTION_AMOUNT,
    date: '2020-01-01',
    type: 'expense',
    category: 'Reconciliation',
    fromAccount: SHARED_ACCOUNT_ID,
    toAccount: null,
    description: 'Owner B reconciliation expense',
    createdAt: 1_700_100_000_000,
    updatedAt: 1_700_100_000_000,
  },
];

const mockOwnerBSnapshots: BalanceSnapshotMap = {
  [SHARED_ACCOUNT_ID]: {
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

const OWNER_B_EXPECTED = calculateExpectedBalances(
  mockOwnerBTransactions,
  mockOwnerBAccounts,
  getToday(),
)[0].expected;
const OWNER_B_DIFFERENCE = Math.abs(
  OWNER_B_EXPECTED - OWNER_B_CURRENT_VALUE,
);

// ---------------------------------------------------------------------------
// Commit capture
// ---------------------------------------------------------------------------

interface ProviderSnapshot {
  readonly authState: AuthStateName;
  readonly userId: string | null;
  readonly generation: number;
  readonly isScopeVerified: boolean;
  readonly error: string | null;
  readonly accounts: readonly Account[];
  readonly transactions: readonly Transaction[];
}

interface PageCommit {
  readonly provider: ProviderSnapshot | null;
  readonly text: string;
  readonly inputValues: readonly string[];
  readonly reads: number;
  readonly upserts: number;
}

interface SnapshotCallScope {
  readonly isScopeVerified: boolean;
  readonly userId: string | null;
  readonly generation: number;
}

let latestProviderSnapshot: ProviderSnapshot | null = null;
let mockSnapshotReadScopes: SnapshotCallScope[] = [];
let mockSnapshotWriteScopes: SnapshotCallScope[] = [];

/** Records the provider's committed render before the Profiler commit fires. */
function ProviderRenderProbe({
  onRender,
}: {
  onRender: (snapshot: ProviderSnapshot) => void;
}) {
  const { state, user, authGeneration } = useAuth();
  const { accounts, transactions, isLoading, isScopeVerified, error } =
    useTransactionContext();

  onRender({
    authState: state,
    userId: user?.id ?? null,
    generation: authGeneration,
    isScopeVerified,
    error,
    accounts,
    transactions,
  });

  return (
    <div>
      <div data-testid="provider-verified">{String(isScopeVerified)}</div>
      <div data-testid="provider-loading">{String(isLoading)}</div>
      <div data-testid="provider-error">{error ?? ''}</div>
    </div>
  );
}

function isOwnerASourceCommit(commit: PageCommit): boolean {
  const provider = commit.provider;
  return (
    provider !== null &&
    provider.authState === 'authenticated' &&
    provider.userId === OWNER_A_USER_ID &&
    provider.isScopeVerified &&
    provider.accounts.some((account) => account.id === SHARED_ACCOUNT_ID) &&
    commit.text.includes(OWNER_A_ACCOUNT_NAME) &&
    commit.text.includes(formatCurrency(OWNER_A_CURRENT_VALUE)) &&
    commit.text.includes(formatCurrency(OWNER_A_EXPECTED)) &&
    commit.text.includes(formatCurrency(OWNER_A_DIFFERENCE)) &&
    commit.text.includes(OWNER_A_UPDATED_DATE) &&
    commit.inputValues.includes(OWNER_A_SPLIT_LABEL) &&
    commit.inputValues.includes(String(OWNER_A_CURRENT_VALUE))
  );
}

function isOwnerBSourceCommit(commit: PageCommit): boolean {
  const provider = commit.provider;
  return (
    provider !== null &&
    provider.authState === 'authenticated' &&
    provider.userId === OWNER_B_USER_ID &&
    provider.isScopeVerified &&
    provider.accounts.some((account) => account.id === SHARED_ACCOUNT_ID) &&
    commit.text.includes(OWNER_B_ACCOUNT_NAME) &&
    commit.text.includes(formatCurrency(OWNER_B_CURRENT_VALUE)) &&
    commit.text.includes(formatCurrency(OWNER_B_EXPECTED)) &&
    commit.text.includes(formatCurrency(OWNER_B_DIFFERENCE)) &&
    commit.text.includes(OWNER_B_UPDATED_DATE) &&
    commit.inputValues.includes(OWNER_B_SPLIT_LABEL) &&
    commit.inputValues.includes(String(OWNER_B_CURRENT_VALUE))
  );
}

function expectNoOwnerAFinancialData(commit: PageCommit): void {
  expect(commit.text).not.toContain(OWNER_A_ACCOUNT_NAME);
  expect(commit.text).not.toContain(formatCurrency(OWNER_A_CURRENT_VALUE));
  expect(commit.text).not.toContain(formatCurrency(OWNER_A_EXPECTED));
  expect(commit.text).not.toContain(formatCurrency(OWNER_A_DIFFERENCE));
  expect(commit.text).not.toContain(OWNER_A_UPDATED_DATE);
  expect(commit.text).not.toContain(OWNER_A_SPLIT_LABEL);
  expect(commit.text).not.toContain(String(OWNER_A_CURRENT_VALUE));
  expect(commit.inputValues).not.toContain(OWNER_A_SPLIT_LABEL);
  expect(commit.inputValues).not.toContain(String(OWNER_A_CURRENT_VALUE));
}

// ---------------------------------------------------------------------------
// Regression
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();

  const initialGeneration = publishAuthIdentity({ state: 'loading' });
  mockAuthState = {
    state: 'loading',
    user: null,
    authGeneration: initialGeneration,
    signOut: jest.fn(),
  };

  mockSnapshotDataset = 'A';
  mockPendingSync = new Promise<void>(() => {});
  mockBackgroundSync.mockReturnValue(mockPendingSync);

  latestProviderSnapshot = null;
  mockSnapshotReadScopes = [];
  mockCashTotalChange = null;
  mockSnapshotWriteScopes = [];

  mockGetAllAccounts.mockResolvedValue(mockOwnerAAccounts);
  mockGetAllTransactions.mockResolvedValue(mockOwnerATransactions);
  mockGetAllCategories.mockResolvedValue([]);
  mockHasAnyLocalData.mockResolvedValue(false);

  mockGetBalanceSnapshots.mockImplementation(async () => {
    mockSnapshotReadScopes.push({
      isScopeVerified: latestProviderSnapshot?.isScopeVerified ?? false,
      userId: latestProviderSnapshot?.userId ?? null,
      generation: latestProviderSnapshot?.generation ?? -1,
    });
    return mockSnapshotDataset === 'A'
      ? mockOwnerASnapshots
      : mockOwnerBSnapshots;
  });
  mockUpsertBalanceSnapshot.mockImplementation(async () => {
    mockSnapshotWriteScopes.push({
      isScopeVerified: latestProviderSnapshot?.isScopeVerified ?? false,
      userId: latestProviderSnapshot?.userId ?? null,
      generation: latestProviderSnapshot?.generation ?? -1,
    });
  });

  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  cleanup();
});

test('isolates owner A financial state from a locked owner B transition and switches only to verified owner B data', async () => {
  localStorage.setItem(LAST_USER_STORAGE_KEY, OWNER_A_USER_ID);
  const ownerAGeneration = actAsAuthenticated(OWNER_A_USER_ID);

  const commits: PageCommit[] = [];
  const recordCommit: React.ProfilerOnRenderCallback = () => {
    commits.push({
      provider: latestProviderSnapshot,
      text: document.body.textContent ?? '',
      inputValues: Array.from(
        document.querySelectorAll('input'),
        (input) => input.value,
      ),
      reads: mockGetBalanceSnapshots.mock.calls.length,
      upserts: mockUpsertBalanceSnapshot.mock.calls.length,
    });
  };
  const tree = () => (
    <TransactionProvider>
      <ProviderRenderProbe
        onRender={(snapshot) => {
          latestProviderSnapshot = snapshot;
        }}
      />
      <React.Profiler
        id="available-balance-provider-scope"
        onRender={recordCommit}
      >
        <AvailableBalancePage />
      </React.Profiler>
    </TransactionProvider>
  );

  const view = render(tree());

  await waitFor(() =>
    expect(screen.getByTestId('provider-loading').textContent).toBe('false'),
  );
  await waitFor(() => expect(commits.some(isOwnerASourceCommit)).toBe(true));
  await waitFor(() => {
    expect(mockCashTotalChange).not.toBeNull();
  });
  const ownerACashCallback = mockCashTotalChange;
  if (ownerACashCallback === null) {
    throw new Error('owner A cash callback was not mounted');
  }
  await waitFor(() => expect(mockUpsertBalanceSnapshot).toHaveBeenCalled());
  await act(async () => {});

  // Precondition: A's verification, rows, snapshot value, timestamp, and
  // sub-split are actually rendered and persisted before the transition.
  expect(mockGetBalanceSnapshots).toHaveBeenCalledTimes(1);
  for (const [accountId, payload] of mockUpsertBalanceSnapshot.mock.calls) {
    expect(accountId).toBe(SHARED_ACCOUNT_ID);
    expect(payload.value).toBe(OWNER_A_CURRENT_VALUE);
  }

  const readsBeforeB = mockGetBalanceSnapshots.mock.calls.length;
  const upsertsBeforeB = mockUpsertBalanceSnapshot.mock.calls.length;
  const commitsBeforeB = commits.length;
  const providerAccountReadsBeforeB = mockGetAllAccounts.mock.calls.length;
  const providerTransactionReadsBeforeB =
    mockGetAllTransactions.mock.calls.length;
  expect(readsBeforeB).toBe(1);
  expect(upsertsBeforeB).toBeGreaterThan(0);
  expect(localStorage.getItem(LAST_USER_STORAGE_KEY)).toBe(OWNER_A_USER_ID);
  expect(mockSnapshotReadScopes).toEqual([
    {
      isScopeVerified: true,
      userId: OWNER_A_USER_ID,
      generation: ownerAGeneration,
    },
  ]);
  expect(mockSnapshotWriteScopes).toHaveLength(upsertsBeforeB);
  for (const scope of mockSnapshotWriteScopes) {
    expect(scope.isScopeVerified).toBe(true);
    expect(scope.userId).toBe(OWNER_A_USER_ID);
    expect(scope.generation).toBe(ownerAGeneration);
  }

  // A → B with the marker still naming A. The provider keeps A's verification
  // proof and rows until its passive effect runs; the first B commit is the
  // one that must not expose them.
  const ownerBGeneration = actAsAuthenticated(OWNER_B_USER_ID);
  view.rerender(tree());
  await act(async () => {
    ownerACashCallback(9_999);
  });
  expect(mockUpsertBalanceSnapshot).toHaveBeenCalledTimes(upsertsBeforeB);
  expect(
    mockUpsertBalanceSnapshot.mock.calls.some(
      ([accountId, payload]) => accountId === 'cash' && payload.value === 9_999,
    ),
  ).toBe(false);

  await waitFor(() =>
    expect(screen.getByTestId('provider-error').textContent).toContain(
      'different signed-in account',
    ),
  );
  await act(async () => {});

  const commitsAfterBStart = commits.slice(commitsBeforeB);
  expect(commitsAfterBStart.length).toBeGreaterThan(0);

  const lockedOwnerBCommits = commitsAfterBStart.filter(
    (commit) =>
      commit.provider !== null && !commit.provider.isScopeVerified,
  );
  expect(lockedOwnerBCommits.length).toBeGreaterThan(0);

  const transitionCommit = lockedOwnerBCommits.find(
    (commit) => commit.provider?.userId === OWNER_B_USER_ID,
  );
  expect(transitionCommit).toBeDefined();
  if (!transitionCommit?.provider) {
    throw new Error('owner B transition commit was not captured');
  }

  // The provider still held A's proof and rows in this commit. The page is
  // therefore protected by its own scope handling, not by a pre-cleared
  // provider.
  expect(transitionCommit.provider.authState).toBe('authenticated');
  expect(transitionCommit.provider.generation).toBe(ownerBGeneration);
  expect(transitionCommit.provider.accounts.map((account) => account.id)).toContain(
    SHARED_ACCOUNT_ID,
  );
  expect(transitionCommit.provider.accounts[0]?.name).toBe(
    OWNER_A_ACCOUNT_NAME,
  );
  expect(
    transitionCommit.provider.transactions.map(
      (transaction) => transaction.id,
    ),
  ).toContain(OWNER_A_TRANSACTION_ID);

  // Every locked owner B commit, starting with the transition commit, is
  // financially empty and starts no balance-snapshot read or write.
  for (const commit of lockedOwnerBCommits) {
    expect(commit.provider?.isScopeVerified).toBe(false);
    expect(commit.reads).toBe(readsBeforeB);
    expect(commit.upserts).toBe(upsertsBeforeB);
    expectNoOwnerAFinancialData(commit);
  }

  // No owner A proof or rows leaked into any commit recorded after the switch.
  for (const commit of commitsAfterBStart) {
    expect(commit.provider?.userId).not.toBe(OWNER_A_USER_ID);
    expectNoOwnerAFinancialData(commit);
  }

  expect(screen.getByTestId('provider-verified').textContent).toBe('false');
  expect(localStorage.getItem(LAST_USER_STORAGE_KEY)).toBe(OWNER_A_USER_ID);
  expect(mockGetAllAccounts).toHaveBeenCalledTimes(
    providerAccountReadsBeforeB,
  );
  expect(mockGetAllTransactions).toHaveBeenCalledTimes(
    providerTransactionReadsBeforeB,
  );
  expect(mockHasAnyLocalData).not.toHaveBeenCalled();
  expect(mockAddTransaction).not.toHaveBeenCalled();
  expect(mockUpdateTransaction).not.toHaveBeenCalled();
  expect(mockDeleteTransaction).not.toHaveBeenCalled();
  expect(mockGetBalanceSnapshots).toHaveBeenCalledTimes(readsBeforeB);
  expect(mockUpsertBalanceSnapshot).toHaveBeenCalledTimes(upsertsBeforeB);

  // The provider never verifies B against a marker that names A. Hand local
  // ownership to B (the persisted proof the provider itself reads) and drive
  // a fresh B auth startup so the provider can reach its verified state.
  localStorage.setItem(LAST_USER_STORAGE_KEY, OWNER_B_USER_ID);
  mockSnapshotDataset = 'B';
  mockGetAllAccounts.mockResolvedValue(mockOwnerBAccounts);
  mockGetAllTransactions.mockResolvedValue(mockOwnerBTransactions);
  mockGetAllCategories.mockResolvedValue([]);

  const phase2Start = commits.length;
  const readsBeforeVerification = mockGetBalanceSnapshots.mock.calls.length;
  const upsertsBeforeVerification =
    mockUpsertBalanceSnapshot.mock.calls.length;

  actAsLoading();
  view.rerender(tree());
  await act(async () => {});

  const verifiedBGeneration = actAsAuthenticated(OWNER_B_USER_ID);
  view.rerender(tree());

  await waitFor(() => expect(commits.some(isOwnerBSourceCommit)).toBe(true));
  await waitFor(() =>
    expect(mockUpsertBalanceSnapshot.mock.calls.length).toBeGreaterThan(
      upsertsBeforeVerification,
    ),
  );

  // A rerender after persistence gives the commit recorder a snapshot of the
  // post-write provider state; writes themselves run after a commit.
  view.rerender(tree());
  await act(async () => {});

  const finalCommit = commits[commits.length - 1];
  expect(finalCommit.provider?.isScopeVerified).toBe(true);
  expect(finalCommit.provider?.userId).toBe(OWNER_B_USER_ID);
  expect(finalCommit.upserts).toBeGreaterThan(upsertsBeforeVerification);
  expectNoOwnerAFinancialData(finalCommit);

  const phase2Commits = commits.slice(phase2Start);
  expect(phase2Commits.length).toBeGreaterThan(0);

  const lockedPhase2Commits = phase2Commits.filter(
    (commit) =>
      commit.provider !== null && !commit.provider.isScopeVerified,
  );
  expect(lockedPhase2Commits.length).toBeGreaterThan(0);
  for (const commit of lockedPhase2Commits) {
    expect(commit.reads).toBe(readsBeforeVerification);
    expect(commit.upserts).toBe(upsertsBeforeVerification);
    expectNoOwnerAFinancialData(commit);
  }

  // The first snapshot read after the switch happens only in a verified B
  // commit. Reaching it in a locked commit would mean the page read for B
  // before ownership was proven.
  const firstReadAfterB = commits
    .slice(commitsBeforeB)
    .find((commit) => commit.reads > readsBeforeVerification);
  expect(firstReadAfterB).toBeDefined();
  expect(firstReadAfterB?.provider?.isScopeVerified).toBe(true);
  expect(firstReadAfterB?.provider?.userId).toBe(OWNER_B_USER_ID);
  expect(mockGetBalanceSnapshots).toHaveBeenCalledTimes(
    readsBeforeVerification + 1,
  );

  // Call-time proof: the balance snapshot adapter was entered only while the
  // provider reported verified B at the current B generation.
  const postSwitchReadScopes = mockSnapshotReadScopes.slice(
    readsBeforeVerification,
  );
  expect(postSwitchReadScopes).toHaveLength(1);
  for (const scope of postSwitchReadScopes) {
    expect(scope.isScopeVerified).toBe(true);
    expect(scope.userId).toBe(OWNER_B_USER_ID);
    expect(scope.generation).toBe(verifiedBGeneration);
  }

  const ownerBSourceCommit = commits.find(isOwnerBSourceCommit);
  expect(ownerBSourceCommit).toBeDefined();
  if (!ownerBSourceCommit?.provider) {
    throw new Error('owner B source commit was not captured');
  }
  const ownerBProvider = ownerBSourceCommit.provider;
  expect(ownerBProvider.authState).toBe('authenticated');
  expect(ownerBProvider.userId).toBe(OWNER_B_USER_ID);
  expect(ownerBProvider.isScopeVerified).toBe(true);
  expect(ownerBProvider.accounts.map((account) => account.name)).toEqual([
    OWNER_B_ACCOUNT_NAME,
    'Cash',
  ]);
  expect(
    ownerBProvider.transactions.map((transaction) => transaction.id),
  ).toEqual([OWNER_B_TRANSACTION_ID]);

  // B's context data and snapshot are the only financial content present.
  expect(ownerBSourceCommit.text).toContain(OWNER_B_ACCOUNT_NAME);
  expect(ownerBSourceCommit.text).toContain(
    formatCurrency(OWNER_B_EXPECTED),
  );
  expect(ownerBSourceCommit.text).toContain(
    formatCurrency(OWNER_B_DIFFERENCE),
  );
  expect(ownerBSourceCommit.text).toContain(OWNER_B_UPDATED_DATE);
  expectNoOwnerAFinancialData(ownerBSourceCommit);

  for (const commit of commits.slice(commitsBeforeB)) {
    expectNoOwnerAFinancialData(commit);
  }

  const postTransitionUpserts = mockUpsertBalanceSnapshot.mock.calls.slice(
    upsertsBeforeVerification,
  );
  expect(postTransitionUpserts.length).toBeGreaterThan(0);
  for (const [accountId, payload] of postTransitionUpserts) {
    expect(accountId).toBe(SHARED_ACCOUNT_ID);
    expect(payload.value).toBe(OWNER_B_CURRENT_VALUE);
    expect(payload.useSubSplit).toBe(true);
    expect((payload.subSplits ?? []).map((split) => split.label)).toEqual([
      OWNER_B_SPLIT_LABEL,
    ]);
  }

  const postSwitchWriteScopes = mockSnapshotWriteScopes.slice(
    upsertsBeforeVerification,
  );
  expect(postSwitchWriteScopes).toHaveLength(postTransitionUpserts.length);
  for (const scope of postSwitchWriteScopes) {
    expect(scope.isScopeVerified).toBe(true);
    expect(scope.userId).toBe(OWNER_B_USER_ID);
    expect(scope.generation).toBe(verifiedBGeneration);
  }

  const firstBUpsertCommitIndex = commits.findIndex(
    (commit) =>
      commit.upserts > upsertsBeforeVerification &&
      commit.provider?.isScopeVerified === true &&
      commit.provider?.userId === OWNER_B_USER_ID,
  );
  expect(firstBUpsertCommitIndex).toBeGreaterThan(-1);

  expect(mockGetAllAccounts).toHaveBeenCalledTimes(
    providerAccountReadsBeforeB + 1,
  );
  expect(mockGetAllTransactions).toHaveBeenCalledTimes(
    providerTransactionReadsBeforeB + 1,
  );
  expect(mockAddTransaction).not.toHaveBeenCalled();
  expect(mockUpdateTransaction).not.toHaveBeenCalled();
  expect(mockDeleteTransaction).not.toHaveBeenCalled();
  expect(localStorage.getItem(LAST_USER_STORAGE_KEY)).toBe(OWNER_B_USER_ID);
});
