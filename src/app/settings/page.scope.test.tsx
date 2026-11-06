// ============================================================
// page.scope.test.tsx — Settings data-tool ownership gating
//
// Renders the real Settings page under the real TransactionProvider with
// fake-indexeddb. Only auth identity, Next router, and sync network seams are
// mocked; local ownership detection, auto-backup reading, and the export path
// stay real.
// ============================================================

import 'fake-indexeddb/auto';

// fake-indexeddb v6 needs structuredClone — polyfill for jsdom
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (val: unknown) => JSON.parse(JSON.stringify(val));
}

import React from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import SettingsPage from './page';
import { TransactionProvider } from '@/context/TransactionContext';
import {
  backgroundSync,
  getSyncStatus,
  type SyncStatus,
} from '@/lib/sync';
import { publishAuthIdentity } from '@/lib/auth-scope';
import {
  getDB,
  saveAutoBackup,
  type SyncDeletionSnapshot,
} from '@/lib/idb';
import {
  DATA_STORES,
  DB_NAME,
  LAST_USER_STORAGE_KEY,
  STORES,
} from '@/lib/constants';
import type { Transaction } from '@/types';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const SAFETY_DELETION_ID = '88888888-8888-4888-8888-888888888888';

const ALL_LOCAL_STORES = [
  ...DATA_STORES,
  STORES.SYNC_QUEUE,
  STORES.SYNC_META,
  STORES.SYNC_DELETIONS,
] as const;

const IDLE_SYNC_STATUS: SyncStatus = {
  queue: 0,
  pending: 0,
  blocked: 0,
  conflict: 0,
  quarantined: 0,
  failed: 0,
  unresolved: 0,
  lastSyncAt: null,
  lastAttemptFailed: false,
  canClaimSynced: true,
};

let mockAuthState: {
  state: 'authenticated' | 'unauthenticated' | 'loading' | 'disabled';
  user: { id: string; email: string } | null;
  authGeneration: number;
  signOut: jest.Mock;
} = {
  state: 'loading',
  user: null,
  authGeneration: 0,
  signOut: jest.fn(),
};

const mockPush = jest.fn();
const mockRefresh = jest.fn();

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => mockAuthState,
}));

jest.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useRouter: () => ({
    push: mockPush,
    replace: jest.fn(),
    refresh: mockRefresh,
    prefetch: jest.fn(),
  }),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: 'a',
}));

jest.mock('@/lib/sync', () => ({
  backgroundSync: jest.fn(),
  getSyncStatus: jest.fn(),
  retrySyncWork: jest.fn(),
}));

const mockBackgroundSync = backgroundSync as jest.MockedFunction<typeof backgroundSync>;
const mockGetSyncStatus = getSyncStatus as jest.MockedFunction<typeof getSyncStatus>;

let capturedBlob: Blob | null = null;
let createObjectURL: jest.Mock;
let anchorClick: jest.SpyInstance;

function seededSafetyDeletion(ownerId: string | null): SyncDeletionSnapshot {
  const payload: Transaction = {
    id: '99999999-9999-4999-8999-999999999999',
    amount: 17.25,
    date: '2026-11-01',
    type: 'expense',
    category: 'Test Groceries',
    fromAccount: ACCOUNT_ID,
    toAccount: null,
    description: 'Synthetic settings safety row',
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    id: SAFETY_DELETION_ID,
    storeName: STORES.TRANSACTIONS,
    recordId: payload.id,
    payload,
    deletedAt: 1,
    ownerId,
    state: ownerId ? 'pending' : 'quarantined',
    reason: 'local-delete',
    baselineRevision: null,
    lastError: ownerId ? null : 'No verified account owns this deletion',
    updatedAt: 1,
  };
}

function authenticateCurrentUser(): number {
  const authGeneration = publishAuthIdentity({
    state: 'authenticated',
    userId: USER_ID,
  });
  mockAuthState = {
    state: 'authenticated',
    user: { id: USER_ID, email: 'settings@example.com' },
    authGeneration,
    signOut: jest.fn(),
  };
  return authGeneration;
}

function readBlobText(blob: Blob): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsText(blob);
  return promise;
}

function installDownloadCapture(): void {
  capturedBlob = null;
  createObjectURL = jest.fn((blob: Blob) => {
    capturedBlob = blob;
    return 'blob:settings-test';
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: jest.fn(),
  });
  anchorClick = jest
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => {});
}

async function clearLocalStores(): Promise<void> {
  const db = await getDB();
  for (const storeName of ALL_LOCAL_STORES) {
    await db.clear(storeName);
  }
}

