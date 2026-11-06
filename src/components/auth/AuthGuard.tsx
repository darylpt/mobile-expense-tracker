// ============================================================
// AuthGuard — Route guard + app lock gate
//
// Renders inside the root layout. Handles:
// 1. Auth-disabled passthrough
// 2. Loading spinner
// 3. App lock → PinScreen overlay
// 4. Unauthenticated → redirect to /login, rendering no private content
// 5. Authenticated on /login → redirect to /
// 6. Authenticated app subtree keyed by auth generation (remount on transition)
// ============================================================

'use client';

import { Fragment, useContext, useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AuthContext } from '@/context/AuthContext';
import { PinScreen } from '@/components/auth/PinScreen';

export function AuthGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { state, isLocked, authGeneration = 0 } = useContext(AuthContext);

  // Navigate on state change via useEffect, not inline redirect() which
  // throws mid-render and corrupts Next.js Router's hooks ordering.
  useEffect(() => {
    if (state === 'unauthenticated' && pathname !== '/login') {
      router.replace('/login');
    } else if (state === 'authenticated' && pathname === '/login' && !isLocked) {
      router.replace('/');
    }
  }, [state, pathname, router, isLocked]);

  if (state === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-zinc-300 border-t-blue-600" />
      </div>
    );
  }
  // Lock is a local privacy gate — enforce even when Supabase is disabled
  if (isLocked) return <PinScreen />;
  if (state === 'disabled') return <>{children}</>;
  if (state === 'unauthenticated') {
    // Fail closed while the redirect effect runs: only the public login route
    // may render. Private children must never flash for a signed-out identity.
    return pathname === '/login' ? <>{children}</> : null;
  }

  // A new identity generation (sign-out → sign-in, including the same user)
  // remounts the app subtree so previous-generation component state cannot
  // survive the transition.
  return <Fragment key={authGeneration}>{children}</Fragment>;
}
