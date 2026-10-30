import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SettingsPage from './page';
import type { DatasetReplacementMarker } from '@/lib/dataset-replacement';

let mockMarker: DatasetReplacementMarker | null;
const mockRefresh = jest.fn(async () => {});
const mockRecords: never[] = [];

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ state: 'authenticated', user: { id: 'user-1' } }),
}));
jest.mock('@/context/TransactionContext', () => ({
  useTransactionContext: () => ({ transactions: mockRecords, refreshTransactions: mockRefresh }),
}));
jest.mock('@/hooks/useAccounts', () => ({
  useAccounts: () => ({ accounts: mockRecords, isLoading: false, refreshAccounts: mockRefresh }),
}));
jest.mock('@/hooks/useCategories', () => ({
  useCategories: () => ({ categories: mockRecords, isLoading: false, refreshCategories: mockRefresh }),
}));
jest.mock('@/hooks/useStocks', () => ({
  useStocks: () => ({ stocks: mockRecords, isLoading: false }),
}));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/components/layout/Header', () => ({ Header: () => null }));
jest.mock('@/components/stocks/ManageTickers', () => ({ ManageTickers: () => null }));
jest.mock('@/lib/idb', () => ({
  getDatasetReplacementMarker: async () => mockMarker,
  getOrphanAccountGroups: async () => [],
  getAutoBackup: () => null,
}));
jest.mock('@/lib/sync', () => ({ backgroundSync: jest.fn(), resolveReplacementConflict: jest.fn() }));

beforeEach(() => {
  window.history.replaceState(null, '', '/settings');
  mockMarker = {
    userId: 'user-1', generation: 2, snapshotId: 'snapshot', status: 'applied', snapshot: null,
    remoteGeneration: null, attempts: 0, lastError: null, updatedAt: 1,
  };
});

it.each(['Data Tools', 'Import / Export Data'])(
  'refreshes status and recovery controls while %s remains open', async (entry) => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(entry) }));
    const panel = within(screen.getByRole('heading', { name: 'Import from Google Sheets' }).closest('section')!);
    await panel.findByText('Saved locally and replaced in the cloud.');
    expect(screen.queryByRole('button', { name: 'Replace cloud data with this snapshot' })).toBeNull();

    await act(async () => {
      mockMarker = { ...mockMarker!, status: 'conflict', remoteGeneration: 2, lastError: 'Local edits waiting.' };
      window.dispatchEvent(new CustomEvent('sync-complete'));
    });
    await screen.findByRole('button', { name: 'Replace cloud data with this snapshot' });
    expect(screen.queryByText('Saved locally and replaced in the cloud.')).toBeNull();
    expect(panel.getByRole('status').textContent).toContain('Cloud records conflict with local edits.');
    expect(panel.getByRole('status').textContent).toContain('Local edits waiting.');
    expect(panel.queryByText(/another device/i)).toBeNull();
    expect(panel.getByText(/Replace the entire cloud dataset/).textContent).toContain('Cloud records conflict with local edits.');

    await act(async () => {
      mockMarker = { ...mockMarker!, remoteGeneration: 3, lastError: 'Cloud generation 3. Local edits waiting.' };
      window.dispatchEvent(new CustomEvent('sync-complete'));
    });
    await waitFor(() => expect(panel.getByRole('status').textContent).toContain('The cloud dataset was replaced by another device.'));
    expect(panel.getByRole('status').textContent).toContain('Cloud generation 3.');
    expect(panel.getByText(/Replace the entire cloud dataset/).textContent).toContain('The cloud dataset was replaced by another device.');
    expect(panel.queryByText(/after this import/)).toBeNull();

    await act(async () => {
      mockMarker = { ...mockMarker!, status: 'failed', lastError: 'Permission denied' };
      window.dispatchEvent(new CustomEvent('sync-complete'));
    });
    await screen.findByRole('button', { name: 'Retry cloud replacement' });
    expect(screen.queryByRole('button', { name: 'Replace cloud data with this snapshot' })).toBeNull();
    expect(panel.getByRole('status').textContent).toContain('Permission denied');

    await act(async () => {
      mockMarker = { ...mockMarker!, status: 'applied', lastError: null };
      window.dispatchEvent(new CustomEvent('sync-complete'));
    });
    await screen.findByText('Saved locally and replaced in the cloud.');
    expect(screen.queryByRole('button', { name: 'Retry cloud replacement' })).toBeNull();

    await act(async () => {
      mockMarker = null;
      window.dispatchEvent(new CustomEvent('sync-complete'));
    });
    await waitFor(() => expect(panel.queryByRole('status')).toBeNull());
  }
);