beforeEach(async () => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  localStorage.clear();
  mockAuthState = {
    state: 'loading',
    user: null,
    authGeneration: 0,
    signOut: jest.fn(),
  };

  Object.defineProperty(window, 'confirm', {
    configurable: true,
    writable: true,
    value: jest.fn(() => true),
  });
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value: true,
  });

  mockBackgroundSync.mockResolvedValue(true);
  mockGetSyncStatus.mockResolvedValue(IDLE_SYNC_STATUS);

  await clearLocalStores();
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
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

test('locks every data-tool action for an unowned safety-only cache', async () => {
  const db = await getDB();
  const safety = seededSafetyDeletion(null);
  await db.put(STORES.SYNC_DELETIONS, safety);

  // A synthetic existing snapshot makes the restore control render.
  await expect(saveAutoBackup()).resolves.toBe(true);
  const autoBackupBefore = localStorage.getItem('auto-backup-data');
  expect(autoBackupBefore).not.toBeNull();

  authenticateCurrentUser();
  installDownloadCapture();
  const confirmSpy = window.confirm as jest.Mock;

  const { container } = render(
    <TransactionProvider>
      <SettingsPage />
    </TransactionProvider>,
  );

  fireEvent.click(await screen.findByRole('button', { name: 'Data Tools' }));
  const exportAll = await screen.findByRole('button', { name: 'Export All (JSON)' });
  const exportCsv = screen.getByRole('button', { name: 'Export Transactions (CSV)' });
  const importButton = screen.getByRole('button', { name: 'Import from file…' });
  const restoreButton = await screen.findByRole('button', {
    name: 'Restore from auto-backup',
  });

  expect((exportAll as HTMLButtonElement).disabled).toBe(true);
  expect((exportCsv as HTMLButtonElement).disabled).toBe(true);
  expect((importButton as HTMLButtonElement).disabled).toBe(true);
  expect((restoreButton as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Data tools are locked/)).not.toBeNull();
  const providerLock = await screen.findByText(
    /Local data is locked to another account/,
  );
  expect(providerLock).not.toBeNull();

  fireEvent.click(exportAll);
  fireEvent.click(exportCsv);
  fireEvent.click(importButton);
  fireEvent.click(restoreButton);

  const importInput = container.querySelector<HTMLInputElement>(
    'input[type="file"][accept=".json"]',
  );
  expect(importInput).not.toBeNull();
  const backupFile = new File(
    [JSON.stringify({ version: 1, data: { transactions: [] } })],
    'backup.json',
    { type: 'application/json' },
  );
  fireEvent.change(importInput as HTMLInputElement, {
    target: { files: [backupFile] },
  });

  // No download, confirmation, or import write happened.
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(anchorClick).not.toHaveBeenCalled();
  expect(confirmSpy).not.toHaveBeenCalled();
  expect(screen.queryByText('Export downloaded.')).toBeNull();
  expect(screen.queryByText('Data imported. Reload the page to see changes.')).toBeNull();
  expect(await db.get(STORES.SYNC_DELETIONS, safety.id)).toEqual(safety);
  expect(await db.count(STORES.SYNC_DELETIONS)).toBe(1);
  expect(localStorage.getItem('auto-backup-data')).toBe(autoBackupBefore);
  expect(localStorage.getItem(LAST_USER_STORAGE_KEY)).toBeNull();
  expect(mockBackgroundSync).not.toHaveBeenCalled();
});

test('matching owner can still export all thirteen stores through Settings', async () => {
  const db = await getDB();
  const safety = seededSafetyDeletion(USER_ID);
  await db.put(STORES.SYNC_DELETIONS, safety);
  localStorage.setItem(LAST_USER_STORAGE_KEY, USER_ID);

  authenticateCurrentUser();
  installDownloadCapture();

  render(
    <TransactionProvider>
      <SettingsPage />
    </TransactionProvider>,
  );

  fireEvent.click(await screen.findByRole('button', { name: 'Data Tools' }));
  const exportAll = await screen.findByRole('button', { name: 'Export All (JSON)' });
  await waitFor(() =>
    expect((exportAll as HTMLButtonElement).disabled).toBe(false),
  );

  fireEvent.click(exportAll);
  await screen.findByText('Export downloaded.');

  expect(createObjectURL).toHaveBeenCalledTimes(1);
  expect(anchorClick).toHaveBeenCalledTimes(1);
  expect(capturedBlob).not.toBeNull();

  const backup = JSON.parse(
    await readBlobText(capturedBlob as Blob),
  ) as { data: Record<string, unknown[]> };

  expect(Object.keys(backup.data).sort()).toEqual([...ALL_LOCAL_STORES].sort());
  expect(backup.data.syncDeletions).toContainEqual(safety);
  await waitFor(() =>
    expect(mockBackgroundSync).toHaveBeenCalledTimes(1),
  );
});
