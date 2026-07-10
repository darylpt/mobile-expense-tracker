'use client';

import React from 'react';
import { GlobalErrorBanner } from './GlobalErrorBanner';

/**
 * Thin client wrapper that adds the global error banner above children.
 * Used by the server-component layout to avoid importing client hooks directly.
 */
export function LayoutWithError({ children }: { children: React.ReactNode }) {
  return (
    <>
      <GlobalErrorBanner />
      {children}
    </>
  );
}
