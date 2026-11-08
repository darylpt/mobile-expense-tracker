// ============================================================
// Header.test.tsx — sync-status refresh lifecycle
//
// Mounts the real Header with only the auth/transaction boundary, Next
// router, and sync module doubled. Uses fake timers to verify the initial
// refresh, 30-second polling, storage/sync events, manual and retry actions,
// rejection clearing, and listener/timer cleanup.
// ============================================================

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Header } from './Header';
import {
  backgroundSync,
  getSyncStatus,
  retrySyncWork,
  type SyncStatus,
} from '@/lib/sync';

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    state: 'authenticated',
    user: { id: 'header-user', email: 'header@example.com' },
    signOut: jest.fn(),
  }),
}));

jest.mock('@/context/TransactionContext', () => ({
  useTransactionContext: () => ({
    hideAmounts: false,
    toggleHideAmounts: jest.fn(),
    isScopeVerified: true,
    isLoading: false,
  }),
}));

jest.mock('next/navigation', () => ({
  usePathname: () => '/',
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

jest.mock('@/lib/sync', () => ({
  backgroundSync: jest.fn(),
  getSyncStatus: jest.fn(),
  retrySyncWork: jest.fn(),
}));

const mockBackgroundSync = jest.mocked(backgroundSync);
const mockGetSyncStatus = jest.mocked(getSyncStatus);
const mockRetrySyncWork = jest.mocked(retrySyncWork);

const IDLE_STATUS: SyncStatus = {
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

function makeStatus(patch: Partial<SyncStatus>): SyncStatus {
  return { ...IDLE_STATUS, ...patch };
}

async function flushAsync(turns = 5): Promise<void> {
  await act(async () => {
    for (let i = 0; i < turns; i += 1) {
      await Promise.resolve();
    }
  });
}

function dispatchWindowEvent(event: Event): void {
  act(() => {
    window.dispatchEvent(event);
  });
}

describe('Header sync status lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockBackgroundSync.mockReset();
    mockGetSyncStatus.mockReset();
    mockRetrySyncWork.mockReset();
    mockBackgroundSync.mockResolvedValue(false);
    mockRetrySyncWork.mockResolvedValue(0);
    mockGetSyncStatus.mockResolvedValue(IDLE_STATUS);
  });

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  it('refreshes immediately on mount and renders the published status', async () => {
    mockGetSyncStatus.mockResolvedValue(makeStatus({ pending: 3 }));

    render(<Header />);
    await flushAsync();

    expect(mockGetSyncStatus).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('3 pending').length).toBeGreaterThan(0);
  });

  it('polls every 30 seconds while mounted', async () => {
    render(<Header />);
    await flushAsync();
    expect(mockGetSyncStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    expect(mockGetSyncStatus).toHaveBeenCalledTimes(2);
  });

  it('refreshes on last_sync_time storage events only', async () => {
    render(<Header />);
    await flushAsync();
    expect(mockGetSyncStatus).toHaveBeenCalledTimes(1);

    dispatchWindowEvent(new StorageEvent('storage', { key: 'last_sync_time' }));
    await flushAsync();
    expect(mockGetSyncStatus).toHaveBeenCalledTimes(2);

    dispatchWindowEvent(new StorageEvent('storage', { key: 'tab_prefs' }));
    await flushAsync();
    expect(mockGetSyncStatus).toHaveBeenCalledTimes(2);
  });

  it('refreshes on sync-status-changed and sync-complete events', async () => {
    render(<Header />);
    await flushAsync();
    expect(mockGetSyncStatus).toHaveBeenCalledTimes(1);

    dispatchWindowEvent(new Event('sync-status-changed'));
    await flushAsync();
    expect(mockGetSyncStatus).toHaveBeenCalledTimes(2);

    dispatchWindowEvent(new Event('sync-complete'));
    await flushAsync();
    expect(mockGetSyncStatus).toHaveBeenCalledTimes(3);
  });

  it('runs a manual sync and refreshes status afterwards', async () => {
    mockGetSyncStatus.mockResolvedValue(makeStatus({ pending: 2 }));

    render(<Header />);
    await flushAsync();
    expect(mockGetSyncStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Sync now' })[0]);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });

    expect(mockBackgroundSync).toHaveBeenCalledTimes(1);
    expect(mockGetSyncStatus).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText('2 pending').length).toBeGreaterThan(0);
  });

  it('retries paused work and then runs the manual sync path', async () => {
    mockGetSyncStatus.mockResolvedValue(makeStatus({ blocked: 2 }));

    render(<Header />);
    await flushAsync();
    expect(mockGetSyncStatus).toHaveBeenCalledTimes(1);

    const retryButton = screen.getAllByRole('button', { name: /2 paused/ })[0];
    await act(async () => {
      fireEvent.click(retryButton);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(mockRetrySyncWork).toHaveBeenCalledTimes(1);
    expect(mockBackgroundSync).toHaveBeenCalledTimes(1);
    expect(mockGetSyncStatus).toHaveBeenCalledTimes(2);
  });

  it('clears the published status when a refresh rejects', async () => {
    mockGetSyncStatus
      .mockResolvedValueOnce(makeStatus({ pending: 3 }))
      .mockRejectedValueOnce(new Error('status read failed'));

    render(<Header />);
    await flushAsync();
    expect(screen.getAllByText('3 pending').length).toBeGreaterThan(0);

    dispatchWindowEvent(new Event('sync-complete'));
    await flushAsync();

    expect(screen.queryAllByText('3 pending')).toHaveLength(0);
    expect(screen.getAllByText('checking…').length).toBeGreaterThan(0);
  });

  it('clears the interval and event listeners on unmount', async () => {
    const { unmount } = render(<Header />);
    await flushAsync();
    expect(mockGetSyncStatus).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      jest.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    dispatchWindowEvent(new StorageEvent('storage', { key: 'last_sync_time' }));
    dispatchWindowEvent(new Event('sync-status-changed'));
    dispatchWindowEvent(new Event('sync-complete'));
    await flushAsync();

    expect(mockGetSyncStatus).toHaveBeenCalledTimes(1);
  });
});
