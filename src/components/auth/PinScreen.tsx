// ============================================================
// PinScreen — Full-screen PIN entry for the local app lock
//
// Shown by AuthGuard when authenticated but locked. Two modes:
//   1. Setup: create + confirm a new PIN
//   2. Unlock: verify the stored PIN
// ============================================================

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';

const PIN_LENGTH = 6;

export function PinScreen() {
  const { unlock, setPin, hasLock, signOut } = useAuth();
  const [mode, setMode] = useState<'unlock' | 'setup' | 'setup-confirm'>(
    hasLock ? 'unlock' : 'setup',
  );
  const [pin, setPin_] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  // Current value depends on mode
  const currentPin = mode === 'setup-confirm' ? confirmPin : pin;
  const setCurrentPin = mode === 'setup-confirm' ? setConfirmPin : setPin_;

  // ── Handle PIN completion ──
  const handlePinComplete = useCallback(
    async (value: string) => {
      if (isProcessing) return;
      setIsProcessing(true);
      setError('');

      if (mode === 'setup') {
        // First entry → move to confirmation
        setMode('setup-confirm');
        setIsProcessing(false);
        return;
      }

      if (mode === 'setup-confirm') {
        // Confirm the PIN
        if (value !== pin) {
          setError('PINs did not match. Try again.');
          setPin_('');
          setConfirmPin('');
          setMode('setup');
          setIsProcessing(false);
          return;
        }
        await setPin(value);
        setIsProcessing(false);
        return;
        // AuthGuard will re-render and hide PinScreen once isLocked flips
      }

      // unlock mode
      const ok = await unlock(value);
      if (!ok) {
        setError('Incorrect PIN. Try again.');
        setCurrentPin('');
      }
      setIsProcessing(false);
    },
    [mode, pin, unlock, setPin, isProcessing, setCurrentPin],
  );
  const handlePinCompleteRef = useRef(handlePinComplete);
  useEffect(() => {
    handlePinCompleteRef.current = handlePinComplete;
  });

  // ── Trigger PIN completion without side effects in state updaters ──
  const completionRef = useRef(false);
  useEffect(() => {
    if (currentPin.length < PIN_LENGTH) {
      completionRef.current = false;
    } else if (
      currentPin.length === PIN_LENGTH &&
      !isProcessing &&
      !completionRef.current
    ) {
      completionRef.current = true;
      handlePinCompleteRef.current(currentPin);
    }
  }, [currentPin, isProcessing]);

  // ── Keyboard support ──
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (isProcessing) return;
      if (e.key >= '0' && e.key <= '9') {
        setCurrentPin((v) => {
          if (v.length >= PIN_LENGTH) return v;
          return v + e.key;
        });
      } else if (e.key === 'Backspace') {
        setCurrentPin((v) => v.slice(0, -1));
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [setCurrentPin, isProcessing]);

  const handleKeypadPress = (digit: string) => {
    if (isProcessing) return;
    setCurrentPin((v) => {
      if (v.length >= PIN_LENGTH) return v;
      return v + digit;
    });
  };

  const handleBackspace = () => {
    setCurrentPin((v) => v.slice(0, -1));
  };

  // ── Labels vary by mode ──
  const title =
    mode === 'setup'
      ? 'Set a PIN'
      : mode === 'setup-confirm'
        ? 'Confirm your PIN'
        : 'Enter your PIN';

  const subtitle =
    mode === 'setup'
      ? 'Choose a 6-digit PIN to lock the app'
      : mode === 'setup-confirm'
        ? 'Re-enter your PIN to confirm'
        : error
          ? ''
          : 'Unlock to continue';

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 p-4 dark:bg-zinc-950">
      <div className="w-full max-w-xs text-center">
        {/* Lock icon */}
        <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-full bg-zinc-200 dark:bg-zinc-800">
          <svg
            className="h-7 w-7 text-zinc-600 dark:text-zinc-400"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
            />
          </svg>
        </div>

        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {subtitle}
          </p>
        )}

        {/* PIN dots */}
        <div className="mt-6 flex justify-center gap-3">
          {Array.from({ length: PIN_LENGTH }).map((_, i) => (
            <div
              key={i}
              className={`h-3.5 w-3.5 rounded-full transition-colors ${
                i < currentPin.length
                  ? 'bg-blue-600 dark:bg-blue-500'
                  : 'bg-zinc-300 dark:bg-zinc-600'
              }`}
            />
          ))}
        </div>

        {/* Error message */}
        {error && (
          <p
            role="alert"
            className="mt-3 text-sm text-red-600 dark:text-red-400"
          >
            {error}
          </p>
        )}

        {/* Numeric keypad */}
        <div className="mx-auto mt-8 grid w-64 grid-cols-3 gap-3">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => handleKeypadPress(d)}
              disabled={isProcessing}
              className="flex h-14 items-center justify-center rounded-xl bg-white text-xl font-medium text-zinc-900 transition-colors hover:bg-zinc-100 active:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700 dark:active:bg-zinc-600"
            >
              {d}
            </button>
          ))}
          <div />
          <button
            type="button"
            onClick={() => handleKeypadPress('0')}
            disabled={isProcessing}
            className="flex h-14 items-center justify-center rounded-xl bg-white text-xl font-medium text-zinc-900 transition-colors hover:bg-zinc-100 active:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700 dark:active:bg-zinc-600"
          >
            0
          </button>
          <button
            type="button"
            onClick={handleBackspace}
            disabled={isProcessing || currentPin.length === 0}
            className="flex h-14 items-center justify-center rounded-xl text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-30 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            aria-label="Backspace"
          >
            <svg
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9.75L14.25 12m0 0l2.25 2.25M14.25 12l2.25-2.25M14.25 12L12 14.25m-2.58 4.92l-6.374-6.375a1.125 1.125 0 0 1 0-1.59L9.42 4.83c.21-.211.501-.32.804-.32H19.5a2.25 2.25 0 0 1 2.25 2.25v10.5a2.25 2.25 0 0 1-2.25 2.25h-9.284c-.303 0-.594-.109-.804-.32Z"
              />
            </svg>
          </button>
        </div>

        {/* Sign-out escape hatch */}
        <button
          type="button"
          onClick={() => signOut()}
          className="mt-8 text-sm text-zinc-500 transition-colors hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Sign out instead
        </button>
      </div>
    </div>
  );
}
