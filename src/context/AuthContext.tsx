// ============================================================
// AuthContext — Supabase magic-link authentication state
//
// Tracks session, provides signIn/signOut. When Supabase env
// vars are missing, state is 'disabled' and auth is skipped.
// ============================================================

'use client';

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';
import { usePathname, redirect } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import type { User } from '@supabase/supabase-js';

// ============================================================
// Types
// ============================================================

interface AuthContextValue {
  state: 'disabled' | 'loading' | 'authenticated' | 'unauthenticated';
  user: User | null;
  signIn: (email: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
}

// ============================================================
// Context
// ============================================================

const AuthContext = createContext<AuthContextValue>({
  state: 'loading',
  user: null,
  signIn: async () => ({ error: 'Auth not initialized' }),
  signOut: async () => {},
});

// ============================================================
// Provider
// ============================================================

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<
    'disabled' | 'loading' | 'authenticated' | 'unauthenticated'
  >(() => (supabase ? 'loading' : 'disabled'));
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    if (!supabase) return;

    supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        setUser(session?.user ?? null);
        setState(session?.user ? 'authenticated' : 'unauthenticated');
      })
      .catch(() => {
        // ponytail: offline or error → unauthenticated; login page shows message
        setState('unauthenticated');
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setState(session?.user ? 'authenticated' : 'unauthenticated');
    });

    return () => subscription.unsubscribe();
  }, []);

  const signIn = useCallback(
    async (email: string): Promise<{ error?: string }> => {
      if (!supabase) return { error: 'Supabase not configured' };

      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false },
      });

      if (error) return { error: error.message };
      return {};
    },
    [],
  );

  const signOut = useCallback(async () => {
    await supabase?.auth.signOut();
  }, []);

  return (
    <AuthContext.Provider value={{ state, user, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

// ============================================================
// Route guard — renders inside the root layout
// ============================================================

export function AuthGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { state } = useContext(AuthContext);

  if (state === 'disabled') return <>{children}</>;
  if (state === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-zinc-300 border-t-blue-600" />
      </div>
    );
  }
  if (state === 'unauthenticated' && pathname !== '/login')
    redirect('/login');
  if (state === 'authenticated' && pathname === '/login') redirect('/');
  return <>{children}</>;
}

// ============================================================
// Hook
// ============================================================

export function useAuth() {
  return useContext(AuthContext);
}
