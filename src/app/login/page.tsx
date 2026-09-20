// ============================================================
// Login page — Google OAuth + magic link sign-in
//
// No nav/header, centered card, full viewport height.
// Google is the primary action; email magic link is fallback.
// Handles: idle, sending, success (with resend cooldown), error.
// If auth is disabled (no Supabase env vars) shows a message.
// ============================================================

'use client';

import { useState, useEffect, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { useAuth } from '@/context/AuthContext';

export default function LoginPage() {
  const router = useRouter();
  const { state, signIn, signInWithOAuth } = useAuth();
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<
    'idle' | 'sending' | 'sent' | 'error'
  >('idle');
  // SSR-safe: initialize from URL so the effect only needs to clean the URL
  const [error, setError] = useState(() => {
    if (typeof window === 'undefined') return '';
    const params = new URLSearchParams(window.location.search);
    return params.get('error_description') || params.get('error') || '';
  });
  const [cooldown, setCooldown] = useState(0);
  const [oauthLoading, setOauthLoading] = useState(false);

  // Redirect if already authenticated
  useEffect(() => {
    if (state === 'authenticated') router.push('/');
  }, [state, router]);

  // Clean OAuth callback error params from the URL after initial render
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('error')) {
      window.history.replaceState({}, '', '/login');
    }
  }, []);

  // 30-second cooldown before resend is allowed
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;

    setStatus('sending');
    setError('');

    const result = await signIn(trimmed);

    if (result.error) {
      setError(result.error);
      setStatus('error');
    } else {
      setStatus('sent');
      setCooldown(30);
    }
  };

  const handleGoogleSignIn = async () => {
    setOauthLoading(true);
    setError('');

    const result = await signInWithOAuth();

    if (result.error) {
      setError(result.error);
      setOauthLoading(false);
    }
    // On success, Supabase redirects the browser — no further handling needed
  };

  // Loading or authenticated — show spinner (AuthGuard also handles this)
  if (state === 'loading' || state === 'authenticated') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-zinc-300 border-t-blue-600" />
      </div>
    );
  }

  // Supabase not configured — show message with link to dashboard
  if (state === 'disabled') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <div className="mx-4 max-w-sm rounded-xl border border-zinc-200 bg-white p-6 text-center shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-8">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            No authentication configured.
          </p>
          <Link
            href="/"
            className="mt-4 inline-block text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400"
          >
            Go to Dashboard &rarr;
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/50 sm:p-8">
        <h1 className="mb-1 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Sign in
        </h1>
        <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
          Returning users go straight to the dashboard.
        </p>

        {/* Google OAuth — primary action */}
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={handleGoogleSignIn}
          disabled={oauthLoading}
          isLoading={oauthLoading}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24">
            <path
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
              fill="#4285F4"
            />
            <path
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              fill="#34A853"
            />
            <path
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              fill="#FBBC05"
            />
            <path
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              fill="#EA4335"
            />
          </svg>
          Continue with Google
        </Button>

        {/* Divider */}
        <div className="my-6 flex items-center gap-3">
          <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-700" />
          <span className="text-xs text-zinc-400 dark:text-zinc-500">
            or
          </span>
          <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-700" />
        </div>

        {/* Magic link — fallback */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            type="email"
            label="Email address"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={status === 'sending'}
            autoComplete="email"
            aria-describedby={error ? 'login-error' : undefined}
          />

          {status === 'sent' ? (
            <div>
              <p
                role="status"
                aria-live="polite"
                className="mb-3 text-sm text-emerald-600 dark:text-emerald-400"
              >
                Check your email for the magic link.
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={cooldown > 0}
                onClick={() => handleSubmit()}
              >
                {cooldown > 0
                  ? `Send again (${cooldown}s)`
                  : 'Send again'}
              </Button>
            </div>
          ) : (
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              isLoading={status === 'sending'}
            >
              {status === 'sending'
                ? 'Sending...'
                : 'Send magic link'}
            </Button>
          )}
        </form>

        {error && (
          <p
            id="login-error"
            role="alert"
            className="mt-4 text-sm text-red-600 dark:text-red-400"
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
