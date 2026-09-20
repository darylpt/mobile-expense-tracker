// ============================================================
// AuthGuard — Route guard + app lock gate
//
// Renders inside the root layout. Handles:
// 1. Auth-disabled passthrough
// 2. Loading spinner
// 3. App lock → PinScreen overlay
// 4. Unauthenticated → redirect to /login
// 5. Authenticated on /login → redirect to /
// ============================================================

'use client';

import { useContext, useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AuthContext } from '@/context/AuthContext';
import { PinScreen } from '@/components/auth/PinScreen';

export function AuthGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { state, isLocked } = useContext(AuthContext);

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
  return <>{children}</>;
}
