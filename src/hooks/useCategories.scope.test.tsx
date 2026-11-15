// ============================================================
// useCategories.scope.test.tsx — Verification-only scope regression
//
// Observes the public useCategories() result from a real mounted component on
// every render. Only the context boundaries and the IndexedDB adapter are
// doubled; React rendering and the hook implementation stay real.
//
// Auth identity (state/user/generation) and transaction-context verification
// are independent dimensions of the same external-store snapshot. Revoking
// only verification must not advance the shared auth generation, and the
// first render of the locked scope must already be empty. The current hook
// keeps the previous owner's rows and filter result in state until a passive
// effect clears them, so this regression fails on that transition render.
// ============================================================

import React from 'react';
import type * as ReactNamespace from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Category, TransactionType } from '@/types';
import {
  getAuthGeneration,
  publishAuthIdentity,
  type AuthIdentity,
} from '@/lib/auth-scope';
import {
  addCategory as addCategoryInDB,
  deleteCategory as deleteCategoryInDB,
  getAllCategories,
  moveCategoryTo as moveCategoryToInDB,
  updateCategory as updateCategoryInDB,
} from '@/lib/idb';
import { useCategories } from './useCategories';

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
  getAllCategories: jest.fn(),
  addCategory: jest.fn(),
  updateCategory: jest.fn(),
  deleteCategory: jest.fn(),
  moveCategoryTo: jest.fn(),
}));

