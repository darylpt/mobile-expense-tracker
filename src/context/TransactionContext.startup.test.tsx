// ============================================================
// TransactionContext.startup.test.tsx — real IndexedDB startup integration
//
// Exercises TransactionProvider against the real @/lib/idb module backed by
// fake-indexeddb. Only the auth identity and background sync are mocked; no
// Supabase client, browser database, or network is touched.
// ============================================================

import 'fake-indexeddb/auto';

// fake-indexeddb v6 needs structuredClone — polyfill for jsdom
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (val: unknown) => JSON.parse(JSON.stringify(val));
}

import React from 'react';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import type { Account, Category, Transaction } from '@/types';
import {
  TransactionProvider,
  useTransactionContext,
} from './TransactionContext';
import { AutoBackup } from '@/components/layout/AutoBackup';
import { backgroundSync } from '@/lib/sync';
import { publishAuthIdentity } from '@/lib/auth-scope';
import {
  getDB,
  saveAutoBackup,
  type ExpenseTrackerDB,
  type SyncDeletionSnapshot,
  type SyncMetaEntry,
  type SyncQueueEntry,
} from '@/lib/idb';
import type { IDBPDatabase } from 'idb';
import {
  DATA_STORES,
  DB_NAME,
  DB_VERSION,
  LAST_USER_STORAGE_KEY,
  STORES,
} from '@/lib/constants';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const CATEGORY_ID = '33333333-3333-4333-8333-333333333333';
const FIRST_TX_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_TX_ID = '55555555-5555-4555-8555-555555555555';

const UNOWNED_ERROR =
  'Local data has no verified account owner. It was not loaded or uploaded; nothing has been deleted. Sign back in with the account that owns this data.';

const ALL_LOCAL_STORES = [
  ...DATA_STORES,
  STORES.SYNC_QUEUE,
  STORES.SYNC_META,
  STORES.SYNC_DELETIONS,
] as const;

type TestDB = IDBPDatabase<ExpenseTrackerDB>;

function makeSafetyQueueEntry(): SyncQueueEntry {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    storeName: STORES.TRANSACTIONS,
    recordId: FIRST_TX_ID,
    operation: 'create',
    payload: seededTransaction(FIRST_TX_ID, '2026-11-01', 12.5, 1),
    timestamp: 123,
    retryCount: 0,
    ownerId: null,
    state: 'quarantined',
    baseline: null,
    baselineRevision: null,
    lastError: 'No verified account owns this queue entry',
    lastAttemptAt: null,
    quarantinedAt: 123,
  };
}

function makeSafetyMetaEntry(): SyncMetaEntry {
  return {
    id: `${STORES.TRANSACTIONS}:${FIRST_TX_ID}`,
    storeName: STORES.TRANSACTIONS,
    recordId: FIRST_TX_ID,
    ownerId: null,
    baseline: null,
    baselineRevision: null,
    localUpdatedAt: 1,
    state: 'quarantined',
    conflict: null,
    lastError: 'No verified account owns this baseline',
    lastAttemptAt: null,
    updatedAt: 1,
  };
}

function makeSafetyDeletion(): SyncDeletionSnapshot {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    storeName: STORES.TRANSACTIONS,
    recordId: FIRST_TX_ID,
    payload: seededTransaction(FIRST_TX_ID, '2026-11-01', 12.5, 1),
    deletedAt: 1,
    ownerId: null,
    state: 'quarantined',
    reason: 'local-delete',
    baselineRevision: null,
    lastError: 'No verified account owns this deletion',
    updatedAt: 1,
  };
}

const SAFETY_ONLY_STARTUP_CASES: Array<{
  label: string;
  expected: unknown;
  seed: (db: TestDB) => Promise<unknown>;
  read: (db: TestDB) => Promise<unknown[]>;
}> = [
  {
    label: 'syncQueue',
    expected: makeSafetyQueueEntry(),
    seed: (db) => db.put(STORES.SYNC_QUEUE, makeSafetyQueueEntry()),
    read: (db) => db.getAll(STORES.SYNC_QUEUE),
  },
  {
    label: 'syncMeta',
    expected: makeSafetyMetaEntry(),
    seed: (db) => db.put(STORES.SYNC_META, makeSafetyMetaEntry()),
    read: (db) => db.getAll(STORES.SYNC_META),
  },
  {
    label: 'syncDeletions',
    expected: makeSafetyDeletion(),
    seed: (db) => db.put(STORES.SYNC_DELETIONS, makeSafetyDeletion()),
    read: (db) => db.getAll(STORES.SYNC_DELETIONS),
  },
];

async function clearAllLocalStores(): Promise<void> {
  const db = await getDB();
  for (const storeName of ALL_LOCAL_STORES) {
    await db.clear(storeName);
  }
}

let mockAuthState: {
  state: 'authenticated' | 'unauthenticated' | 'loading' | 'disabled';
  user: { id: string; email: string } | null;
  authGeneration: number;
} = {
  state: 'loading',
  user: null,
  authGeneration: 0,
};

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => mockAuthState,
}));

jest.mock('@/lib/sync', () => ({
  backgroundSync: jest.fn(),
}));

