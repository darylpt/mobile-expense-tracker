// ============================================================
// Dropdown - Reusable select/dropdown component
// ============================================================

'use client';

import React from 'react';

interface DropdownOption {
  value: string;
  label: string;
}

interface DropdownProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  label?: string;
  options: DropdownOption[];
  placeholder?: string;
  error?: string;
}

export function Dropdown({
  label,
  options,
  placeholder = 'Select...',
  error,
  className = '',
  id,
  ...rest
}: DropdownProps) {
  const selectId = id || label?.toLowerCase().replace(/\s+/g, '-');

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label
          htmlFor={selectId}
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          {label}
        </label>
      )}
      <select
        id={selectId}
        className={`
          w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm
          text-zinc-900 transition-colors
          focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20
          disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-500
          dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100
          dark:focus:border-blue-400 dark:focus:ring-blue-400/20
          ${error ? 'border-red-500 focus:border-red-500 focus:ring-red-500/20' : ''}
          ${className}
        `}
        {...rest}
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
