// ============================================================
// auth-scope.ts — Shared auth identity, generation, and scope tokens
//
// AuthProvider is the only publisher. Downstream work captures an
// AuthScope and checks it before acting on account-scoped data.
//
// A scope token is only valid while:
//   - its generation is still the active generation,
//   - the active identity is authenticated as the same user, and
//   - the persisted LAST_USER_STORAGE_KEY marker matches that user.
//
// Publishing a changed identity advances the generation and aborts
// every registered transaction synchronously, before React state is
// updated. Re-publishing the same identity does not advance it.
// ============================================================

import { LAST_USER_STORAGE_KEY } from '@/lib/constants';

// ============================================================
// Types
// ============================================================

export type AuthIdentity =
  | { readonly state: 'authenticated'; readonly userId: string }
  | { readonly state: 'disabled' | 'loading' | 'unauthenticated' };

/** Captured proof that work was authorized for one account generation. */
export interface AuthScope {
  readonly userId: string;
  readonly generation: number;
}

/**
 * A cancellable unit of account-scoped work. `abort` must be safe to
 * call synchronously and must not throw.
 */
export interface AuthTransaction {
  abort(reason?: unknown): unknown;
  /** Optional: lets the module stop tracking when the work aborts itself. */
  readonly signal?: AbortSignal;
}

/** Removes a registration once work completes or fails on its own. */
export type ReleaseAuthTransaction = () => void;

const AUTH_SCOPE_ABORT_REASON = 'auth-scope-invalidated';

// ============================================================
// Module state (one auth lifecycle per client)
// ============================================================

let currentIdentity: AuthIdentity = { state: 'loading' };
let generation = 0;

interface Registration {
  readonly scope: AuthScope;
  readonly transaction: AuthTransaction;
  detachAbortListener?: () => void;
}

const registrations = new Set<Registration>();

// ============================================================
// Helpers
// ============================================================

function readOwnerMarker(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(LAST_USER_STORAGE_KEY);
  } catch {
    return null;
  }
}

function isSameIdentity(a: AuthIdentity, b: AuthIdentity): boolean {
  if (a.state !== b.state) return false;
  if (a.state === 'authenticated' && b.state === 'authenticated') {
    return a.userId === b.userId;
  }
  return true;
}

function abortTransaction(transaction: AuthTransaction): void {
  try {
    const result = transaction.abort(AUTH_SCOPE_ABORT_REASON);
    if (
      result &&
      typeof (result as PromiseLike<unknown>).then === 'function'
    ) {
      // Abort is synchronous for callers; never leak a rejection.
      Promise.resolve(result).catch(() => {});
    }
  } catch {
    // A failing abort must not prevent other transactions from aborting.
  }
}

function invalidateRegistrations(): void {
  // Copy first: abort listeners may re-enter the registry.
  for (const registration of [...registrations]) {
    registrations.delete(registration);
    registration.detachAbortListener?.();
    abortTransaction(registration.transaction);
  }
}

// ============================================================
// Public API
// ============================================================

export function getAuthGeneration(): number {
  return generation;
}

/**
 * Publishes the active identity. Returns the resulting generation.
 *
 * Same-identity notifications are a no-op. Any other transition revokes
 * the previous generation and aborts its transactions before returning.
 */
export function publishAuthIdentity(identity: AuthIdentity): number {
  if (isSameIdentity(currentIdentity, identity)) return generation;

  generation += 1;
  currentIdentity =
    identity.state === 'authenticated'
      ? { state: 'authenticated', userId: identity.userId }
      : { state: identity.state };
  invalidateRegistrations();
  return generation;
}

/**
 * Captures the current scope. Returns null unless the active identity is
 * authenticated and the local owner marker exactly matches that user.
 */
export function captureAuthScope(): AuthScope | null {
  if (currentIdentity.state !== 'authenticated') return null;
  const userId = currentIdentity.userId;
  if (readOwnerMarker() !== userId) return null;
  return { userId, generation };
}

/**
 * True only when the token still owns the active account generation and
 * the local cache marker still names that same user.
 */
export function isAuthScopeCurrent(scope: AuthScope | null): boolean {
  if (!scope) return false;
  if (scope.generation !== generation) return false;
  if (currentIdentity.state !== 'authenticated') return false;
  if (currentIdentity.userId !== scope.userId) return false;
  return readOwnerMarker() === scope.userId;
}

/**
 * Registers account-scoped work for the generation captured in `scope`.
 *
 * A stale token aborts the transaction immediately. Otherwise the
 * transaction is aborted when a newer identity is published. Callers must
 * invoke the returned release function when the work completes or fails,
 * so settled work is not retained or aborted later.
 */
export function registerAuthTransaction(
  scope: AuthScope | null,
  transaction: AuthTransaction,
): ReleaseAuthTransaction {
  if (!scope || !isAuthScopeCurrent(scope)) {
    abortTransaction(transaction);
    return () => {};
  }

  const registration: Registration = { scope, transaction };
  const signal = transaction.signal;

  if (signal) {
    if (signal.aborted) {
      abortTransaction(transaction);
      return () => {};
    }
    const onAbort = () => {
      registrations.delete(registration);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    registration.detachAbortListener = () =>
      signal.removeEventListener('abort', onAbort);
  }

  registrations.add(registration);

  return () => {
    registrations.delete(registration);
    registration.detachAbortListener?.();
  };
}
