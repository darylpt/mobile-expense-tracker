import React from 'react';
import { render, act, cleanup } from '@testing-library/react';
import { AuthProvider } from './AuthContext';
import { FILTERS_STORAGE_KEY } from '@/lib/transaction-filters';

let authChanged: (event: string, session: { user: { id: string } } | null) => void;
jest.mock('@/lib/supabase', () => ({
  supabase: { auth: {
    getSession: () => new Promise(() => {}),
    onAuthStateChange: (callback: typeof authChanged) => {
      authChanged = callback;
      return { data: { subscription: { unsubscribe: jest.fn() } } };
    },
  } },
}));

beforeEach(() => localStorage.clear());
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
