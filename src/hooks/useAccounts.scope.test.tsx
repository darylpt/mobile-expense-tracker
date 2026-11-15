// ============================================================
// useAccounts.scope.test.tsx — Render-time scope isolation regression
//
// Observes the public useAccounts() return from a real mounted component on
// every render. Only the transaction-context boundary (scope verification and
// identity generation) and the IndexedDB read are doubled; React rendering and
// the hook implementation stay real.
//
// The regression under test: useAccounts keeps its previously loaded accounts
// in state until a passive effect clears them. The first render after the
// scope is revoked (or the identity generation changes) must therefore not
// contain the old owner's account. The same fence has to hold for an
// in-flight refresh: its success or error must not publish into a scope that
// is no longer the one it started under.
// ============================================================

import React from 'react';
import type * as ReactNamespace from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Account } from '@/types';
import { publishAuthIdentity, type AuthIdentity } from '@/lib/auth-scope';
import { LAST_USER_STORAGE_KEY } from '@/lib/constants';
import {
  addAccount as addAccountInDB,
  deleteAccount as deleteAccountInDB,
  getAllAccounts,
  moveAccountTo as moveAccountToInDB,
  updateAccount as updateAccountInDB,
} from '@/lib/idb';
import { useAccounts } from './useAccounts';

// ---------------------------------------------------------------------------
// Transaction-context boundary double
//
// A tiny external store drives the values useAccounts consumes. Publishing a
// new snapshot re-renders every mounted consumer synchronously, exactly like
// an auth/scope transition does.
// ---------------------------------------------------------------------------

interface MockScope {
  readonly isScopeVerified: boolean;
  readonly identity: string;
  readonly generation: number;
  readonly authenticated: boolean;
  /** Auth descriptor override: without Supabase the app reports `disabled`. */
  readonly authState?: 'disabled';
  /** Authenticated render without a resolved user object. */
  readonly omitUser?: boolean;
}

const mockScopeListeners = new Set<() => void>();

let mockScope: MockScope = {
  isScopeVerified: false,
  identity: 'initial-unverified',
  generation: 0,
  authenticated: false,
};

function mockGetScope(): MockScope {
  return mockScope;
}

function mockSubscribeScope(listener: () => void): () => void {
  mockScopeListeners.add(listener);
  return () => {
    mockScopeListeners.delete(listener);
  };
}

type ScopeSeed = Omit<MockScope, 'generation' | 'authenticated'>;

function toAuthIdentity(scope: ScopeSeed): AuthIdentity {
  return scope.isScopeVerified
    ? { state: 'authenticated', userId: scope.identity }
    : { state: 'unauthenticated' };
}

/**
 * Publishes through the real auth-scope module and mirrors the generation it
 * returns into the React-facing snapshot, so useAuth and getAuthGeneration
 * always observe the same identity transition.
 */
function mockPublishScope(next: ScopeSeed): void {
  const generation = publishAuthIdentity(toAuthIdentity(next));
  if (next.isScopeVerified) {
    localStorage.setItem(LAST_USER_STORAGE_KEY, next.identity);
  } else {
    localStorage.removeItem(LAST_USER_STORAGE_KEY);
  }
  mockScope = {
    ...next,
    generation,
    authenticated: next.isScopeVerified,
  };
  for (const listener of [...mockScopeListeners]) listener();
}

/** Changes authorization without publishing a new auth identity generation. */
function mockSetVerification(isScopeVerified: boolean): void {
  mockScope = { ...mockScope, isScopeVerified };
  if (isScopeVerified) {
    localStorage.setItem(LAST_USER_STORAGE_KEY, mockScope.identity);
  } else {
    localStorage.removeItem(LAST_USER_STORAGE_KEY);
  }
  for (const listener of [...mockScopeListeners]) listener();
}

const mockRefreshTransactions = jest.fn(async (): Promise<void> => {});

