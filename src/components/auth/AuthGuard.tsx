// ============================================================
// AuthGuard — Route guard + app lock gate
//
// Renders inside the root layout. Handles:
// 1. Auth-disabled passthrough
// 2. Loading spinner
// 3. App lock → PinScreen overlay
// 4. Unauthenticated → redirect to /login, rendering no private content
// 5. Authenticated on a public login path → redirect to /
// ============================================================

'use client';

import { useContext, useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AuthContext } from '@/context/AuthContext';
import { PinScreen } from '@/components/auth/PinScreen';

// Trailing-slash builds report the login route as "/login/". Match only the
// exact spellings of the public route so prefix, descendant, case, and
// duplicate-slash variants stay protected.
function isPublicLoginRoute(pathname: string): boolean {
  return pathname === '/login' || pathname === '/login/';
}

export function AuthGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { state, isLocked } = useContext(AuthContext);
  const onPublicLoginRoute = isPublicLoginRoute(pathname);

  // Navigate on state change via useEffect, not inline redirect() which
  // throws mid-render and corrupts Next.js Router's hooks ordering.
  useEffect(() => {
    if (state === 'unauthenticated' && !onPublicLoginRoute) {
      router.replace('/login');
    } else if (state === 'authenticated' && onPublicLoginRoute && !isLocked) {
      router.replace('/');
    }
  }, [state, onPublicLoginRoute, router, isLocked]);

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
    return onPublicLoginRoute ? <>{children}</> : null;
  }
  return <>{children}</>;
}
