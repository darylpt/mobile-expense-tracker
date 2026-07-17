'use client';

import { useEffect } from 'react';
import { saveAutoBackup } from '@/lib/idb';

/**
 * Triggers an auto-backup once on mount.
 * Renders nothing — purely a side-effect component.
 */
export function AutoBackup() {
  useEffect(() => {
    saveAutoBackup();
  }, []);

  return null;
}