jest.mock('@/context/TransactionContext', () => {
  const ReactModule = jest.requireActual<typeof ReactNamespace>('react');
  return {
    useTransactionContext: () => {
      const scope = ReactModule.useSyncExternalStore(
        mockSubscribeScope,
        mockGetScope,
        mockGetScope,
      );
      return {
        isScopeVerified: scope.isScopeVerified,
        authGeneration: scope.generation,
        refreshTransactions: mockRefreshTransactions,
      };
    },
  };
});

// ---------------------------------------------------------------------------
// Auth boundary double
//
// The hook may read authGeneration/user identity from useAuth to fence work
// created under an older identity. The same external store drives this so the
// generation and user always move with the transaction-context scope.
// ---------------------------------------------------------------------------

jest.mock('@/context/AuthContext', () => {
  const ReactModule = jest.requireActual<typeof ReactNamespace>('react');
  return {
    useAuth: () => {
      const scope = ReactModule.useSyncExternalStore(
        mockSubscribeScope,
        mockGetScope,
        mockGetScope,
      );
      return {
        state:
          scope.authState ??
          (scope.authenticated ? 'authenticated' : 'unauthenticated'),
        user:
          scope.authenticated && !scope.omitUser
            ? { id: scope.identity }
            : null,
        authGeneration: scope.generation,
      };
    },
  };
});

jest.mock('@/lib/idb', () => ({
  getAllAccounts: jest.fn(),
  addAccount: jest.fn(),
  updateAccount: jest.fn(),
  deleteAccount: jest.fn(),
  moveAccountTo: jest.fn(),
}));

const mockGetAllAccounts = getAllAccounts as jest.MockedFunction<
  typeof getAllAccounts
>;
const mockAddAccount = addAccountInDB as jest.MockedFunction<
  typeof addAccountInDB
>;
const mockUpdateAccount = updateAccountInDB as jest.MockedFunction<
  typeof updateAccountInDB
>;
const mockDeleteAccount = deleteAccountInDB as jest.MockedFunction<
  typeof deleteAccountInDB
>;
const mockMoveAccountTo = moveAccountToInDB as jest.MockedFunction<
  typeof moveAccountToInDB
>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER_A: ScopeSeed = {
  isScopeVerified: true,
  identity: 'scope-owner-a',
};

/** Verification revoked and the identity generation advanced. */
const OWNER_B_REVOKED: ScopeSeed = {
  isScopeVerified: false,
  identity: 'scope-owner-b',
};

/** The identity generation advanced and the new scope is verified. */
const OWNER_B_VERIFIED: ScopeSeed = {
  isScopeVerified: true,
  identity: 'scope-owner-b',
};

const ACCOUNT_A_NAME = 'Scope Fence Owner A Account';
const ACCOUNT_B_NAME = 'Scope Fence Owner B Account';

function makeOwnerAAccount(): Account {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: ACCOUNT_A_NAME,
    startingBalance: 125,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeOwnerBAccount(): Account {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    name: ACCOUNT_B_NAME,
    startingBalance: 50,
    sortOrder: 0,
    createdAt: 2,
    updatedAt: 2,
  };
}

// ---------------------------------------------------------------------------
// Render probe
// ---------------------------------------------------------------------------

type AccountDraft = Omit<Account, 'id' | 'createdAt' | 'updatedAt'>;
type AddAccountCallback = (account: AccountDraft) => Promise<string>;
type UpdateAccountCallback = (
  account: Partial<Account> & Pick<Account, 'id'>,
) => Promise<void>;
type DeleteAccountCallback = (id: string) => Promise<void>;
type MoveAccountToCallback = (
  id: string,
  targetIndex: number,
) => Promise<void>;

