// ============================================================
// auth-scope.test.ts — Generation, owner marker, and transaction aborts
// ============================================================

import { LAST_USER_STORAGE_KEY } from './constants';
// Value import exists only for the module's shape; the runtime instance is
// loaded dynamically after `jest.resetModules()`.
import * as authScopeModuleType from './auth-scope';

type AuthScopeModule = typeof authScopeModuleType;

let authScope: AuthScopeModule;

beforeEach(async () => {
  // The module owns one auth lifecycle per client, so each test needs a
  // fresh instance; jest.resetModules() only affects dynamic imports.
  jest.resetModules();
  localStorage.clear();
  authScope = await import('./auth-scope');
});

test('capture requires an authenticated identity and an exact owner marker', () => {
  expect(authScope.captureAuthScope()).toBeNull();

  authScope.publishAuthIdentity({ state: 'authenticated', userId: 'a' });
  expect(authScope.captureAuthScope()).toBeNull();

  localStorage.setItem(LAST_USER_STORAGE_KEY, 'b');
  expect(authScope.captureAuthScope()).toBeNull();

  localStorage.setItem(LAST_USER_STORAGE_KEY, 'a');
  const scope = authScope.captureAuthScope();
  expect(scope).toEqual({
    userId: 'a',
    generation: authScope.getAuthGeneration(),
  });
  expect(authScope.isAuthScopeCurrent(scope)).toBe(true);

  localStorage.setItem(LAST_USER_STORAGE_KEY, 'b');
  expect(authScope.isAuthScopeCurrent(scope)).toBe(false);
});

test('same-user publishes keep the generation while sign-out and A → A replace it', () => {
  const first = authScope.publishAuthIdentity({
    state: 'authenticated',
    userId: 'a',
  });
  expect(
    authScope.publishAuthIdentity({ state: 'authenticated', userId: 'a' }),
  ).toBe(first);

  const signedOut = authScope.publishAuthIdentity({
    state: 'unauthenticated',
  });
  expect(signedOut).toBeGreaterThan(first);
  expect(authScope.getAuthGeneration()).toBe(signedOut);

  const signedBackIn = authScope.publishAuthIdentity({
    state: 'authenticated',
    userId: 'a',
  });
  expect(signedBackIn).toBeGreaterThan(signedOut);
  expect(authScope.getAuthGeneration()).toBe(signedBackIn);
});

test('a new identity aborts active work while same-user publishes leave it running', () => {
  localStorage.setItem(LAST_USER_STORAGE_KEY, 'a');
  authScope.publishAuthIdentity({ state: 'authenticated', userId: 'a' });
  const scope = authScope.captureAuthScope();
  expect(scope).not.toBeNull();

  const active = new AbortController();
  const release = authScope.registerAuthTransaction(scope, active);
  expect(active.signal.aborted).toBe(false);

  authScope.publishAuthIdentity({ state: 'authenticated', userId: 'a' });
  expect(active.signal.aborted).toBe(false);

  authScope.publishAuthIdentity({ state: 'unauthenticated' });
  expect(active.signal.aborted).toBe(true);
  expect(active.signal.reason).toBe('auth-scope-invalidated');
  release();
});

test('a stale token aborts immediately and release prevents a later abort', () => {
  localStorage.setItem(LAST_USER_STORAGE_KEY, 'a');
  authScope.publishAuthIdentity({ state: 'authenticated', userId: 'a' });
  const staleScope = authScope.captureAuthScope();

  const completed = new AbortController();
  const release = authScope.registerAuthTransaction(staleScope, completed);
  expect(completed.signal.aborted).toBe(false);
  release();

  authScope.publishAuthIdentity({ state: 'unauthenticated' });
  expect(completed.signal.aborted).toBe(false);

  const late = new AbortController();
  authScope.registerAuthTransaction(staleScope, late);
  expect(late.signal.aborted).toBe(true);
});
