// ============================================================
// AuthContext — Supabase authentication + local app lock state
//
// Tracks session, provides signIn (email + OAuth) / signOut.
// Provides local PIN-based app lock (privacy screen).
// When Supabase env vars are missing, state is 'disabled' and
// auth is skipped.
// ============================================================

'use client';

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { supabase } from '@/lib/supabase';
import { LAST_USER_STORAGE_KEY } from '@/lib/constants';
import { FILTERS_STORAGE_KEY } from '@/lib/transaction-filters';
import {
  publishAuthIdentity,
  getAuthGeneration,
  type AuthIdentity,
} from '@/lib/auth-scope';
import type { User } from '@supabase/supabase-js';

// ============================================================
// Types
// ============================================================

interface AuthContextValue {
  state: 'disabled' | 'loading' | 'authenticated' | 'unauthenticated';
  user: User | null;
  /** Monotonic auth identity generation shared with `@/lib/auth-scope`. */
  authGeneration: number;
  signIn: (email: string) => Promise<{ error?: string }>;
  signInWithOAuth: () => Promise<{ error?: string }>;
  signOut: () => Promise<void>;

  // ── Local app lock (privacy PIN) ──
  /** Authenticated + lock enabled + PIN not yet entered this session */
  isLocked: boolean;
  /** Whether a PIN has been set (lock may or may not be engaged) */
  hasLock: boolean;
  /** Enter the PIN; returns true on success */
  unlock: (pin: string) => Promise<boolean>;
  /** Save a new PIN hash (used during setup or change) */
  setPin: (pin: string) => Promise<void>;
  /** Remove the stored PIN hash and disable the lock */
  clearPin: () => void;
  /** Verify a candidate PIN against the stored hash */
  verifyPin: (pin: string) => Promise<boolean>;
}

// ============================================================
// Context
// ============================================================

export const AuthContext = createContext<AuthContextValue>({
  state: 'loading',
  user: null,
  authGeneration: 0,
  signIn: async () => ({ error: 'Auth not initialized' }),
  signInWithOAuth: async () => ({ error: 'Auth not initialized' }),
  signOut: async () => {},
  isLocked: false,
  hasLock: false,
  unlock: async () => false,
  setPin: async () => {},
  clearPin: () => {},
  verifyPin: async () => false,
});

// ============================================================
// Local app lock helpers (PBKDF2 via Web Crypto)
// ============================================================

const LOCK_HASH_KEY = 'app-lock-hash';
const LOCK_SALT_KEY = 'app-lock-salt';
const LOCK_ENABLED_KEY = 'app-lock-enabled';

async function hashPin(pin: string, salt: Uint8Array): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: 100_000, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  // Constant-time-safe base64 encoding
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

async function verifyPinHash(
  pin: string,
  storedHash: string,
  salt: Uint8Array,
): Promise<boolean> {
  const computed = await hashPin(pin, salt);
  // Constant-time comparison (safe for browser; no early return)
  if (computed.length !== storedHash.length) return false;
  let result = 0;
  for (let i = 0; i < computed.length; i++) {
    result |= computed.charCodeAt(i) ^ storedHash.charCodeAt(i);
  }
  return result === 0;
}

// ── Local lock-state check (reads localStorage; independent of auth) ──
function checkLockState(): boolean {
  if (typeof window === 'undefined') return false;
  const enabled = localStorage.getItem(LOCK_ENABLED_KEY) === 'true';
  const hash = localStorage.getItem(LOCK_HASH_KEY);
  return enabled && !!hash;
}