interface ProbeRender {
  readonly accountNames: readonly string[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refreshAccounts: () => Promise<void>;
  readonly addAccount: AddAccountCallback;
  readonly updateAccount: UpdateAccountCallback;
  readonly deleteAccount: DeleteAccountCallback;
  readonly moveAccountTo: MoveAccountToCallback;
  readonly scope: MockScope;
}

function AccountsProbe({
  onRender,
}: {
  onRender: (render: ProbeRender) => void;
}): React.ReactElement {
  const {
    accounts,
    isLoading,
    error,
    refreshAccounts,
    addAccount,
    updateAccount,
    deleteAccount,
    moveAccountTo,
  } = useAccounts();
  onRender({
    accountNames: accounts.map((account) => account.name),
    isLoading,
    error,
    refreshAccounts,
    addAccount,
    updateAccount,
    deleteAccount,
    moveAccountTo,
    scope: mockGetScope(),
  });
  return (
    <ul data-testid="account-list">
      {accounts.map((account) => (
        <li key={account.id}>{account.name}</li>
      ))}
    </ul>
  );
}

/** A render produced for an identity that must never see owner A's account. */
function isOutsideOwnerA(render: ProbeRender): boolean {
  return (
    !render.scope.isScopeVerified || render.scope.identity !== OWNER_A.identity
  );
}

describe('useAccounts auth-scope isolation', () => {
  beforeEach(() => {
    mockScopeListeners.clear();
    mockPublishScope({
      isScopeVerified: false,
      identity: 'initial-unverified',
    });
    mockGetAllAccounts.mockReset();
    mockAddAccount.mockReset();
    mockUpdateAccount.mockReset();
    mockDeleteAccount.mockReset();
    mockMoveAccountTo.mockReset();
    mockRefreshTransactions.mockReset();
  });

  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
  });

  it('does not expose the previous owner account on the first render after scope revocation', async () => {
    const accountA = makeOwnerAAccount();
    mockGetAllAccounts.mockResolvedValue([accountA]);

    mockPublishScope(OWNER_A);
    const renders: ProbeRender[] = [];

    render(<AccountsProbe onRender={(probeRender) => renders.push(probeRender)} />);

    await waitFor(() =>
      expect(screen.queryByText(ACCOUNT_A_NAME)).not.toBeNull(),
    );

    // The matching-owner state is visible before the invalidation.
    const verifiedOwnerARender = renders.find(
      (probeRender) =>
        probeRender.scope.isScopeVerified &&
        probeRender.scope.identity === OWNER_A.identity &&
        probeRender.accountNames.includes(ACCOUNT_A_NAME),
    );
    expect(verifiedOwnerARender).toBeTruthy();
    expect(
      renders.filter(isOutsideOwnerA).some((probeRender) =>
        probeRender.accountNames.includes(ACCOUNT_A_NAME),
      ),
    ).toBe(false);

    // Revoke verification and advance the identity generation without
    // unmounting the probe.
    act(() => {
      mockPublishScope(OWNER_B_REVOKED);
    });

    await waitFor(() => expect(screen.queryByText(ACCOUNT_A_NAME)).toBeNull());

    // Every render, including the first one after revocation, must be clean.
    const leakedRenders = renders.filter(
      (probeRender) =>
        isOutsideOwnerA(probeRender) &&
        probeRender.accountNames.includes(ACCOUNT_A_NAME),
    );
    expect(leakedRenders).toEqual([]);
  });

  it('never publishes a late owner A read after the identity generation changes', async () => {
    const accountA = makeOwnerAAccount();
    const pendingRead = Promise.withResolvers<Account[]>();
    mockGetAllAccounts.mockReturnValue(pendingRead.promise);

    mockPublishScope(OWNER_A);
    const renders: ProbeRender[] = [];

    render(<AccountsProbe onRender={(probeRender) => renders.push(probeRender)} />);

    // The hook started reading while owner A was verified.
    expect(mockGetAllAccounts).toHaveBeenCalledTimes(1);

    act(() => {
      mockPublishScope(OWNER_B_REVOKED);
    });

    // The owner A read settles only after the scope changed.
    await act(async () => {
      pendingRead.resolve([accountA]);
      await pendingRead.promise;
      await Promise.resolve();
    });

    const leakedRenders = renders.filter(
      (probeRender) =>
        isOutsideOwnerA(probeRender) &&
        probeRender.accountNames.includes(ACCOUNT_A_NAME),
    );
    expect(leakedRenders).toEqual([]);
  });

