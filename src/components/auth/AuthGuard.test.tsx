// ============================================================
// AuthGuard.test.tsx — fail-closed rendering and public-route matching
// ============================================================

import React, { type ReactNode } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { AuthContext } from '@/context/AuthContext';
import { AuthGuard } from './AuthGuard';

const mockReplace = jest.fn();
let mockPathname = '/transactions';

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock('@/components/auth/PinScreen', () => ({
  PinScreen: () => <div data-testid="pin-screen">locked</div>,
}));

type AuthValue = React.ContextType<typeof AuthContext>;

function authValue(overrides: Partial<AuthValue> = {}): AuthValue {
  return {
    state: 'authenticated',
    user: { id: 'user-1', email: 'one@example.com' } as unknown as AuthValue['user'],
    signIn: jest.fn(async () => ({})),
    signInWithOAuth: jest.fn(async () => ({})),
    signOut: jest.fn(async () => {}),
    isLocked: false,
    hasLock: false,
    unlock: jest.fn(async () => true),
    setPin: jest.fn(async () => {}),
    clearPin: jest.fn(),
    verifyPin: jest.fn(async () => true),
    ...overrides,
  } as unknown as AuthValue;
}

function tree(state: AuthValue, children: ReactNode = <div data-testid="private">private</div>) {
  return (
    <AuthContext.Provider value={state}>
      <AuthGuard>{children}</AuthGuard>
    </AuthContext.Provider>
  );
}

beforeEach(() => {
  mockPathname = '/transactions';
  mockReplace.mockClear();
});

afterEach(cleanup);

test('does not render private children while unauthenticated and redirects to login', () => {
  render(tree(authValue({ state: 'unauthenticated', user: null })));

  expect(screen.queryByTestId('private')).toBeNull();
  expect(mockReplace).toHaveBeenCalledWith('/login');
});

test('renders the public login route while unauthenticated', () => {
  mockPathname = '/login';
  render(
    tree(
      authValue({ state: 'unauthenticated', user: null }),
      <div data-testid="login">login form</div>,
    ),
  );

  expect(screen.getByTestId('login')).toBeTruthy();
  expect(mockReplace).not.toHaveBeenCalled();
});

test('renders the public login route on a trailing-slash pathname while unauthenticated', () => {
  mockPathname = '/login/';
  render(
    tree(
      authValue({ state: 'unauthenticated', user: null }),
      <div data-testid="login">login form</div>,
    ),
  );

  expect(screen.getByTestId('login')).toBeTruthy();
  expect(mockReplace).not.toHaveBeenCalled();
});

test.each([
  '/transactions',
  '/transactions/',
  '/login/help',
  '/login/help/',
  '/login-help',
  '/login-admin',
  '/other/login',
  '/settings',
  '/settings/',
  '/Login',
  '/LOGIN/',
  '/login//',
  '//login',
])('keeps %s protected while unauthenticated', (pathname) => {
  mockPathname = pathname;
  render(
    tree(
      authValue({ state: 'unauthenticated', user: null }),
      <div data-testid="login">login form</div>,
    ),
  );

  expect(screen.queryByTestId('login')).toBeNull();
  expect(mockReplace).toHaveBeenCalledWith('/login');
});

test('renders private children when authenticated', () => {
  render(tree(authValue()));

  expect(screen.getByTestId('private')).toBeTruthy();
  expect(mockReplace).not.toHaveBeenCalled();
});

test('renders private children when authenticated on a trailing-slash pathname', () => {
  mockPathname = '/transactions/';
  render(tree(authValue()));

  expect(screen.getByTestId('private')).toBeTruthy();
  expect(mockReplace).not.toHaveBeenCalled();
});

test.each(['/transactions', '/login', '/login/'])(
  'shows the loading spinner on %s without exposing children',
  (pathname) => {
    mockPathname = pathname;
    const { container } = render(
      tree(
        authValue({ state: 'loading', user: null }),
        <div data-testid="login">login form</div>,
      ),
    );

    expect(container.querySelector('.animate-spin')).toBeTruthy();
    expect(screen.queryByTestId('login')).toBeNull();
    expect(screen.queryByTestId('private')).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
  },
);

test('preserves auth-disabled passthrough without redirecting', () => {
  render(
    tree(authValue({ state: 'disabled', user: null }), <div data-testid="local">local</div>),
  );

  expect(screen.getByTestId('local')).toBeTruthy();
  expect(mockReplace).not.toHaveBeenCalled();
});

test('keeps the PIN lock gate ahead of private content', () => {
  render(tree(authValue({ isLocked: true })));

  expect(screen.getByTestId('pin-screen')).toBeTruthy();
  expect(screen.queryByTestId('private')).toBeNull();
});

test('keeps the PIN lock gate ahead of the trailing-slash login route', () => {
  mockPathname = '/login/';
  render(tree(authValue({ isLocked: true }), <div data-testid="login">login form</div>));

  expect(screen.getByTestId('pin-screen')).toBeTruthy();
  expect(screen.queryByTestId('login')).toBeNull();
  expect(mockReplace).not.toHaveBeenCalled();
});

test('keeps the PIN lock gate ahead of auth-disabled passthrough', () => {
  render(
    tree(
      authValue({ state: 'disabled', user: null, isLocked: true }),
      <div data-testid="local">local</div>,
    ),
  );

  expect(screen.getByTestId('pin-screen')).toBeTruthy();
  expect(screen.queryByTestId('local')).toBeNull();
  expect(mockReplace).not.toHaveBeenCalled();
});

test('hides private content as soon as the identity becomes unauthenticated', () => {
  const { rerender } = render(tree(authValue()));
  expect(screen.getByTestId('private')).toBeTruthy();

  rerender(tree(authValue({ state: 'unauthenticated', user: null })));

  expect(screen.queryByTestId('private')).toBeNull();
  expect(mockReplace).toHaveBeenCalledWith('/login');
});

test('redirects an authenticated user away from the login route', () => {
  mockPathname = '/login';
  render(tree(authValue(), <div data-testid="login">login form</div>));

  expect(mockReplace).toHaveBeenCalledWith('/');
  expect(screen.getByTestId('login')).toBeTruthy();
});

test('redirects an authenticated user away from the trailing-slash login route', () => {
  mockPathname = '/login/';
  render(tree(authValue(), <div data-testid="login">login form</div>));

  expect(mockReplace).toHaveBeenCalledWith('/');
  expect(screen.getByTestId('login')).toBeTruthy();
});