const mockBackgroundSync = backgroundSync as jest.MockedFunction<typeof backgroundSync>;

let settleBackgroundSync: ((value: boolean) => void) | null = null;
let backgroundSyncSettled = false;

function seededAccount(): Account {
  return {
    id: ACCOUNT_ID,
    name: 'Test Checking',
    startingBalance: 250,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function seededCategory(): Category {
  return {
    id: CATEGORY_ID,
    name: 'Test Groceries',
    type: 'expense',
    sortOrder: 0,
    hasDestinationAccount: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function seededTransaction(
  id: string,
  date: string,
  amount: number,
  createdAt: number,
): Transaction {
  return {
    id,
    amount,
    date,
    type: 'expense',
    category: 'Test Groceries',
    fromAccount: ACCOUNT_ID,
    toAccount: null,
    description: 'Synthetic startup row',
    createdAt,
    updatedAt: createdAt,
  };
}

function Probe() {
  const { transactions, accounts, categories, isLoading, isScopeVerified, error } =
    useTransactionContext();
  return (
    <div>
      <div data-testid="loading">{String(isLoading)}</div>
      <div data-testid="scope">{String(isScopeVerified)}</div>
      <div data-testid="tx-ids">{transactions.map((tx) => tx.id).join(',')}</div>
      <div data-testid="account-ids">{accounts.map((account) => account.id).join(',')}</div>
      <div data-testid="category-ids">{categories.map((category) => category.id).join(',')}</div>
      <div data-testid="error">{error ?? ''}</div>
    </div>
  );
}

function authenticateCurrentUser(): number {
  const authGeneration = publishAuthIdentity({
    state: 'authenticated',
    userId: USER_ID,
  });
  mockAuthState = {
    state: 'authenticated',
    user: { id: USER_ID, email: 'startup@example.com' },
    authGeneration,
  };
  return authGeneration;
}

beforeEach(async () => {
  localStorage.clear();
  jest.clearAllMocks();
  backgroundSyncSettled = false;
  settleBackgroundSync = null;

  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value: true,
  });

  // Each case starts from a truly empty synthetic database.
  await clearAllLocalStores();

  // Hold startup reconciliation until the test has proven local rows are
  // published. Resolving with false forces the provider's post-sync refresh.
  const heldSync = Promise.withResolvers<boolean>();
  mockBackgroundSync.mockImplementation(() => heldSync.promise);
  settleBackgroundSync = (value: boolean) => {
    backgroundSyncSettled = true;
    heldSync.resolve(value);
  };
});

afterEach(async () => {
  cleanup();
  if (settleBackgroundSync && !backgroundSyncSettled) {
    settleBackgroundSync(false);
  }
  await Promise.resolve();
});

afterAll(async () => {
  // Close the singleton connection before deleting the synthetic database.
  const db = await getDB();
  db.close();
  const { promise, resolve } = Promise.withResolvers<void>();
  const request = indexedDB.deleteDatabase(DB_NAME);
  request.onsuccess = () => resolve();
  request.onerror = () => resolve();
  request.onblocked = () => resolve();
  await promise;
});

test('publishes real IndexedDB rows before held sync settles, then refreshes after sync resolves', async () => {
  const db = await getDB();
  expect(db.version).toBe(DB_VERSION);

  // Seed a fresh current-version DB with synthetic, UUID-shaped records.
  await db.put(STORES.ACCOUNTS, seededAccount());
  await db.put(STORES.CATEGORIES, seededCategory());
  await db.put(
    STORES.TRANSACTIONS,
    seededTransaction(FIRST_TX_ID, '2026-11-01', 12.5, 1),
  );

  // The local owner marker must match the rendered authenticated identity so
  // the provider's ownership check and captureAuthScope both succeed.
  localStorage.setItem(LAST_USER_STORAGE_KEY, USER_ID);
  const authGeneration = publishAuthIdentity({
    state: 'authenticated',
    userId: USER_ID,
  });
  mockAuthState = {
    state: 'authenticated',
    user: { id: USER_ID, email: 'startup@example.com' },
    authGeneration,
  };

  render(
    <TransactionProvider>
      <Probe />
    </TransactionProvider>,
  );

  // Local records must be visible, and loading settled, while the startup
  // background sync promise is still unresolved.
  await waitFor(() =>
    expect(screen.getByTestId('loading').textContent).toBe('false'),
  );
  await waitFor(() => expect(mockBackgroundSync).toHaveBeenCalledTimes(1));

  expect(backgroundSyncSettled).toBe(false);
  expect(screen.getByTestId('scope').textContent).toBe('true');
  expect(screen.getByTestId('error').textContent).toBe('');
  expect(screen.getByTestId('tx-ids').textContent).toBe(FIRST_TX_ID);
  expect(screen.getByTestId('account-ids').textContent).toBe(ACCOUNT_ID);
  expect(screen.getByTestId('category-ids').textContent).toBe(CATEGORY_ID);

  // Write a new synthetic row directly to the fake IndexedDB while sync is
  // held. The context must not observe it until the post-sync refresh.
  const secondTransaction = seededTransaction(
    SECOND_TX_ID,
    '2026-11-02',
    4.25,
    2,
  );
  await db.put(STORES.TRANSACTIONS, secondTransaction);

  expect(await db.get(STORES.TRANSACTIONS, SECOND_TX_ID)).toMatchObject({
    id: SECOND_TX_ID,
    amount: 4.25,
  });
  expect(screen.getByTestId('tx-ids').textContent).toBe(FIRST_TX_ID);

  await act(async () => {
    expect(settleBackgroundSync).not.toBeNull();
    settleBackgroundSync?.(false);
  });

  await waitFor(() =>
    expect(screen.getByTestId('tx-ids').textContent).toBe(
      `${SECOND_TX_ID},${FIRST_TX_ID}`,
    ),
  );
  expect(backgroundSyncSettled).toBe(true);
  expect(mockBackgroundSync).toHaveBeenCalledTimes(1);
});

test.each(SAFETY_ONLY_STARTUP_CASES)(
  'refuses to assign an unowned safety-only $label cache to a new user',
  async ({ expected, seed, read }) => {
    const db = await getDB();
    await seed(db);
    const before = await read(db);
    expect(before).toEqual([expected]);
    expect(localStorage.getItem(LAST_USER_STORAGE_KEY)).toBeNull();

    authenticateCurrentUser();

    render(
      <TransactionProvider>
        <Probe />
      </TransactionProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('loading').textContent).toBe('false'),
    );
    expect(screen.getByTestId('scope').textContent).toBe('false');
    expect(screen.getByTestId('error').textContent).toBe(UNOWNED_ERROR);
    expect(screen.getByTestId('tx-ids').textContent).toBe('');
    expect(screen.getByTestId('account-ids').textContent).toBe('');
    expect(screen.getByTestId('category-ids').textContent).toBe('');

    // No ownership was claimed, no upload was attempted, and the safety
    // payload, owner, and lifecycle state remain byte-for-byte unchanged.
    expect(localStorage.getItem(LAST_USER_STORAGE_KEY)).toBeNull();
    expect(mockBackgroundSync).not.toHaveBeenCalled();
    expect(await read(db)).toEqual(before);
  },
);

test('claims a truly empty database for the newly authenticated user', async () => {
  const db = await getDB();
  for (const storeName of ALL_LOCAL_STORES) {
    expect(await db.count(storeName)).toBe(0);
  }

  authenticateCurrentUser();

  render(
    <TransactionProvider>
      <Probe />
    </TransactionProvider>,
  );

  await waitFor(() =>
    expect(screen.getByTestId('loading').textContent).toBe('false'),
  );
  await waitFor(() =>
    expect(screen.getByTestId('scope').textContent).toBe('true'),
  );

  expect(screen.getByTestId('error').textContent).toBe('');
  expect(localStorage.getItem(LAST_USER_STORAGE_KEY)).toBe(USER_ID);
  expect(screen.getByTestId('tx-ids').textContent).toBe('');
  expect(screen.getByTestId('account-ids').textContent).toBe('');
  expect(screen.getByTestId('category-ids').textContent).toBe('');

  await waitFor(() =>
    expect(mockBackgroundSync).toHaveBeenCalledTimes(1),
  );
});

test('AutoBackup does not create a snapshot while the new user scope is refused', async () => {
  const db = await getDB();
  await db.put(STORES.SYNC_DELETIONS, makeSafetyDeletion());

  authenticateCurrentUser();

  render(
    <TransactionProvider>
      <Probe />
      <AutoBackup />
    </TransactionProvider>,
  );

  await waitFor(() =>
    expect(screen.getByTestId('loading').textContent).toBe('false'),
  );
  expect(screen.getByTestId('scope').textContent).toBe('false');
  expect(localStorage.getItem('auto-backup-data')).toBeNull();
  expect(localStorage.getItem('auto-backup-time')).toBeNull();
  expect(mockBackgroundSync).not.toHaveBeenCalled();
});

test('AutoBackup does not replace an existing snapshot while the new user scope is refused', async () => {
  const db = await getDB();
  await db.put(STORES.SYNC_DELETIONS, makeSafetyDeletion());

  await expect(saveAutoBackup()).resolves.toBe(true);
  const previousData = localStorage.getItem('auto-backup-data');
  expect(previousData).not.toBeNull();

  // Age the snapshot so a new auto-backup would definitely overwrite it.
  localStorage.setItem('auto-backup-time', new Date(0).toISOString());
  const previousTime = localStorage.getItem('auto-backup-time');

  authenticateCurrentUser();

  render(
    <TransactionProvider>
      <Probe />
      <AutoBackup />
    </TransactionProvider>,
  );

  await waitFor(() =>
    expect(screen.getByTestId('loading').textContent).toBe('false'),
  );
  expect(screen.getByTestId('scope').textContent).toBe('false');
  expect(localStorage.getItem('auto-backup-data')).toBe(previousData);
  expect(localStorage.getItem('auto-backup-time')).toBe(previousTime);
  expect(mockBackgroundSync).not.toHaveBeenCalled();
});