  it('does not publish an owner A refresh success after the scope is revoked', async () => {
    const accountA = makeOwnerAAccount();
    const refreshRead = Promise.withResolvers<Account[]>();

    // The initial load settles empty; the refresh stays in flight until
    // after the scope invalidation. Any later read (including a fresh B
    // load) settles empty rather than undefined.
    mockGetAllAccounts
      .mockResolvedValue([])
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(refreshRead.promise);

    mockPublishScope(OWNER_A);
    const renders: ProbeRender[] = [];

    render(<AccountsProbe onRender={(probeRender) => renders.push(probeRender)} />);

    await waitFor(() =>
      expect(renders[renders.length - 1]?.isLoading).toBe(false),
    );
    expect(mockGetAllAccounts).toHaveBeenCalledTimes(1);

    const ownerARender = renders[renders.length - 1];
    expect(ownerARender.scope.isScopeVerified).toBe(true);
    expect(ownerARender.scope.identity).toBe(OWNER_A.identity);

    let refreshPromise: Promise<void> = Promise.resolve();
    act(() => {
      refreshPromise = ownerARender.refreshAccounts();
    });
    // The refresh read was requested while owner A was still verified.
    expect(mockGetAllAccounts).toHaveBeenCalledTimes(2);

    act(() => {
      mockPublishScope(OWNER_B_REVOKED);
    });

    // The refresh succeeds only after verification was revoked.
    await act(async () => {
      refreshRead.resolve([accountA]);
      await refreshPromise;
      await Promise.resolve();
    });

    // The settled refresh must not surface owner A's account in the revoked
    // scope, on any render.
    const leakedRenders = renders.filter(
      (probeRender) =>
        isOutsideOwnerA(probeRender) &&
        probeRender.accountNames.includes(ACCOUNT_A_NAME),
    );
    expect(leakedRenders).toEqual([]);
  });

  it('does not publish an owner A refresh error after the identity generation changes', async () => {
    const staleErrorMessage = 'owner A refresh failed';
    const refreshRead = Promise.withResolvers<Account[]>();
    jest.spyOn(console, 'error').mockImplementation(() => {});

    // The initial load settles empty; the refresh stays in flight until after
    // the identity generation changes. Any later read (including a fresh B
    // load) settles empty rather than undefined.
    mockGetAllAccounts
      .mockResolvedValue([])
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(refreshRead.promise);

    mockPublishScope(OWNER_A);
    const renders: ProbeRender[] = [];

    render(<AccountsProbe onRender={(probeRender) => renders.push(probeRender)} />);

    await waitFor(() =>
      expect(renders[renders.length - 1]?.isLoading).toBe(false),
    );
    expect(mockGetAllAccounts).toHaveBeenCalledTimes(1);

    const ownerARender = renders[renders.length - 1];
    expect(ownerARender.scope.isScopeVerified).toBe(true);
    expect(ownerARender.scope.identity).toBe(OWNER_A.identity);

    let refreshPromise: Promise<void> = Promise.resolve();
    act(() => {
      refreshPromise = ownerARender.refreshAccounts();
    });
    // The refresh read was requested while owner A was still verified.
    expect(mockGetAllAccounts).toHaveBeenCalledTimes(2);

    act(() => {
      mockPublishScope(OWNER_B_VERIFIED);
    });

    // The refresh rejects only after the identity generation advanced.
    await act(async () => {
      refreshRead.reject(new Error(staleErrorMessage));
      await refreshPromise;
      await Promise.resolve();
    });

    // The stale owner A operation error must not surface in the new scope.
    const leakedErrors = renders.filter(
      (probeRender) =>
        isOutsideOwnerA(probeRender) && probeRender.error !== null,
    );
    expect(leakedErrors).toEqual([]);
  });

