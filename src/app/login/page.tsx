// ============================================================
// Login page — Supabase magic link sign-in form
//
// No nav/header, centered card, full viewport height.
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
  const { state, signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0);

  // Redirect if already authenticated
  useEffect(() => {
    if (state === 'authenticated') router.push('/');
  }, [state, router]);

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
          Enter your email to receive a magic link.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            type="email"
            label="Email address"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={status === 'sending'}
            autoComplete="email"
            autoFocus
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
                onClick={handleSubmit}
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
              {status === 'sending' ? 'Sending...' : 'Send magic link'}
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