const mockGetAllCategories = jest.mocked(getAllCategories);
const mockAddCategory = jest.mocked(addCategoryInDB);
const mockUpdateCategory = jest.mocked(updateCategoryInDB);
const mockDeleteCategory = jest.mocked(deleteCategoryInDB);
const mockMoveCategoryTo = jest.mocked(moveCategoryToInDB);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER_A_USER_ID = 'scope-owner-a';
const OWNER_B_USER_ID = 'scope-owner-b';
const OWNER_A_CATEGORY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeOwnerAExpenseCategory(): Category {
  return {
    id: OWNER_A_CATEGORY_ID,
    name: 'Owner A Expense Category',
    type: 'expense',
    sortOrder: 0,
    hasDestinationAccount: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeCategory(
  id: string,
  name: string,
  type: TransactionType,
  sortOrder: number,
): Category {
  return {
    id,
    name,
    type,
    sortOrder,
    hasDestinationAccount: type === 'expense',
    createdAt: 10,
    updatedAt: 10,
  };
}

function makeOwnerBExpenseCategory(): Category {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    name: 'Owner B Expense Category',
    type: 'expense',
    sortOrder: 0,
    hasDestinationAccount: false,
    createdAt: 2,
    updatedAt: 2,
  };
}

// ---------------------------------------------------------------------------
// Render probe
// ---------------------------------------------------------------------------

type CategoryFilter = (type: TransactionType) => Category[];
type RefreshCategories = () => Promise<void>;
type CategoryDraft = Omit<Category, 'id' | 'createdAt' | 'updatedAt'>;
type AddCategory = (category: CategoryDraft) => Promise<string>;
type UpdateCategory = (
  category: Partial<Category> & Pick<Category, 'id'>,
) => Promise<void>;
type DeleteCategory = (id: string) => Promise<void>;
type MoveCategoryTo = (id: string, targetIndex: number) => Promise<void>;

interface ProbeCallbacks {
  readonly addCategory: AddCategory;
  readonly updateCategory: UpdateCategory;
  readonly deleteCategory: DeleteCategory;
  readonly moveCategoryTo: MoveCategoryTo;
}

interface ProbeRender extends ProbeCallbacks {
  readonly categories: readonly Category[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly income: readonly Category[];
  readonly expense: readonly Category[];
  readonly transaction: readonly Category[];
  readonly refreshCategories: RefreshCategories;
  readonly getCategoriesByType: CategoryFilter;
  readonly scope: MockBoundary;
}

function CategoriesProbe({
  onRender,
}: {
  onRender: (render: ProbeRender) => void;
}): React.ReactElement {
  const {
    categories,
    isLoading,
    error,
    getCategoriesByType,
    refreshCategories,
    addCategory,
    updateCategory,
    deleteCategory,
    moveCategoryTo,
  } = useCategories();

  onRender({
    categories,
    isLoading,
    error,
    income: getCategoriesByType('income'),
    expense: getCategoriesByType('expense'),
    transaction: getCategoriesByType('transaction'),
    refreshCategories,
    getCategoriesByType,
    addCategory,
    updateCategory,
    deleteCategory,
    moveCategoryTo,
    scope: mockGetBoundary(),
  });

  return (
    <ul data-testid="category-list">
      {categories.map((category) => (
        <li key={category.id}>{category.name}</li>
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

function makeCategoryDraft(): CategoryDraft {
  return {
    name: 'Scope Add Draft',
    type: 'expense',
    hasDestinationAccount: false,
  };
}

/** Counts only the hook's own load-failure logs, ignoring unrelated noise. */
function categoryErrorLogCount(calls: readonly unknown[][]): number {
  return calls.filter((call) => {
    const message = call[0];
    return (
      typeof message === 'string' && message.includes('[useCategories]')
    );
  }).length;
}

type MutationOutcome =
  | { readonly status: 'fulfilled'; readonly value: unknown }
  | { readonly status: 'rejected'; readonly error: unknown };

interface InFlightMutation {
  readonly operation: Promise<unknown>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

interface InFlightMutationCase {
  readonly name: string;
  readonly callCount: () => number;
  readonly start: (callbacks: ProbeCallbacks) => InFlightMutation;
  readonly resolvedValue: unknown;
  readonly rejectsWhenAdapterRejects: boolean;
}

/**
 * One deferred adapter per saved CRUD callback. The mutation is started while
 * owner A is verified and settled only after the scope is invalidated.
 */
const inFlightMutationCases: readonly InFlightMutationCase[] = [
  {
    name: 'addCategory',
    callCount: () => mockAddCategory.mock.calls.length,
    start: (callbacks) => {
      const mutation = Promise.withResolvers<string>();
      mockAddCategory.mockReturnValueOnce(mutation.promise);
      return {
        operation: callbacks.addCategory(makeCategoryDraft()),
        resolve: () => mutation.resolve('scope-created-id'),
        reject: (error) => mutation.reject(error),
      };
    },
    resolvedValue: 'scope-created-id',
    rejectsWhenAdapterRejects: true,
  },
  {
    name: 'updateCategory',
    callCount: () => mockUpdateCategory.mock.calls.length,
    start: (callbacks) => {
      const mutation = Promise.withResolvers<void>();
      mockUpdateCategory.mockReturnValueOnce(mutation.promise);
      return {
        operation: callbacks.updateCategory({
          id: OWNER_A_CATEGORY_ID,
          name: 'Scope Updated Category',
        }),
        resolve: () => mutation.resolve(),
        reject: (error) => mutation.reject(error),
      };
    },
    resolvedValue: undefined,
    rejectsWhenAdapterRejects: true,
  },
  {
    name: 'deleteCategory',
    callCount: () => mockDeleteCategory.mock.calls.length,
    start: (callbacks) => {
      const mutation = Promise.withResolvers<void>();
      mockDeleteCategory.mockReturnValueOnce(mutation.promise);
      return {
        operation: callbacks.deleteCategory(OWNER_A_CATEGORY_ID),
        resolve: () => mutation.resolve(),
        reject: (error) => mutation.reject(error),
      };
    },
    resolvedValue: undefined,
    rejectsWhenAdapterRejects: true,
  },
  {
    name: 'moveCategoryTo',
    callCount: () => mockMoveCategoryTo.mock.calls.length,
    start: (callbacks) => {
      const mutation = Promise.withResolvers<void>();
      mockMoveCategoryTo.mockReturnValueOnce(mutation.promise);
      return {
        operation: callbacks.moveCategoryTo(OWNER_A_CATEGORY_ID, 1),
        resolve: () => mutation.resolve(),
        reject: (error) => mutation.reject(error),
      };
    },
    resolvedValue: undefined,
    rejectsWhenAdapterRejects: false,
  },
];

/**
 * Saved callbacks outside their scope never reach an adapter and keep the
 * hook's existing settlement contract: add/update/delete reject, reorder
 * resolves because it already swallows failures.
 */
async function expectInertCrudCallbacks(
  callbacks: ProbeCallbacks,
): Promise<void> {
  await expect(
    callbacks.addCategory(makeCategoryDraft()),
  ).rejects.toThrow('Local data is locked to another account');
  await expect(
    callbacks.updateCategory({
      id: OWNER_A_CATEGORY_ID,
      name: 'Scope Stale Update',
    }),
  ).rejects.toThrow('Local data is locked to another account');
  await expect(
    callbacks.deleteCategory(OWNER_A_CATEGORY_ID),
  ).rejects.toThrow('Local data is locked to another account');
  await expect(
    callbacks.moveCategoryTo(OWNER_A_CATEGORY_ID, 1),
  ).resolves.toBeUndefined();
}

describe('useCategories auth-scope isolation', () => {
  beforeEach(() => {
    mockBoundaryListeners.clear();
    mockPublishAuth({ state: 'unauthenticated' });
    mockSetVerification(false);
    mockGetAllCategories.mockReset();
    mockAddCategory.mockReset();
    mockUpdateCategory.mockReset();
    mockDeleteCategory.mockReset();
    mockMoveCategoryTo.mockReset();
  });

  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
  });

  it('does not expose the previous owner category on the first render after verification is revoked', async () => {
    const categoryA = makeOwnerAExpenseCategory();
    mockGetAllCategories.mockResolvedValue([categoryA]);

    mockPublishAuth({ state: 'authenticated', userId: OWNER_A_USER_ID });
    mockSetVerification(true);

    const renders: ProbeRender[] = [];
    render(
      <CategoriesProbe onRender={(probeRender) => renders.push(probeRender)} />,
    );

    await waitFor(() => {
      expect(screen.queryByText(categoryA.name)).not.toBeNull();
      expect(renders[renders.length - 1]?.isLoading).toBe(false);
    });

    // Owner A's verified result is visible before invalidation.
    const ownerARender = renders[renders.length - 1];
    if (!ownerARender) {
      throw new Error('owner A render was not recorded');
    }
    expect(ownerARender.scope.isScopeVerified).toBe(true);
    expect(ownerARender.scope.authState).toBe('authenticated');
    expect(ownerARender.scope.userId).toBe(OWNER_A_USER_ID);
    expect(ownerARender.categories).toEqual([categoryA]);
    expect(ownerARender.income).toEqual([]);
    expect(ownerARender.expense).toEqual([categoryA]);
    expect(ownerARender.transaction).toEqual([]);

    const savedOwnerAFilter = ownerARender.getCategoriesByType;
    const savedOwnerARefresh = ownerARender.refreshCategories;
    const readsAfterOwnerALoad = mockGetAllCategories.mock.calls.length;
    expect(readsAfterOwnerALoad).toBe(1);

    const generationBeforeLock = mockGetBoundary().generation;
    const authStateBeforeLock = mockGetBoundary().authState;
    const userIdBeforeLock = mockGetBoundary().userId;

    // Revoke only verification. Auth identity, user, and generation must stay
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

    // Let the current hook's passive-effect clear settle; the regression is
    // that a render before that effect already exposed owner A's row.
    await waitFor(() => expect(screen.queryByText(categoryA.name)).toBeNull());

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
      expect(lockedRender.categories).toEqual([]);
      expect(lockedRender.isLoading).toBe(false);
      expect(lockedRender.error).toBeNull();
      expect(lockedRender.income).toEqual([]);
      expect(lockedRender.expense).toEqual([]);
      expect(lockedRender.transaction).toEqual([]);
    }

    // A filter callback retained from owner A's scope must not keep returning
    // owner A's rows after verification is revoked.
    expect(savedOwnerAFilter('income')).toEqual([]);
    expect(savedOwnerAFilter('expense')).toEqual([]);
    expect(savedOwnerAFilter('transaction')).toEqual([]);

    // A refresh callback retained from owner A's scope must not issue another
    // IndexedDB read while the scope is locked.
    const readsBeforeSavedRefresh = mockGetAllCategories.mock.calls.length;
    await act(async () => {
      await savedOwnerARefresh().catch(() => {});
    });
    expect(mockGetAllCategories).toHaveBeenCalledTimes(readsBeforeSavedRefresh);
  });

  it('fences a retained filter on the shared auth generation before React rerenders', async () => {
    const categoryA = makeOwnerAExpenseCategory();
    const categoryB = makeOwnerBExpenseCategory();
    mockGetAllCategories.mockResolvedValue([categoryA]);

    mockPublishAuth({ state: 'authenticated', userId: OWNER_A_USER_ID });
    mockSetVerification(true);

    const renders: ProbeRender[] = [];
    render(
      <CategoriesProbe onRender={(probeRender) => renders.push(probeRender)} />,
    );

    await waitFor(() => {
      expect(screen.queryByText(categoryA.name)).not.toBeNull();
      expect(renders[renders.length - 1]?.isLoading).toBe(false);
    });

    const ownerARender = renders[renders.length - 1];
    if (!ownerARender) {
      throw new Error('owner A render was not recorded');
    }
    expect(ownerARender.scope.isScopeVerified).toBe(true);
    expect(ownerARender.scope.userId).toBe(OWNER_A_USER_ID);
    expect(ownerARender.categories).toEqual([categoryA]);
    expect(ownerARender.expense).toEqual([categoryA]);

    const savedOwnerAFilter = ownerARender.getCategoriesByType;
    const ownerAGeneration = getAuthGeneration();
    expect(ownerARender.scope.generation).toBe(ownerAGeneration);

    // Publish a new shared identity directly, without notifying the
    // React-facing external store. React has not rerendered, its mocked
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

    const renderCountBeforeFilterProbe = renders.length;

    // The retained callback must be fenced by the shared generation even
    // though its token ref still points at owner A's live bucket. Relying on
    // the token alone returns owner A's rows during this interval.
    expect(savedOwnerAFilter('income')).toEqual([]);
    expect(savedOwnerAFilter('expense')).toEqual([]);
    expect(savedOwnerAFilter('transaction')).toEqual([]);

    // Probing the retained callback must not rerender the probe.
    expect(renders).toHaveLength(renderCountBeforeFilterProbe);

    // Now let React observe owner B and commit the new scope token.
    mockGetAllCategories.mockResolvedValue([categoryB]);
    act(() => {
      mockPublishAuth({ state: 'authenticated', userId: OWNER_B_USER_ID });
    });

    expect(mockGetBoundary().authState).toBe('authenticated');
    expect(mockGetBoundary().userId).toBe(OWNER_B_USER_ID);
    expect(mockGetBoundary().generation).toBe(ownerBGeneration);
    expect(mockGetBoundary().isScopeVerified).toBe(true);

    await waitFor(() => {
      expect(screen.queryByText(categoryA.name)).toBeNull();
      expect(screen.queryByText(categoryB.name)).not.toBeNull();
    });

    const ownerBRenders = renders.filter(
      (probeRender) => probeRender.scope.userId === OWNER_B_USER_ID,
    );
    expect(ownerBRenders.length).toBeGreaterThan(0);

    // The new scope only ever sees its own rows.
    for (const ownerBRender of ownerBRenders) {
      expect(ownerBRender.categories).not.toContainEqual(categoryA);
      expect(ownerBRender.income).not.toContainEqual(categoryA);
      expect(ownerBRender.expense).not.toContainEqual(categoryA);
      expect(ownerBRender.transaction).not.toContainEqual(categoryA);
    }
  });

  it('clears a failed load on verification-only revoke and reloads only through the new scope', async () => {
    const categoryA = makeOwnerAExpenseCategory();
    const loadErrorMessage = 'owner A load failed';
    const reloadRead = Promise.withResolvers<Category[]>();
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    mockGetAllCategories
      .mockResolvedValue([])
      .mockRejectedValueOnce(new Error(loadErrorMessage))
      .mockReturnValueOnce(reloadRead.promise);

    mockPublishAuth({ state: 'authenticated', userId: OWNER_A_USER_ID });
    mockSetVerification(true);

    const renders: ProbeRender[] = [];
    render(
      <CategoriesProbe onRender={(probeRender) => renders.push(probeRender)} />,
    );

    await waitFor(() => {
      expect(latestRender(renders).error).toBe(loadErrorMessage);
      expect(latestRender(renders).isLoading).toBe(false);
    });

    const failedRender = latestRender(renders);
    expect(failedRender.scope.isScopeVerified).toBe(true);
    expect(failedRender.scope.userId).toBe(OWNER_A_USER_ID);
    expect(failedRender.categories).toEqual([]);
    expect(failedRender.income).toEqual([]);
    expect(failedRender.expense).toEqual([]);
    expect(failedRender.transaction).toEqual([]);
    expect(categoryErrorLogCount(consoleError.mock.calls)).toBe(1);

    const errorCallsAfterFailure = categoryErrorLogCount(
      consoleError.mock.calls,
    );
    const generationBeforeLock = mockGetBoundary().generation;

    act(() => {
      mockSetVerification(false);
    });

    const lockedRenders = renders.filter(
      (probeRender) =>
        !probeRender.scope.isScopeVerified &&
        probeRender.scope.authState === 'authenticated' &&
        probeRender.scope.userId === OWNER_A_USER_ID &&
        probeRender.scope.generation === generationBeforeLock,
    );
    expect(lockedRenders.length).toBeGreaterThan(0);
    for (const lockedRender of lockedRenders) {
      expect(lockedRender.categories).toEqual([]);
      expect(lockedRender.isLoading).toBe(false);
      expect(lockedRender.error).toBeNull();
      expect(lockedRender.income).toEqual([]);
      expect(lockedRender.expense).toEqual([]);
      expect(lockedRender.transaction).toEqual([]);
    }

    // The settled failure must not log again for the locked scope.
    expect(categoryErrorLogCount(consoleError.mock.calls)).toBe(
      errorCallsAfterFailure,
    );

    const rendersBeforeReverify = renders.length;
    act(() => {
      mockSetVerification(true);
    });

    await waitFor(() => expect(mockGetAllCategories).toHaveBeenCalledTimes(2));

    const reVerifiedRenders = renders.slice(rendersBeforeReverify);
    expect(reVerifiedRenders.length).toBeGreaterThan(0);
    for (const reVerifiedRender of reVerifiedRenders) {
      // First eligible invocation of the re-verified scope: empty, no error,
      // loading until the new read (not the old failure) settles it.
      expect(reVerifiedRender.scope.isScopeVerified).toBe(true);
      expect(reVerifiedRender.categories).toEqual([]);
      expect(reVerifiedRender.error).toBeNull();
      expect(reVerifiedRender.isLoading).toBe(true);
    }

    await act(async () => {
      reloadRead.resolve([categoryA]);
      await reloadRead.promise;
      await Promise.resolve();
    });

    await waitFor(() => {
      const latest = latestRender(renders);
      expect(latest.categories).toEqual([categoryA]);
      expect(latest.expense).toEqual([categoryA]);
      expect(latest.transaction).toEqual([]);
      expect(latest.isLoading).toBe(false);
      expect(latest.error).toBeNull();
    });
    expect(screen.queryByText(categoryA.name)).not.toBeNull();
    expect(categoryErrorLogCount(consoleError.mock.calls)).toBe(
      errorCallsAfterFailure,
    );
  });

  it('keeps owner B loading until its own read resolves after a stale owner A load succeeds', async () => {
    const categoryA = makeOwnerAExpenseCategory();
    const categoryB = makeOwnerBExpenseCategory();
    const ownerARead = Promise.withResolvers<Category[]>();
    const ownerBRead = Promise.withResolvers<Category[]>();

    mockGetAllCategories
      .mockResolvedValue([])
      .mockReturnValueOnce(ownerARead.promise)
      .mockReturnValueOnce(ownerBRead.promise);

    mockPublishAuth({ state: 'authenticated', userId: OWNER_A_USER_ID });
    mockSetVerification(true);

    const renders: ProbeRender[] = [];
    render(
      <CategoriesProbe onRender={(probeRender) => renders.push(probeRender)} />,
    );

    await waitFor(() => expect(mockGetAllCategories).toHaveBeenCalledTimes(1));
    expect(latestRender(renders).isLoading).toBe(true);

    const ownerAGeneration = mockGetBoundary().generation;

    await act(async () => {
      mockPublishAuth({ state: 'authenticated', userId: OWNER_B_USER_ID });
      await Promise.resolve();
    });

    expect(mockGetBoundary().userId).toBe(OWNER_B_USER_ID);
    expect(mockGetBoundary().generation).toBeGreaterThan(ownerAGeneration);
    await waitFor(() => expect(mockGetAllCategories).toHaveBeenCalledTimes(2));

    // The stale owner A read succeeds only after owner B is the live scope.
    await act(async () => {
      ownerARead.resolve([categoryA]);
      await ownerARead.promise;
      await Promise.resolve();
    });

    const ownerBRenders = renders.filter(
      (probeRender) => probeRender.scope.userId === OWNER_B_USER_ID,
    );
    expect(ownerBRenders.length).toBeGreaterThan(0);
    for (const ownerBRender of ownerBRenders) {
      expect(ownerBRender.categories).not.toContainEqual(categoryA);
      expect(ownerBRender.categories).toEqual([]);
      expect(ownerBRender.income).toEqual([]);
      expect(ownerBRender.expense).toEqual([]);
      expect(ownerBRender.transaction).toEqual([]);
      expect(ownerBRender.error).toBeNull();
      // Owner B's own read is still pending, so loading stays true.
      expect(ownerBRender.isLoading).toBe(true);
    }

    await act(async () => {
      ownerBRead.resolve([categoryB]);
      await ownerBRead.promise;
      await Promise.resolve();
    });

    await waitFor(() => {
      const latest = latestRender(renders);
      expect(latest.scope.userId).toBe(OWNER_B_USER_ID);
      expect(latest.categories).toEqual([categoryB]);
      expect(latest.expense).toEqual([categoryB]);
      expect(latest.isLoading).toBe(false);
      expect(latest.error).toBeNull();
    });
  });

  it('keeps owner B loading through a stale owner A load rejection without publishing its error', async () => {
    const categoryB = makeOwnerBExpenseCategory();
    const ownerARead = Promise.withResolvers<Category[]>();
    const ownerBRead = Promise.withResolvers<Category[]>();
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    mockGetAllCategories
      .mockResolvedValue([])
      .mockReturnValueOnce(ownerARead.promise)
      .mockReturnValueOnce(ownerBRead.promise);

    mockPublishAuth({ state: 'authenticated', userId: OWNER_A_USER_ID });
    mockSetVerification(true);

    const renders: ProbeRender[] = [];
    render(
      <CategoriesProbe onRender={(probeRender) => renders.push(probeRender)} />,
    );

    await waitFor(() => expect(mockGetAllCategories).toHaveBeenCalledTimes(1));

    await act(async () => {
      mockPublishAuth({ state: 'authenticated', userId: OWNER_B_USER_ID });
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetAllCategories).toHaveBeenCalledTimes(2));

    // The stale owner A read rejects only after owner B is the live scope.
    await act(async () => {
      ownerARead.reject(new Error('stale owner A load failed'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(categoryErrorLogCount(consoleError.mock.calls)).toBe(0);
    const ownerBRenders = renders.filter(
      (probeRender) => probeRender.scope.userId === OWNER_B_USER_ID,
    );
    expect(ownerBRenders.length).toBeGreaterThan(0);
    for (const ownerBRender of ownerBRenders) {
      expect(ownerBRender.categories).toEqual([]);
      expect(ownerBRender.error).toBeNull();
      expect(ownerBRender.isLoading).toBe(true);
    }

    await act(async () => {
      ownerBRead.resolve([categoryB]);
      await ownerBRead.promise;
      await Promise.resolve();
    });

    await waitFor(() => {
      const latest = latestRender(renders);
      expect(latest.scope.userId).toBe(OWNER_B_USER_ID);
      expect(latest.categories).toEqual([categoryB]);
      expect(latest.isLoading).toBe(false);
      expect(latest.error).toBeNull();
    });
    expect(categoryErrorLogCount(consoleError.mock.calls)).toBe(0);
  });

  it('advances the owner A generation on relogin and fences the first load through the new read', async () => {
    const categoryA = makeOwnerAExpenseCategory();
    const firstOwnerARead = Promise.withResolvers<Category[]>();
    const reloggedOwnerARead = Promise.withResolvers<Category[]>();

    mockGetAllCategories
      .mockResolvedValue([])
      .mockReturnValueOnce(firstOwnerARead.promise)
      .mockReturnValueOnce(reloggedOwnerARead.promise);

    mockPublishAuth({ state: 'authenticated', userId: OWNER_A_USER_ID });
    mockSetVerification(true);

    const renders: ProbeRender[] = [];
    render(
      <CategoriesProbe onRender={(probeRender) => renders.push(probeRender)} />,
    );

    await waitFor(() => expect(mockGetAllCategories).toHaveBeenCalledTimes(1));

    const originalGeneration = mockGetBoundary().generation;
    expect(mockGetBoundary().isScopeVerified).toBe(true);

    act(() => {
      mockPublishAuth({ state: 'unauthenticated' });
    });

    const signedOutRenders = renders.filter(
      (probeRender) => probeRender.scope.authState === 'unauthenticated',
    );
    expect(signedOutRenders.length).toBeGreaterThan(0);
    for (const signedOutRender of signedOutRenders) {
      expect(signedOutRender.categories).toEqual([]);
      expect(signedOutRender.isLoading).toBe(false);
      expect(signedOutRender.error).toBeNull();
    }
    expect(mockGetAllCategories).toHaveBeenCalledTimes(1);

    const rendersBeforeRelogin = renders.length;
    act(() => {
      mockPublishAuth({ state: 'authenticated', userId: OWNER_A_USER_ID });
    });

    const reloginGeneration = mockGetBoundary().generation;
    expect(reloginGeneration).toBeGreaterThan(originalGeneration);
    expect(mockGetBoundary().isScopeVerified).toBe(true);
    await waitFor(() => expect(mockGetAllCategories).toHaveBeenCalledTimes(2));

    const reloggedRenders = renders.slice(rendersBeforeRelogin);
    expect(reloggedRenders.length).toBeGreaterThan(0);
    for (const reloggedRender of reloggedRenders) {
      expect(reloggedRender.scope.userId).toBe(OWNER_A_USER_ID);
      expect(reloggedRender.scope.generation).toBe(reloginGeneration);
      expect(reloggedRender.categories).toEqual([]);
      expect(reloggedRender.error).toBeNull();
      expect(reloggedRender.isLoading).toBe(true);
    }

    // The pre-relogin read settles after the new generation exists.
    await act(async () => {
      firstOwnerARead.resolve([categoryA]);
      await firstOwnerARead.promise;
      await Promise.resolve();
    });

    expect(latestRender(renders).categories).toEqual([]);
    expect(latestRender(renders).isLoading).toBe(true);

    await act(async () => {
      reloggedOwnerARead.resolve([categoryA]);
      await reloggedOwnerARead.promise;
      await Promise.resolve();
    });

    await waitFor(() => {
      const latest = latestRender(renders);
      expect(latest.categories).toEqual([categoryA]);
      expect(latest.expense).toEqual([categoryA]);
      expect(latest.isLoading).toBe(false);
      expect(latest.error).toBeNull();
    });
  });

  it('does not publish a stale owner A refresh success or settle owner B loading', async () => {
    const categoryA = makeOwnerAExpenseCategory();
    const categoryB = makeOwnerBExpenseCategory();
    const refreshRead = Promise.withResolvers<Category[]>();
    const ownerBRead = Promise.withResolvers<Category[]>();

    mockGetAllCategories
      .mockResolvedValue([])
      .mockResolvedValueOnce([categoryA])
      .mockReturnValueOnce(refreshRead.promise)
      .mockReturnValueOnce(ownerBRead.promise);

    mockPublishAuth({ state: 'authenticated', userId: OWNER_A_USER_ID });
    mockSetVerification(true);

    const renders: ProbeRender[] = [];
    render(
      <CategoriesProbe onRender={(probeRender) => renders.push(probeRender)} />,
    );

    await waitFor(() =>
      expect(screen.queryByText(categoryA.name)).not.toBeNull(),
    );

    const ownerARender = latestRender(renders);
    expect(ownerARender.scope.isScopeVerified).toBe(true);
    expect(ownerARender.scope.authState).toBe('authenticated');
    expect(ownerARender.categories).toEqual([categoryA]);

    let refreshPromise: Promise<void> = Promise.resolve();
    act(() => {
      refreshPromise = ownerARender.refreshCategories();
    });
    expect(mockGetAllCategories).toHaveBeenCalledTimes(2);

    await act(async () => {
      mockPublishAuth({ state: 'authenticated', userId: OWNER_B_USER_ID });
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetAllCategories).toHaveBeenCalledTimes(3));

    // The refresh succeeds only after owner B became the live scope.
    await act(async () => {
      refreshRead.resolve([categoryA]);
      await refreshPromise;
      await Promise.resolve();
    });

    const ownerBRenders = renders.filter(
      (probeRender) => probeRender.scope.userId === OWNER_B_USER_ID,
    );
    expect(ownerBRenders.length).toBeGreaterThan(0);
    for (const ownerBRender of ownerBRenders) {
      expect(ownerBRender.categories).not.toContainEqual(categoryA);
      expect(ownerBRender.categories).toEqual([]);
      expect(ownerBRender.error).toBeNull();
      // A stale refresh may not settle owner B's own loading.
      expect(ownerBRender.isLoading).toBe(true);
    }

    await act(async () => {
      ownerBRead.resolve([categoryB]);
      await ownerBRead.promise;
      await Promise.resolve();
    });

    await waitFor(() => {
      const latest = latestRender(renders);
      expect(latest.scope.userId).toBe(OWNER_B_USER_ID);
      expect(latest.categories).toEqual([categoryB]);
      expect(latest.isLoading).toBe(false);
      expect(latest.error).toBeNull();
    });
  });

  it('does not publish a stale owner A refresh rejection or log it in the locked scope', async () => {
    const categoryA = makeOwnerAExpenseCategory();
    const refreshRead = Promise.withResolvers<Category[]>();
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    mockGetAllCategories
      .mockResolvedValue([])
      .mockResolvedValueOnce([categoryA])
      .mockReturnValueOnce(refreshRead.promise);

    mockPublishAuth({ state: 'authenticated', userId: OWNER_A_USER_ID });
    mockSetVerification(true);

    const renders: ProbeRender[] = [];
    render(
      <CategoriesProbe onRender={(probeRender) => renders.push(probeRender)} />,
    );

    await waitFor(() =>
      expect(screen.queryByText(categoryA.name)).not.toBeNull(),
    );

    const ownerARender = latestRender(renders);
    let refreshPromise: Promise<void> = Promise.resolve();
    act(() => {
      refreshPromise = ownerARender.refreshCategories();
    });
    expect(mockGetAllCategories).toHaveBeenCalledTimes(2);

    act(() => {
      mockSetVerification(false);
    });

    const lockedRenders = renders.filter(
      (probeRender) => !probeRender.scope.isScopeVerified,
    );
    expect(lockedRenders.length).toBeGreaterThan(0);
    for (const lockedRender of lockedRenders) {
      expect(lockedRender.categories).toEqual([]);
      expect(lockedRender.error).toBeNull();
      expect(lockedRender.isLoading).toBe(false);
    }

    const rendersBeforeRefreshSettlement = renders.length;
    await act(async () => {
      refreshRead.reject(new Error('stale owner A refresh failed'));
      await refreshPromise;
      await Promise.resolve();
    });

    expect(mockGetAllCategories).toHaveBeenCalledTimes(2);
    expect(categoryErrorLogCount(consoleError.mock.calls)).toBe(0);
    const rendersAfterRefreshSettlement = renders.slice(
      rendersBeforeRefreshSettlement,
    );
    for (const probeRender of rendersAfterRefreshSettlement) {
      expect(probeRender.categories).toEqual([]);
      expect(probeRender.error).toBeNull();
      expect(probeRender.isLoading).toBe(false);
    }
  });

  it('keeps a retained owner A refresh inert across revoke and reverify', async () => {
    const categoryA = makeOwnerAExpenseCategory();
    const newLoadErrorMessage = 'reverified owner A load failed';
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    mockGetAllCategories
      .mockResolvedValue([])
      .mockResolvedValueOnce([categoryA])
      .mockRejectedValueOnce(new Error(newLoadErrorMessage));

    mockPublishAuth({ state: 'authenticated', userId: OWNER_A_USER_ID });
    mockSetVerification(true);

    const renders: ProbeRender[] = [];
    render(
      <CategoriesProbe onRender={(probeRender) => renders.push(probeRender)} />,
    );

    await waitFor(() =>
      expect(screen.queryByText(categoryA.name)).not.toBeNull(),
    );

    const savedOwnerARefresh = latestRender(renders).refreshCategories;

    // Leave and re-enter the same owner; the verification-only transitions
    // do not advance the generation but do install a new scope token.
    act(() => {
      mockSetVerification(false);
    });
    act(() => {
      mockSetVerification(true);
    });

    await waitFor(() => {
      const latest = latestRender(renders);
      expect(latest.isLoading).toBe(false);
      expect(latest.error).toBe(newLoadErrorMessage);
    });

    const generationBefore = mockGetBoundary().generation;
    const readsBefore = mockGetAllCategories.mock.calls.length;
    const rendersBefore = renders.length;
    const errorCallsBefore = categoryErrorLogCount(consoleError.mock.calls);

    await act(async () => {
      await savedOwnerARefresh();
      await Promise.resolve();
    });

    // The retained callback neither reads nor clears the new scope's error.
    expect(mockGetBoundary().generation).toBe(generationBefore);
    expect(mockGetAllCategories).toHaveBeenCalledTimes(readsBefore);
    expect(renders).toHaveLength(rendersBefore);
    expect(categoryErrorLogCount(consoleError.mock.calls)).toBe(
      errorCallsBefore,
    );

    const latest = latestRender(renders);
    expect(latest.categories).toEqual([]);
    expect(latest.error).toBe(newLoadErrorMessage);
    expect(latest.isLoading).toBe(false);
  });

  it('keeps saved owner A CRUD callbacks inert after revoke and after reverify', async () => {
    const categoryA = makeOwnerAExpenseCategory();

    mockGetAllCategories
      .mockResolvedValue([])
      .mockResolvedValueOnce([categoryA])
      .mockResolvedValueOnce([categoryA]);

    mockPublishAuth({ state: 'authenticated', userId: OWNER_A_USER_ID });
    mockSetVerification(true);

    const renders: ProbeRender[] = [];
    render(
      <CategoriesProbe onRender={(probeRender) => renders.push(probeRender)} />,
    );

    await waitFor(() =>
      expect(screen.queryByText(categoryA.name)).not.toBeNull(),
    );

    const savedOwnerACallbacks = latestRender(renders);

    act(() => {
      mockSetVerification(false);
    });

    const readsAfterRevoke = mockGetAllCategories.mock.calls.length;
    const rendersAfterRevoke = renders.length;

    await act(async () => {
      await expectInertCrudCallbacks(savedOwnerACallbacks);
    });

    expect(mockAddCategory).not.toHaveBeenCalled();
    expect(mockUpdateCategory).not.toHaveBeenCalled();
    expect(mockDeleteCategory).not.toHaveBeenCalled();
    expect(mockMoveCategoryTo).not.toHaveBeenCalled();
    expect(mockGetAllCategories).toHaveBeenCalledTimes(readsAfterRevoke);

    for (const lockedRender of renders.slice(rendersAfterRevoke)) {
      expect(lockedRender.categories).toEqual([]);
      expect(lockedRender.error).toBeNull();
      expect(lockedRender.isLoading).toBe(false);
    }

    // Re-verify owner A and let the new scope load its own rows.
    act(() => {
      mockSetVerification(true);
    });
    await waitFor(() => {
      const latest = latestRender(renders);
      expect(latest.categories).toEqual([categoryA]);
      expect(latest.isLoading).toBe(false);
    });

    const readsBeforeSecondInvocation = mockGetAllCategories.mock.calls.length;
    const rendersBeforeSecondInvocation = renders.length;

    await act(async () => {
      await expectInertCrudCallbacks(savedOwnerACallbacks);
    });

    expect(mockAddCategory).not.toHaveBeenCalled();
    expect(mockUpdateCategory).not.toHaveBeenCalled();
    expect(mockDeleteCategory).not.toHaveBeenCalled();
    expect(mockMoveCategoryTo).not.toHaveBeenCalled();
    expect(mockGetAllCategories).toHaveBeenCalledTimes(
      readsBeforeSecondInvocation,
    );

    const rendersAfterSecondInvocation = renders.slice(
      rendersBeforeSecondInvocation,
    );
    expect(
      rendersAfterSecondInvocation.some(
        (probeRender) => probeRender.error !== null,
      ),
    ).toBe(false);

    const latest = latestRender(renders);
    expect(latest.scope.isScopeVerified).toBe(true);
    expect(latest.scope.userId).toBe(OWNER_A_USER_ID);
    expect(latest.categories).toEqual([categoryA]);
    expect(latest.expense).toEqual([categoryA]);
    expect(latest.isLoading).toBe(false);
    expect(latest.error).toBeNull();
  });

  for (const mutationCase of inFlightMutationCases) {
    for (const settlement of ['resolve', 'reject'] as const) {
      it(`fences an in-flight owner A ${mutationCase.name} mutation that ${settlement}s after verification is revoked`, async () => {
        const categoryA = makeOwnerAExpenseCategory();

        mockGetAllCategories
          .mockResolvedValue([])
          .mockResolvedValueOnce([categoryA]);

        mockPublishAuth({ state: 'authenticated', userId: OWNER_A_USER_ID });
        mockSetVerification(true);

        const renders: ProbeRender[] = [];
        render(
          <CategoriesProbe
            onRender={(probeRender) => renders.push(probeRender)}
          />,
        );

        await waitFor(() =>
          expect(screen.queryByText(categoryA.name)).not.toBeNull(),
        );

        const ownerARender = latestRender(renders);
        expect(ownerARender.scope.isScopeVerified).toBe(true);
        expect(ownerARender.scope.userId).toBe(OWNER_A_USER_ID);

        const inFlight = mutationCase.start(ownerARender);
        // The mutation already reached the adapter; this test claims no
        // rollback, only that its settlement is fenced.
        expect(mutationCase.callCount()).toBe(1);

        const readsBeforeRevoke = mockGetAllCategories.mock.calls.length;
        act(() => {
          mockSetVerification(false);
        });

        const lockedRenders = renders.filter(
          (probeRender) => !probeRender.scope.isScopeVerified,
        );
        expect(lockedRenders.length).toBeGreaterThan(0);
        for (const lockedRender of lockedRenders) {
          expect(lockedRender.categories).toEqual([]);
          expect(lockedRender.error).toBeNull();
          expect(lockedRender.isLoading).toBe(false);
        }
        expect(mockGetAllCategories).toHaveBeenCalledTimes(readsBeforeRevoke);

        const consoleError = jest
          .spyOn(console, 'error')
          .mockImplementation(() => {});
        const rendersBeforeSettlement = renders.length;

        await act(async () => {
          if (settlement === 'resolve') {
            inFlight.resolve();
          } else {
            inFlight.reject(new Error('mutation failed'));
          }
          // Swallow the adapter rejection while React effects settle; the
          // discriminated outcome is bound from the settled promise below.
          await inFlight.operation.catch(() => undefined);
        });

        const [settled] = await Promise.allSettled([inFlight.operation]);
        const outcome: MutationOutcome =
          settled.status === 'fulfilled'
            ? { status: 'fulfilled', value: settled.value }
            : { status: 'rejected', error: settled.reason };

        expect(mutationCase.callCount()).toBe(1);
        expect(mockGetAllCategories).toHaveBeenCalledTimes(readsBeforeRevoke);
        expect(categoryErrorLogCount(consoleError.mock.calls)).toBe(0);

        if (
          settlement === 'resolve' ||
          !mutationCase.rejectsWhenAdapterRejects
        ) {
          expect(outcome).toEqual({
            status: 'fulfilled',
            value: mutationCase.resolvedValue,
          });
        } else {
          expect(outcome.status).toBe('rejected');
          if (outcome.status === 'rejected') {
            expect(outcome.error).toBeInstanceOf(Error);
            if (outcome.error instanceof Error) {
              expect(outcome.error.message).toBe('mutation failed');
            }
          }
        }

        for (const probeRender of renders.slice(rendersBeforeSettlement)) {
          expect(probeRender.categories).toEqual([]);
          expect(probeRender.error).toBeNull();
          expect(probeRender.isLoading).toBe(false);
        }

        const latestAfterSettlement = latestRender(renders);
        expect(latestAfterSettlement.categories).toEqual([]);
        expect(latestAfterSettlement.error).toBeNull();
        expect(latestAfterSettlement.isLoading).toBe(false);
      });
    }
  }

  it('loads, filters, refreshes, and mutates categories in a verified local-only scope', async () => {
    const expenseCategory = makeCategory(
      'dddddddd-dddd-4ddd-8ddd-dddddddddd01',
      'Disabled Expense',
      'expense',
      0,
    );
    const transferOne = makeCategory(
      'dddddddd-dddd-4ddd-8ddd-dddddddddd02',
      'Disabled Transfer One',
      'transaction',
      1,
    );
    const incomeCategory = makeCategory(
      'dddddddd-dddd-4ddd-8ddd-dddddddddd03',
      'Disabled Income',
      'income',
      2,
    );
    const transferTwo = makeCategory(
      'dddddddd-dddd-4ddd-8ddd-dddddddddd04',
      'Disabled Transfer Two',
      'transaction',
      3,
    );
    const initialOrder = [
      expenseCategory,
      transferOne,
      incomeCategory,
      transferTwo,
    ];

    mockGetAllCategories
      .mockResolvedValue([])
      .mockResolvedValueOnce(initialOrder);

    // Disabled mode: no user and no authenticated identity, but the provider
    // verified local ownership.
    mockPublishAuth({ state: 'disabled' });
    mockSetVerification(true);

    const renders: ProbeRender[] = [];
    const { rerender } = render(
      <CategoriesProbe onRender={(probeRender) => renders.push(probeRender)} />,
    );

    await waitFor(() =>
      expect(screen.queryByText(transferOne.name)).not.toBeNull(),
    );

    for (const probeRender of renders) {
      expect(probeRender.scope.authState).toBe('disabled');
      expect(probeRender.scope.userId).toBeNull();
      expect(probeRender.scope.isScopeVerified).toBe(true);
    }

    const loaded = latestRender(renders);
    expect(loaded.categories).toEqual(initialOrder);
    expect(loaded.expense).toEqual([expenseCategory]);
    expect(loaded.income).toEqual([incomeCategory]);
    expect(loaded.transaction).toEqual([transferOne, transferTwo]);
    expect(loaded.isLoading).toBe(false);
    expect(loaded.error).toBeNull();
    expect(mockGetAllCategories).toHaveBeenCalledTimes(1);

    const callbacks = loaded;

    // A same-scope rerender must not restart the initial load.
    await act(async () => {
      rerender(
        <CategoriesProbe
          onRender={(probeRender) => renders.push(probeRender)}
        />,
      );
      await Promise.resolve();
    });
    expect(mockGetAllCategories).toHaveBeenCalledTimes(1);
    expect(latestRender(renders).categories).toEqual(initialOrder);

    // Current-scope refresh.
    const refreshedOrder = [
      transferOne,
      expenseCategory,
      incomeCategory,
      transferTwo,
    ];
    mockGetAllCategories.mockResolvedValueOnce(refreshedOrder);
    await act(async () => {
      await callbacks.refreshCategories();
    });
    expect(mockGetAllCategories).toHaveBeenCalledTimes(2);
    expect(latestRender(renders).categories).toEqual(refreshedOrder);
    expect(latestRender(renders).transaction).toEqual([
      transferOne,
      transferTwo,
    ]);

    // Each CRUD operation reaches its adapter and refreshes its own scope.
    const addedCategory = makeCategory(
      'dddddddd-dddd-4ddd-8ddd-dddddddddd05',
      'Disabled Added',
      'transaction',
      4,
    );
    const afterAdd = [...refreshedOrder, addedCategory];
    const addDraft: CategoryDraft = {
      name: addedCategory.name,
      type: addedCategory.type,
      sortOrder: addedCategory.sortOrder,
      hasDestinationAccount: false,
    };
    mockAddCategory.mockResolvedValueOnce(addedCategory.id);
    mockGetAllCategories.mockResolvedValueOnce(afterAdd);

    let addedId = '';
    await act(async () => {
      addedId = await callbacks.addCategory(addDraft);
    });
    expect(addedId).toBe(addedCategory.id);
    expect(mockAddCategory).toHaveBeenCalledWith(addDraft);
    expect(mockGetAllCategories).toHaveBeenCalledTimes(3);
    expect(latestRender(renders).categories).toEqual(afterAdd);
    expect(latestRender(renders).transaction).toEqual([
      transferOne,
      transferTwo,
      addedCategory,
    ]);

    const updatedTransferOne = {
      ...transferOne,
      name: 'Disabled Transfer One Updated',
      updatedAt: 11,
    };
    const afterUpdate = afterAdd.map((category) =>
      category.id === updatedTransferOne.id ? updatedTransferOne : category,
    );
    mockUpdateCategory.mockResolvedValueOnce(undefined);
    mockGetAllCategories.mockResolvedValueOnce(afterUpdate);

    await act(async () => {
      await callbacks.updateCategory({
        id: updatedTransferOne.id,
        name: updatedTransferOne.name,
      });
    });
    expect(mockUpdateCategory).toHaveBeenCalledWith({
      id: updatedTransferOne.id,
      name: updatedTransferOne.name,
    });
    expect(mockGetAllCategories).toHaveBeenCalledTimes(4);
    expect(latestRender(renders).categories).toEqual(afterUpdate);

    const afterDelete = afterUpdate.filter(
      (category) => category.id !== transferTwo.id,
    );
    mockDeleteCategory.mockResolvedValueOnce(undefined);
    mockGetAllCategories.mockResolvedValueOnce(afterDelete);

    await act(async () => {
      await callbacks.deleteCategory(transferTwo.id);
    });
    expect(mockDeleteCategory).toHaveBeenCalledWith(transferTwo.id);
    expect(mockGetAllCategories).toHaveBeenCalledTimes(5);
    expect(latestRender(renders).categories).toEqual(afterDelete);

    const reordered = [
      updatedTransferOne,
      addedCategory,
      expenseCategory,
      incomeCategory,
    ];
    mockMoveCategoryTo.mockResolvedValueOnce(undefined);
    mockGetAllCategories.mockResolvedValueOnce(reordered);

    await act(async () => {
      await callbacks.moveCategoryTo(updatedTransferOne.id, 0);
    });
    expect(mockMoveCategoryTo).toHaveBeenCalledWith(
      updatedTransferOne.id,
      0,
    );
    expect(mockGetAllCategories).toHaveBeenCalledTimes(6);
    expect(latestRender(renders).categories).toEqual(reordered);
    expect(latestRender(renders).transaction).toEqual([
      updatedTransferOne,
      addedCategory,
    ]);
    expect(latestRender(renders).isLoading).toBe(false);
    expect(latestRender(renders).error).toBeNull();
  });
});