  it('does not let a saved owner A refresh read or publish after the identity generation changes', async () => {
    const accountA = makeOwnerAAccount();
    const staleErrorMessage = 'stale owner A refresh';
    jest.spyOn(console, 'error').mockImplementation(() => {});

    // Owner A's initial load returns its account. Every later read — the
    // fresh owner B load and any stale read — resolves empty.
    mockGetAllAccounts.mockResolvedValue([]).mockResolvedValueOnce([accountA]);

    mockPublishScope(OWNER_A);
    const renders: ProbeRender[] = [];

    render(<AccountsProbe onRender={(probeRender) => renders.push(probeRender)} />);

    await waitFor(() =>
      expect(screen.queryByText(ACCOUNT_A_NAME)).not.toBeNull(),
    );
    expect(mockGetAllAccounts).toHaveBeenCalledTimes(1);

    const ownerARender = renders[renders.length - 1];
    expect(ownerARender.scope.isScopeVerified).toBe(true);
    expect(ownerARender.scope.identity).toBe(OWNER_A.identity);
    const savedOwnerARefresh = ownerARender.refreshAccounts;

    await act(async () => {
      mockPublishScope(OWNER_B_VERIFIED);
      await Promise.resolve();
    });

    await waitFor(() => {
      const latest = renders[renders.length - 1];
      expect(latest?.scope.isScopeVerified).toBe(true);
      expect(latest?.scope.identity).toBe(OWNER_B_VERIFIED.identity);
    });

    // Let a generation-keyed fresh owner B read settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const readsBeforeStaleRefresh = mockGetAllAccounts.mock.calls.length;
    const rendersBeforeStaleRefresh = renders.length;

    // A legacy, unfenced callback would issue another read here. The saved
    // callback must be inert, so the rejection is never observed either.
    mockGetAllAccounts.mockRejectedValueOnce(new Error(staleErrorMessage));

    await act(async () => {
      // A stale callback may reject; the contract constrains its reads and
      // publishes, not its settlement value.
      await savedOwnerARefresh().catch(() => {});
      await Promise.resolve();
    });

    expect(mockGetAllAccounts).toHaveBeenCalledTimes(readsBeforeStaleRefresh);

    // Invoking the saved callback must not republish the old owner's data or
    // an error on top of the new identity's empty state.
    const rendersAfterStaleRefresh = renders.slice(rendersBeforeStaleRefresh);
    expect(
      rendersAfterStaleRefresh.some((probeRender) =>
        probeRender.accountNames.includes(ACCOUNT_A_NAME),
      ),
    ).toBe(false);
    expect(
      rendersAfterStaleRefresh.some((probeRender) => probeRender.error !== null),
    ).toBe(false);
  });

