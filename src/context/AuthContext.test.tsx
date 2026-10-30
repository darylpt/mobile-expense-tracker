import React from 'react';
import { render, act, cleanup, fireEvent, screen } from '@testing-library/react';
import { AuthProvider, AuthContext } from './AuthContext';
import { AuthGuard } from '@/components/auth/AuthGuard';
import { TransactionList } from '@/components/summary/TransactionList';
import { FILTERS_STORAGE_KEY } from '@/lib/transaction-filters';

let authChanged: (event: string, session: { user: { id: string } } | null) => void;
jest.mock('@/lib/supabase', () => ({
  supabase: { auth: {
    getSession: () => new Promise(() => {}),
    signOut: async () => authChanged('SIGNED_OUT', null),
    onAuthStateChange: (callback: typeof authChanged) => {
      authChanged = callback;
      return { data: { subscription: { unsubscribe: jest.fn() } } };
    },
  } },
}));

let mockQuery = new URLSearchParams();
let mockPath = '/transactions';
const mockReplace = jest.fn();
const mockRouter = { replace: mockReplace };
jest.mock('next/navigation', () => ({
  useSearchParams: () => mockQuery,
  usePathname: () => mockPath,
  useRouter: () => mockRouter,
}));
jest.mock('@/context/TransactionContext', () => ({
  useTransactionContext: () => ({ transactions: [], accounts: [], isLoading: false }),
  formatAmount: (amount: number) => String(amount),
}));
jest.mock('@/components/forms/EditTransactionModal', () => ({ EditTransactionModal: () => null }));

beforeEach(() => {
  localStorage.clear();
  mockReplace.mockClear();
  mockQuery = new URLSearchParams();
  mockPath = '/transactions';
});
afterEach(cleanup);

function session(id: string | null) {
  act(() => authChanged('change', id ? { user: { id } } : null));
}

test('sign-out removes private filters before the next login', () => {
  render(<AuthProvider><span /></AuthProvider>);
  session('a');
  localStorage.setItem(FILTERS_STORAGE_KEY, 'q=private&cat=personal&account=a');
  session(null);
  expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBeNull();
  session('b');
  expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBeNull();
});

test('direct account changes clear filters but same-user events preserve them', () => {
  render(<AuthProvider><span /></AuthProvider>);
  session('a');
  localStorage.setItem(FILTERS_STORAGE_KEY, 'q=private');
  session('a');
  expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe('q=private');
  session('b');
  expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBeNull();
});

test.each(['a', 'b', null])('reload checks persisted ownership for %s', (id) => {
  localStorage.setItem('lastUserId', 'a');
  localStorage.setItem(FILTERS_STORAGE_KEY, 'q=private');
  render(<AuthProvider><span /></AuthProvider>);
  session(id);
  expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe(id === 'a' ? 'q=private' : null);
});


test('PIN sign-out remount cannot recreate private filters or restore them for B', async () => {
  localStorage.setItem('lastUserId', 'a');
  localStorage.setItem('app-lock-enabled', 'true');
  localStorage.setItem('app-lock-hash', 'hash');
  localStorage.setItem(FILTERS_STORAGE_KEY, 'q=private&cat=personal');
  mockQuery = new URLSearchParams('q=private&cat=personal');
  const tree = (key: string) => <AuthProvider><AuthGuard><TransactionList key={key} /></AuthGuard></AuthProvider>;
  const view = render(tree('a'));
  session('a');
  expect(screen.getByText('Sign out instead')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByText('Sign out instead')); });
  expect(mockReplace).toHaveBeenCalledWith('/login');
  expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBeNull();

  mockPath = '/login';
  localStorage.removeItem('lastUserId');
  localStorage.removeItem('app-lock-enabled');
  mockQuery = new URLSearchParams();
  view.rerender(tree('login'));
  session('b');
  mockPath = '/transactions';
  mockReplace.mockClear();
  view.rerender(tree('b'));
  expect(mockReplace).not.toHaveBeenCalled();
  expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBeNull();
});

test.each(['loading', 'unauthenticated'] as const)('%s does not read or write the filter mirror', (state) => {
  localStorage.setItem(FILTERS_STORAGE_KEY, 'q=private');
  const defaults = { state, user: null, isLocked: false };
  const tree = (key: string) => <AuthContext.Provider value={defaults as React.ContextType<typeof AuthContext>}><TransactionList key={key} /></AuthContext.Provider>;
  const view = render(tree('plain'));
  expect(mockReplace).not.toHaveBeenCalled();
  mockQuery = new URLSearchParams('q=another');
  view.rerender(tree('explicit'));
  expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe('q=private');
});

test('offline-disabled mode restores filters and keeps explicit URLs authoritative', () => {
  const value = { state: 'disabled', user: null, isLocked: false } as React.ContextType<typeof AuthContext>;
  const tree = (key: string) => <AuthContext.Provider value={value}><TransactionList key={key} /></AuthContext.Provider>;
  localStorage.setItem(FILTERS_STORAGE_KEY, 'q=saved&page=3');
  const view = render(tree('plain'));
  expect(mockReplace).toHaveBeenCalledWith('/transactions?q=saved', { scroll: false });
  mockQuery = new URLSearchParams('q=saved');
  view.rerender(tree('plain'));
  expect((screen.getAllByLabelText('Search transactions')[0] as HTMLInputElement).value).toBe('saved');
  mockQuery = new URLSearchParams('q=explicit&group=date&page=3');
  mockReplace.mockClear();
  view.rerender(tree('explicit'));
  expect(mockReplace).toHaveBeenCalledWith('/transactions?q=explicit&group=date', { scroll: false });
  expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe('q=explicit');
});