// ============================================================
// Provider
// ============================================================

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<
    'disabled' | 'loading' | 'authenticated' | 'unauthenticated'
  >(() => (supabase ? 'loading' : 'disabled'));
  const [user, setUser] = useState<User | null>(null);
  const [authGeneration, setAuthGeneration] = useState(0);

  // ── App lock state ──
  // Initialize lock immediately for disabled (offline) case; authenticated
  // case is resolved atomically with auth state in the merged useEffect.
  const [isLocked, setIsLocked] = useState(() => {
    if (!supabase) return checkLockState();
    return false;
  });

  const hasLock =
    typeof window !== 'undefined' &&
    localStorage.getItem(LOCK_ENABLED_KEY) === 'true' &&
    !!localStorage.getItem(LOCK_HASH_KEY);

  // ── Auth session management (merged with lock state) ──
  // Lock state is resolved at the same time as auth state to prevent
  // the fail-open flash where protected content renders before isLocked
  // is set on the next effect tick. User identity changes also force
  // re-engagement so a different user cannot inherit an unlocked state.
  const prevUserIdRef = useRef<string | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    let authEventSeen = false;

    const publish = (identity: AuthIdentity) => {
      const nextGeneration = publishAuthIdentity(identity);
      setAuthGeneration(nextGeneration);
      return nextGeneration;
    };

    // Publish the initial lifecycle state before any async auth work.
    publish(supabase ? { state: 'loading' } : { state: 'disabled' });

    if (!supabase) {
      return () => {
        mountedRef.current = false;
      };
    }

    const applyAuth = (nextUser: User | null) => {
      if (cancelled) return;

      // Publish the shared scope before React state so a consumer can never
      // observe a new identity alongside an older generation token.
      publish(
        nextUser
          ? { state: 'authenticated', userId: nextUser.id }
          : { state: 'unauthenticated' },
      );

      try {
        const previousUser =
          prevUserIdRef.current ??
          localStorage.getItem(LAST_USER_STORAGE_KEY);
        if (!nextUser || (previousUser && previousUser !== nextUser.id)) {
          localStorage.removeItem(FILTERS_STORAGE_KEY);
        }
      } catch {}
      setUser(nextUser);
      if (nextUser) {
        const identityChanged =
          prevUserIdRef.current !== null &&
          prevUserIdRef.current !== nextUser.id;
        prevUserIdRef.current = nextUser.id;

        if (identityChanged) {
          // Different user signed in — force lock re-engagement
          setIsLocked(true);
        } else {
          // Same user (or first load) — use stored lock state
          setIsLocked(checkLockState());
        }
        setState('authenticated');
      } else {
        prevUserIdRef.current = null;
        setIsLocked(false);
        setState('unauthenticated');
      }
    };

    // Subscribe before reading the initial session: any auth event is newer
    // than a bootstrap snapshot that is already in flight.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;
      authEventSeen = true;
      applyAuth(session?.user ?? null);
    });

    supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        // A newer event (including a sign-out) or an unmounted provider
        // makes this bootstrap response stale.
        if (cancelled || authEventSeen) return;
        applyAuth(session?.user ?? null);
      })
      .catch(() => {
        // Offline or error → unauthenticated, unless a newer event won.
        if (cancelled || authEventSeen) return;
        applyAuth(null);
      });

    return () => {
      mountedRef.current = false;
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  // ── Sign in with email (magic link, invite-only) ──
  const signIn = useCallback(
    async (email: string): Promise<{ error?: string }> => {
      if (!supabase) return { error: 'Supabase not configured' };

      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false,
          emailRedirectTo:
            typeof window !== 'undefined'
              ? window.location.origin
              : undefined,
        },
      });

      if (error) return { error: error.message };
      return {};
    },
    [],
  );

  // ── Sign in with Google (OAuth) ──
  const signInWithOAuth =
    useCallback(async (): Promise<{ error?: string }> => {
      if (!supabase) return { error: 'Supabase not configured' };

      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo:
            typeof window !== 'undefined'
              ? `${window.location.origin}/login`
              : undefined,
        },
      });

      if (error) return { error: error.message };
      return {};
    }, []);

  // ── Sign out ──
  const signOut = useCallback(async () => {
    // No Supabase: there is no remote identity to revoke. Keep offline mode
    // in its disabled lifecycle and only release the local lock.
    if (!supabase) {
      setIsLocked(false);
      return;
    }

    // Revoke synchronously, before awaiting Supabase. This aborts any
    // in-flight account-scoped work and hides the previous account view for
    // the whole sign-out attempt.
    const previousUserId = prevUserIdRef.current;
    const revokedGeneration = publishAuthIdentity({
      state: 'unauthenticated',
    });
    setAuthGeneration(revokedGeneration);
    prevUserIdRef.current = null;
    setUser(null);
    setIsLocked(false);
    setState('unauthenticated');

    try {
      localStorage.removeItem(FILTERS_STORAGE_KEY);
    } catch {}

    let signOutError: unknown = null;
    try {
      const result = await supabase.auth.signOut();
      signOutError = result?.error ?? null;
    } catch (error) {
      signOutError = error ?? new Error('Sign out failed');
    }
    if (!signOutError) return;

    // A newer auth transition happened while sign-out was failing, or the
    // provider unmounted: neither may be overwritten by this recovery.
    if (!mountedRef.current) return;
    if (getAuthGeneration() !== revokedGeneration) return;

    // Revalidate before restoring. The recovered identity gets a new
    // generation; the revoked token can never become current again.
    let restoredUser: User | null = null;
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) return;
      restoredUser = data?.session?.user ?? null;
    } catch {
      return;
    }
    if (!restoredUser) return;
    if (!mountedRef.current) return;
    if (getAuthGeneration() !== revokedGeneration) return;

    const restoredGeneration = publishAuthIdentity({
      state: 'authenticated',
      userId: restoredUser.id,
    });
    setAuthGeneration(restoredGeneration);
    prevUserIdRef.current = restoredUser.id;
    setUser(restoredUser);
    setIsLocked(
      previousUserId === restoredUser.id ? checkLockState() : true,
    );
    setState('authenticated');
  }, []);

  // ── App lock actions ──
  const unlock = useCallback(async (pin: string): Promise<boolean> => {
    const hash = localStorage.getItem(LOCK_HASH_KEY);
    const saltB64 = localStorage.getItem(LOCK_SALT_KEY);
    if (!hash || !saltB64) return false;

    const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
    const ok = await verifyPinHash(pin, hash, salt);
    if (ok) setIsLocked(false);
    return ok;
  }, []);

  const setPin = useCallback(async (pin: string) => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await hashPin(pin, salt);
    localStorage.setItem(LOCK_HASH_KEY, hash);
    localStorage.setItem(
      LOCK_SALT_KEY,
      btoa(String.fromCharCode(...salt)),
    );
    localStorage.setItem(LOCK_ENABLED_KEY, 'true');
  }, []);

  const clearPin = useCallback(() => {
    localStorage.removeItem(LOCK_HASH_KEY);
    localStorage.removeItem(LOCK_SALT_KEY);
    localStorage.removeItem(LOCK_ENABLED_KEY);
  }, []);

  const verifyPin = useCallback(
    async (pin: string): Promise<boolean> => {
      const hash = localStorage.getItem(LOCK_HASH_KEY);
      const saltB64 = localStorage.getItem(LOCK_SALT_KEY);
      if (!hash || !saltB64) return false;
      const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
      return verifyPinHash(pin, hash, salt);
    },
    [],
  );

  return (
    <AuthContext.Provider
      value={{
        state,
        user,
        authGeneration,
        signIn,
        signInWithOAuth,
        signOut,
        isLocked,
        hasLock,
        unlock,
        setPin,
        clearPin,
        verifyPin,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// ============================================================
// Hook
// ============================================================

export function useAuth() {
  return useContext(AuthContext);
}