  it('does not let saved owner A CRUD callbacks reach IndexedDB mutations after the identity changes', async () => {
    const accountA = makeOwnerAAccount();
    const accountB = makeOwnerBAccount();

    // Owner A's initial load returns its account. The fresh owner B load
    // returns B's own list; no additional read is needed.
    mockGetAllAccounts
      .mockResolvedValueOnce([accountA])
      .mockResolvedValue([accountB]);

    mockPublishScope(OWNER_A);
    const renders: ProbeRender[] = [];

    render(<AccountsProbe onRender={(probeRender) => renders.push(probeRender)} />);

    await waitFor(() =>
      expect(screen.queryByText(ACCOUNT_A_NAME)).not.toBeNull(),
    );

    const ownerARender = renders[renders.length - 1];
    expect(ownerARender.scope.isScopeVerified).toBe(true);
    expect(ownerARender.scope.identity).toBe(OWNER_A.identity);
    const savedOwnerACallbacks = {
      addAccount: ownerARender.addAccount,
      updateAccount: ownerARender.updateAccount,
      deleteAccount: ownerARender.deleteAccount,
      moveAccountTo: ownerARender.moveAccountTo,
    };

    // Advance the real auth generation to a verified owner B.
    const generationBeforeTransition = mockGetScope().generation;
    await act(async () => {
      mockPublishScope(OWNER_B_VERIFIED);
      await Promise.resolve();
    });
    expect(mockGetScope().generation).toBeGreaterThan(
      generationBeforeTransition,
    );

    await waitFor(() => {
      const latest = renders[renders.length - 1];
      expect(latest?.scope.isScopeVerified).toBe(true);
      expect(latest?.scope.identity).toBe(OWNER_B_VERIFIED.identity);
      expect(latest?.accountNames).toEqual([ACCOUNT_B_NAME]);
      expect(latest?.isLoading).toBe(false);
    });

    const readsBeforeStaleCallbacks = mockGetAllAccounts.mock.calls.length;
    const rendersBeforeStaleCallbacks = renders.length;

    await act(async () => {
      // A saved owner A callback may reject under the new scope; the contract
      // constrains its writes and publishes, not its settlement value.
      await Promise.all([
        savedOwnerACallbacks
          .addAccount({
            name: 'Stale Owner A Add',
            startingBalance: 1,
            sortOrder: 1,
          })
          .catch(() => {}),
        savedOwnerACallbacks
          .updateAccount({ id: accountA.id, name: 'Stale Owner A Update' })
          .catch(() => {}),
        savedOwnerACallbacks.deleteAccount(accountA.id).catch(() => {}),
        savedOwnerACallbacks.moveAccountTo(accountA.id, 1).catch(() => {}),
      ]);
      await Promise.resolve();
    });

    // No saved owner A callback may reach a mutation under owner B.
    expect(mockAddAccount).not.toHaveBeenCalled();
    expect(mockUpdateAccount).not.toHaveBeenCalled();
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(mockMoveAccountTo).not.toHaveBeenCalled();
    expect(mockGetAllAccounts).toHaveBeenCalledTimes(readsBeforeStaleCallbacks);

    // Owner B's fresh list and clean error state must survive the stale
    // callbacks, on every render they produce.
    const rendersAfterStaleCallbacks = renders.slice(rendersBeforeStaleCallbacks);
    expect(
      rendersAfterStaleCallbacks.some((probeRender) =>
        probeRender.accountNames.includes(ACCOUNT_A_NAME),
      ),
    ).toBe(false);
    expect(
      rendersAfterStaleCallbacks.some((probeRender) => probeRender.error !== null),
    ).toBe(false);

    expect(screen.queryByText(ACCOUNT_A_NAME)).toBeNull();
    expect(screen.getByText(ACCOUNT_B_NAME)).toBeTruthy();

    const latest = renders[renders.length - 1];
    expect(latest.scope.isScopeVerified).toBe(true);
    expect(latest.scope.identity).toBe(OWNER_B_VERIFIED.identity);
    expect(latest.accountNames).toEqual([ACCOUNT_B_NAME]);
    expect(latest.error).toBeNull();
  });
  it.each(['success', 'failure'] as const)(
    'keeps the reverification read authoritative when an earlier read later returns %s',
    async (outcome) => {
      const pendingOldRead = Promise.withResolvers<Account[]>();
      const replacementAccount = {
        ...makeOwnerAAccount(),
        id: 'replacement-scope-account',
        name: 'Replacement Scope Account',
      };
      mockGetAllAccounts
        .mockReturnValueOnce(pendingOldRead.promise)
        .mockResolvedValueOnce([replacementAccount]);
      mockPublishScope(OWNER_A);
      const renders: ProbeRender[] = [];

      render(
        <AccountsProbe onRender={(probeRender) => renders.push(probeRender)} />,
      );
      expect(mockGetAllAccounts).toHaveBeenCalledTimes(1);

      const generation = mockScope.generation;
      act(() => mockSetVerification(false));
      act(() => mockSetVerification(true));
      expect(mockScope.generation).toBe(generation);

      await waitFor(() => {
        expect(screen.getByText('Replacement Scope Account')).toBeTruthy();
        expect(renders[renders.length - 1]?.isLoading).toBe(false);
      });

      await act(async () => {
        if (outcome === 'success') {
          pendingOldRead.resolve([makeOwnerBAccount()]);
        } else {
          pendingOldRead.reject(new Error('stale initial account read'));
        }
        await pendingOldRead.promise.catch(() => {});
      });

      const latest = renders[renders.length - 1];
      expect(latest.accountNames).toEqual(['Replacement Scope Account']);
      expect(latest.error).toBeNull();
      expect(latest.isLoading).toBe(false);
      expect(screen.queryByText(ACCOUNT_B_NAME)).toBeNull();
      expect(screen.getByText('Replacement Scope Account')).toBeTruthy();
    },
  );
  it.each(['success', 'failure'] as const)(
    'keeps the reverification read authoritative when an earlier refresh later returns %s',
    async (outcome) => {
      const initialAccount = makeOwnerAAccount();
      const replacementAccount = {
        ...makeOwnerAAccount(),
        id: 'refresh-replacement-scope-account',
        name: 'Refresh Replacement Scope Account',
      };
      const pendingRefresh = Promise.withResolvers<Account[]>();
      mockGetAllAccounts
        .mockResolvedValueOnce([initialAccount])
        .mockReturnValueOnce(pendingRefresh.promise)
        .mockResolvedValueOnce([replacementAccount]);
      mockPublishScope(OWNER_A);
      const renders: ProbeRender[] = [];

      render(
        <AccountsProbe onRender={(probeRender) => renders.push(probeRender)} />,
      );
      await waitFor(() =>
        expect(screen.getByText(ACCOUNT_A_NAME)).toBeTruthy(),
      );

      const generation = mockScope.generation;
      let staleRefresh: Promise<void> = Promise.resolve();
      act(() => {
        staleRefresh = renders[renders.length - 1].refreshAccounts();
      });
      await waitFor(() => expect(mockGetAllAccounts).toHaveBeenCalledTimes(2));

      act(() => mockSetVerification(false));
      act(() => mockSetVerification(true));
      expect(mockScope.generation).toBe(generation);
      await waitFor(() => {
        expect(screen.getByText('Refresh Replacement Scope Account')).toBeTruthy();
        expect(renders[renders.length - 1]?.isLoading).toBe(false);
      });

      await act(async () => {
        if (outcome === 'success') {
          pendingRefresh.resolve([makeOwnerBAccount()]);
        } else {
          pendingRefresh.reject(new Error('stale refresh read failure'));
        }
        await staleRefresh;
      });

      const latest = renders[renders.length - 1];
      expect(latest.accountNames).toEqual(['Refresh Replacement Scope Account']);
      expect(latest.error).toBeNull();
      expect(latest.isLoading).toBe(false);
      expect(screen.queryByText(ACCOUNT_B_NAME)).toBeNull();
      expect(screen.getByText('Refresh Replacement Scope Account')).toBeTruthy();
    },
  );

