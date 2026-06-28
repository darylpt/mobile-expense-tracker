// ============================================================
// Input - Reusable text/number/date input component
// ============================================================

'use client';

import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  /** Leading icon or text (e.g., currency symbol) */
  leading?: React.ReactNode;
  /** Trailing icon or text */
  trailing?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, leading, trailing, className = '', id, ...rest }, ref) => {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, '-');

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label
            htmlFor={inputId}
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            {label}
          </label>
        )}
        <div className="relative">
          {leading && (
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-zinc-500">
              {leading}
            </div>
          )}
          <input
            ref={ref}
            id={inputId}
            className={`
              w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm
              text-zinc-900 transition-colors placeholder:text-zinc-400
              focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20
              disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-500
              dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100
              dark:placeholder:text-zinc-500 dark:focus:border-blue-400 dark:focus:ring-blue-400/20
              ${leading ? 'pl-8' : ''}
              ${trailing ? 'pr-8' : ''}
              ${error ? 'border-red-500 focus:border-red-500 focus:ring-red-500/20' : ''}
              ${className}
            `}
            {...rest}
          />
          {trailing && (
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-zinc-500">
              {trailing}
            </div>
          )}
        </div>
        {error && (
          <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';
