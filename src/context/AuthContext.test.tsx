import React from 'react';
import { render, act, cleanup, fireEvent, screen } from '@testing-library/react';
import { AuthProvider, AuthContext, useAuth } from './AuthContext';
import { AuthGuard } from '@/components/auth/AuthGuard';
import { TransactionList } from '@/components/summary/TransactionList';
import { FILTERS_STORAGE_KEY } from '@/lib/transaction-filters';

type MockSessionResult = { data: { session: { user: { id: string } } | null } };

let authChanged: (event: string, session: { user: { id: string } } | null) => void;
let mockSessionRequest: (() => Promise<MockSessionResult>) | null = null;
jest.mock('@/lib/supabase', () => ({
  supabase: { auth: {
    getSession: () =>
      mockSessionRequest ? mockSessionRequest() : new Promise(() => {}),
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
  mockSessionRequest = null;
  localStorage.clear();
  window.history.replaceState(null, '', '/transactions');
  mockReplace.mockClear();
  mockQuery = new URLSearchParams();
  mockPath = '/transactions';
});
afterEach(cleanup);

function session(id: string | null) {
  act(() => authChanged('change', id ? { user: { id } } : null));
}

function deferredSession() {
  const { promise, resolve, reject } =
    Promise.withResolvers<MockSessionResult>();
  mockSessionRequest = () => promise;
  return { resolve, reject };
}

function AuthProbe() {
  const { state, user } = useAuth();
  return <span>{`${state}:${user?.id ?? 'none'}`}</span>;
}

function AuthGenerationProbe() {
  const { authGeneration } = useAuth();
  return <span data-testid="auth-generation">{authGeneration}</span>;
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
  expect(window.location.search).toBe('');
  expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBeNull();
});

test.each(['loading', 'unauthenticated'] as const)('%s does not read or write the filter mirror', (state) => {
  localStorage.setItem(FILTERS_STORAGE_KEY, 'q=private');
  const defaults = { state, user: null, isLocked: false };
  const tree = (key: string) => <AuthContext.Provider value={defaults as React.ContextType<typeof AuthContext>}><TransactionList key={key} /></AuthContext.Provider>;
  const view = render(tree('plain'));
  expect(mockReplace).not.toHaveBeenCalled();
  expect(window.location.search).toBe('');
  mockQuery = new URLSearchParams('q=another');
  view.rerender(tree('explicit'));
  expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe('q=private');
});

test('offline-disabled mode restores filters and keeps explicit URLs authoritative', () => {
  const value = { state: 'disabled', user: null, isLocked: false } as React.ContextType<typeof AuthContext>;
  const tree = (key: string) => <AuthContext.Provider value={value}><TransactionList key={key} /></AuthContext.Provider>;
  localStorage.setItem(FILTERS_STORAGE_KEY, 'q=saved&page=3');
  const view = render(tree('plain'));
  expect(window.location.search).toBe('?q=saved');
  mockQuery = new URLSearchParams('q=saved');
  view.rerender(tree('plain'));
  expect((screen.getAllByLabelText('Search transactions')[0] as HTMLInputElement).value).toBe('saved');
  mockQuery = new URLSearchParams('q=explicit&group=date&page=3');
  window.history.replaceState(null, '', '/transactions?q=explicit&group=date&page=3');
  mockReplace.mockClear();
  view.rerender(tree('explicit'));
  expect(window.location.search).toBe('?q=explicit&group=date');
  expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe('q=explicit');
});

test('repeated same-user events keep the generation stable while A → signed out → A advances it', () => {
  render(<AuthProvider><AuthGenerationProbe /></AuthProvider>);

  session('a');
  const signedIn = Number(
    screen.getByTestId('auth-generation').textContent,
  );
  session('a');
  expect(
    Number(screen.getByTestId('auth-generation').textContent),
  ).toBe(signedIn);

  session(null);
  const signedOut = Number(
    screen.getByTestId('auth-generation').textContent,
  );
  expect(signedOut).toBeGreaterThan(signedIn);

  session('a');
  expect(
    Number(screen.getByTestId('auth-generation').textContent),
  ).toBeGreaterThan(signedOut);
});

test('a stale initial session response cannot re-authenticate after a sign-out', async () => {
  const stale = deferredSession();
  render(<AuthProvider><AuthProbe /></AuthProvider>);
  expect(screen.getByText('loading:none')).toBeTruthy();

  act(() => authChanged('SIGNED_OUT', null));
  expect(screen.getByText('unauthenticated:none')).toBeTruthy();

  await act(async () => {
    stale.resolve({ data: { session: { user: { id: 'a' } } } });
  });

  expect(screen.getByText('unauthenticated:none')).toBeTruthy();
});

test('a stale initial session rejection cannot sign out a newer signed-in user', async () => {
  const stale = deferredSession();
  render(<AuthProvider><AuthProbe /></AuthProvider>);
  expect(screen.getByText('loading:none')).toBeTruthy();

  act(() => authChanged('SIGNED_IN', { user: { id: 'b' } }));
  expect(screen.getByText('authenticated:b')).toBeTruthy();

  await act(async () => {
    stale.reject(new Error('initial session unavailable'));
  });

  expect(screen.getByText('authenticated:b')).toBeTruthy();
});