  it.each(['update', 'delete'] as const)(
    'does not continue an admitted %s after verification is revoked during its account refresh read',
    async (operation) => {
      const pendingAccountRead = Promise.withResolvers<Account[]>();
      mockGetAllAccounts
        .mockResolvedValueOnce([])
        .mockReturnValueOnce(pendingAccountRead.promise);
      mockPublishScope(OWNER_A);
      const renders: ProbeRender[] = [];

      render(
        <AccountsProbe onRender={(probeRender) => renders.push(probeRender)} />,
      );
      await waitFor(() =>
        expect(renders[renders.length - 1]?.isLoading).toBe(false),
      );

      const account = makeOwnerAAccount();
      mockUpdateAccount.mockResolvedValue(undefined);
      mockDeleteAccount.mockResolvedValue(undefined);
      let mutation: Promise<void> = Promise.resolve();
      act(() => {
        const callbacks = renders[renders.length - 1];
        mutation =
          operation === 'update'
            ? callbacks.updateAccount({ id: account.id, name: 'Updated' })
            : callbacks.deleteAccount(account.id);
      });
      await waitFor(() =>
        expect(
          operation === 'update' ? mockUpdateAccount : mockDeleteAccount,
        ).toHaveBeenCalledTimes(1),
      );
      await waitFor(() => expect(mockGetAllAccounts).toHaveBeenCalledTimes(2));

      act(() => mockSetVerification(false));
      await act(async () => {
        pendingAccountRead.resolve([]);
        await mutation;
      });

      expect(mockRefreshTransactions).not.toHaveBeenCalled();
      expect(renders[renders.length - 1]?.error).toBeNull();
      expect(renders[renders.length - 1]?.accountNames).toEqual([]);
    },
  );
  it('revocation and reverification replace the scope token without changing auth generation', async () => {
    const accountA = makeOwnerAAccount();
    mockGetAllAccounts.mockResolvedValue([accountA]);
    mockPublishScope(OWNER_A);
    const renders: ProbeRender[] = [];

    render(<AccountsProbe onRender={(probeRender) => renders.push(probeRender)} />);
    await waitFor(() =>
      expect(screen.queryByText(ACCOUNT_A_NAME)).not.toBeNull(),
    );

    const savedOwnerACallbacks = renders[renders.length - 1];
    const generation = mockScope.generation;
    act(() => mockSetVerification(false));
    expect(mockScope.generation).toBe(generation);
    expect(screen.queryByText(ACCOUNT_A_NAME)).toBeNull();

    act(() => mockSetVerification(true));
    expect(mockScope.generation).toBe(generation);
    await waitFor(() =>
      expect(renders[renders.length - 1]?.scope.isScopeVerified).toBe(true),
    );

    const readsBeforeStaleCalls = mockGetAllAccounts.mock.calls.length;
    await act(async () => {
      await savedOwnerACallbacks.refreshAccounts();
      await savedOwnerACallbacks
        .addAccount({ name: 'Stale Add', startingBalance: 1, sortOrder: 1 })
        .catch(() => {});
      await savedOwnerACallbacks
        .updateAccount({ id: accountA.id, name: 'Stale Update' })
        .catch(() => {});
      await savedOwnerACallbacks.deleteAccount(accountA.id).catch(() => {});
      await savedOwnerACallbacks.moveAccountTo(accountA.id, 1);
    });

    expect(mockGetAllAccounts).toHaveBeenCalledTimes(readsBeforeStaleCalls);
    expect(mockAddAccount).not.toHaveBeenCalled();
    expect(mockUpdateAccount).not.toHaveBeenCalled();
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(mockMoveAccountTo).not.toHaveBeenCalled();
  });

