'use client';

import { useEffect } from 'react';
import { saveAutoBackup } from '@/lib/idb';
import { useTransactionContext } from '@/context/TransactionContext';

/**
 * Triggers an auto-backup once the local data scope is verified.
 * Renders nothing — purely a side-effect component.
 */
export function AutoBackup() {
  const { isScopeVerified } = useTransactionContext();

  useEffect(() => {
    if (isScopeVerified) saveAutoBackup();
  }, [isScopeVerified]);

  return null;
}