  it('does not refresh transactions when verification is revoked during the account refresh read', async () => {
    const pendingAccountRead = Promise.withResolvers<Account[]>();
    mockGetAllAccounts.mockResolvedValueOnce([]).mockReturnValueOnce(pendingAccountRead.promise);
    mockPublishScope(OWNER_A);
    const renders: ProbeRender[] = [];

    render(<AccountsProbe onRender={(probeRender) => renders.push(probeRender)} />);
    await waitFor(() =>
      expect(renders[renders.length - 1]?.isLoading).toBe(false),
    );
    mockAddAccount.mockResolvedValue('admitted-account-id');

    let addPromise: Promise<string> = Promise.resolve('');
    act(() => {
      addPromise = renders[renders.length - 1].addAccount({
        name: 'Admitted Account',
        startingBalance: 1,
        sortOrder: 1,
      });
    });
    await waitFor(() => expect(mockAddAccount).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockGetAllAccounts).toHaveBeenCalledTimes(2));

    act(() => mockSetVerification(false));
    await act(async () => {
      pendingAccountRead.resolve([]);
      await addPromise;
    });

    expect(mockAddAccount).toHaveBeenCalledTimes(1);
    expect(mockRefreshTransactions).not.toHaveBeenCalled();
  });

  it('reads local accounts for a verified Supabase-disabled scope', async () => {
    const accountA = makeOwnerAAccount();
    mockGetAllAccounts.mockResolvedValue([accountA]);

    mockPublishScope({
      isScopeVerified: true,
      identity: 'local-only-owner',
      authState: 'disabled',
      omitUser: true,
    });

    render(<AccountsProbe onRender={() => {}} />);

    await waitFor(() =>
      expect(screen.queryByText(ACCOUNT_A_NAME)).not.toBeNull(),
    );
    expect(mockGetAllAccounts).toHaveBeenCalled();
  });

  it('refuses an authenticated render that has no user id', async () => {
    const accountA = makeOwnerAAccount();
    mockGetAllAccounts.mockResolvedValue([accountA]);

    mockPublishScope({
      isScopeVerified: true,
      identity: 'userless-scope',
      omitUser: true,
    });

    render(<AccountsProbe onRender={() => {}} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockGetAllAccounts).not.toHaveBeenCalled();
    expect(screen.queryByText(ACCOUNT_A_NAME)).toBeNull();
  });
});
