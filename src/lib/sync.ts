// ============================================================
// sync.ts — Local-First Background Sync
//
// Outbox pattern:
//   Every local CRUD enqueues a sync entry in IndexedDB.
//   processSyncQueue() pushes local changes to Supabase.
//   pullFromSupabase() fetches remote changes and merges into IDB.
//
// Soft-delete strategy:
//   "Delete" operations set deleted_at on Supabase (never hard-delete).
//   During pull, records with deleted_at set are purged from local IDB.
//
// LWW conflict resolution:
//   Push: Supabase's BEFORE UPDATE trigger (prevent_older_update)
//         silently rejects updates where incoming updated_at ≤ existing.
//   Pull: Per-record updated_at comparison — newer wins.
// ============================================================

'use client';

import { supabase } from './supabase';
import { getDB } from './idb';
import { STORES } from './constants';
// SyncQueueEntry and SyncOperation types live in idb.ts (data layer)

// ============================================================
// Transform helpers: camelCase ↔ snake_case
// ============================================================

/** Fields that need renaming between IDB (camelCase) and Supabase (snake_case). */
const FIELD_MAP: Record<string, string> = {
  fromAccount: 'from_account',
  toAccount: 'to_account',
  startingBalance: 'starting_balance',
  totalAmount: 'total_amount',
  splitMode: 'split_mode',
  savingsSubSplit: 'savings_sub_split',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  deletedAt: 'deleted_at',
  // stored as camelCase in IDB already — no rename needed for these but map for completeness:
  created_at: 'created_at',
  updated_at: 'updated_at',
  deleted_at: 'deleted_at',
};

/** Reverse map: snake_case → camelCase */
const REVERSE_FIELD_MAP: Record<string, string> = {};
for (const [camel, snake] of Object.entries(FIELD_MAP)) {
  REVERSE_FIELD_MAP[snake] = camel;
}

function camelToSnake(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const mapped = FIELD_MAP[key];
    result[mapped ?? key] = value;
  }
  return result;
}

function snakeToCamel(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const mapped = REVERSE_FIELD_MAP[key];
    const camelKey = mapped ?? key;
    // Convert TIMESTAMPTZ strings to ms numbers for IDB compatibility
    if (
      (camelKey === 'createdAt' || camelKey === 'updatedAt' || camelKey === 'deletedAt') &&
      typeof value === 'string'
    ) {
      result[camelKey] = new Date(value).getTime();
    } else {
      result[camelKey] = value;
    }
  }
  return result as Record<string, unknown>;
}

// ============================================================
// Core sync operations
// ============================================================

/**
 * Process the local sync queue — push pending changes to Supabase.
 * Skips if offline or Supabase is not configured.
 *
 * enqueueSyncEntry() is in idb.ts (called after each local CRUD).
 */
export async function processSyncQueue(): Promise<void> {
  if (!navigator.onLine || !supabase) return;

  const db = await getDB();
  const tx = db.transaction(STORES.SYNC_QUEUE, 'readwrite');
  const store = tx.objectStore(STORES.SYNC_QUEUE);
  const index = store.index('byTimestamp');
  const allEntries = await index.getAll();

  for (const entry of allEntries) {
    try {
      const tableName = storeNameToTable(entry.storeName);

      switch (entry.operation) {
        case 'create':
        case 'update': {
          // Cast dates from ms-number to ISO string for Postgres
          const remotePayload = preparePayloadForRemote(entry.payload);
          await supabase.from(tableName).upsert(remotePayload, {
            onConflict: 'id',
            ignoreDuplicates: false,
          });
          break;
        }
        case 'delete': {
          // Soft-delete: set deleted_at + updated_at instead of hard DELETE
          const now = new Date().toISOString();
          await supabase
            .from(tableName)
            .update({ deleted_at: now, updated_at: now })
            .eq('id', entry.recordId);
          break;
        }
      }

      // Success — remove from queue
      await store.delete(entry.id);
    } catch (err) {
      console.warn('[Sync] Failed to sync entry, retrying later:', entry.id, err);
      entry.retryCount++;
      if (entry.retryCount >= 5) {
        console.warn('[Sync] Dropping queue entry after 5 retries:', entry.id);
        await store.delete(entry.id);
      } else {
        await store.put(entry);
      }
    }
  }

  await tx.done;
}

/**
 * Pull all remote records for a store and merge into local IDB.
 *
 * Merge logic (per-record):
 *   - Remote deleted_at set → remove from local IDB (ghost-record prevention)
 *   - Remote updated_at > local updatedAt → take remote (LWW)
 *   - Otherwise → keep local
 *   - Records only in remote (new) → add locally
 *   - Records only in local → keep locally (not yet synced)
 */
export async function pullStore(storeName: string): Promise<void> {
  if (!supabase) return;

  const tableName = storeNameToTable(storeName);
  const { data: remoteRecords, error } = await supabase.from(tableName).select('*');

  if (error) {
    console.error(`[Sync] Failed to pull ${storeName}:`, error);
    return;
  }

  if (!remoteRecords || remoteRecords.length === 0) return;

  const db = await getDB();
  const tx = db.transaction(storeName, 'readwrite');
  const localStore = tx.objectStore(storeName);
  const localRecords = await localStore.getAll();

  const remoteMap = new Map<string, Record<string, unknown>>();
  for (const r of remoteRecords) {
    remoteMap.set(r.id as string, r);
  }

  const toWrite: Record<string, unknown>[] = [];
  const toDeleteIds: string[] = [];

  for (const local of localRecords) {
    const remote = remoteMap.get(local.id as string);
    if (!remote) {
      // Local-only — may not yet be synced. Keep it.
      toWrite.push(local as unknown as Record<string, unknown>);
    } else if (remote.deleted_at) {
      // Remote soft-deleted → purge locally
      toDeleteIds.push(local.id as string);
    } else {
      const localUpdated = (local as Record<string, unknown>).updatedAt as number;
      const remoteUpdated = new Date(remote.updated_at as string).getTime();
      if (remoteUpdated > localUpdated) {
        toWrite.push(snakeToCamel(remote));
      } else {
        // Local is same or newer — keep
        toWrite.push(local as unknown as Record<string, unknown>);
      }
    }
    remoteMap.delete(local.id as string);
  }

  // Remaining in remoteMap are new remote-only records (skip deleted)
  for (const [id, remote] of remoteMap.entries()) {
    if (!remote.deleted_at) {
      toWrite.push(snakeToCamel(remote));
    }
  }

  // Apply: delete purged, write merged
  for (const id of toDeleteIds) {
    await localStore.delete(id);
  }
  for (const record of toWrite) {
    await localStore.put(record);
  }

  await tx.done;
}

// ============================================================
// Orchestration
// ============================================================

/**
 * Run a full sync cycle: push local changes, then pull fresh data.
 * Called on app mount (background) and when transitioning online→offline.
 */
export async function backgroundSync(): Promise<void> {
  if (!supabase) return; // not configured

  try {
    // 1. Push local changes
    await processSyncQueue();

    // 2. Pull fresh data for all stores
    const allStores = [
      STORES.TRANSACTIONS,
      STORES.ACCOUNTS,
      STORES.CATEGORIES,
      STORES.CASH_DENOMINATIONS,
      STORES.PAYOUTS,
      STORES.BUDGET_TARGETS,
    ];

    // Sequential to avoid concurrent IDB transactions
    for (const store of allStores) {
      await pullStore(store);
    }
  } catch (err) {
    console.error('[Sync] background sync failed:', err);
    // ponytail: silent failure. User's UI is intact from IDB cache.
    // Add a toast if offline-notification is desired.
  }
}

// ============================================================
// Helpers
// ============================================================

/**
 * Map internal store name (camelCase) to Supabase table name (snake_case).
 * Matches the table names defined in 001_schema.sql.
 */
function storeNameToTable(storeName: string): string {
  const map: Record<string, string> = {
    transactions: 'transactions',
    accounts: 'accounts',
    categories: 'categories',
    cashDenominations: 'cash_denominations',
    payouts: 'payouts',
    budgetTargets: 'budget_targets',
  };
  return map[storeName] ?? storeName;
}

/**
 * Convert a local payload (camelCase, ms timestamps) to
 * Supabase format (snake_case, ISO timestamps, no deleted_at).
 */
function preparePayloadForRemote(
  payload: Record<string, unknown> | null
): Record<string, unknown> {
  if (!payload) return {};

  const converted = camelToSnake(payload);

  // Convert ms timestamps to ISO strings for Postgres
  for (const key of ['created_at', 'updated_at']) {
    if (typeof converted[key] === 'number') {
      converted[key] = new Date(converted[key] as number).toISOString();
    }
  }

  // Strip deleted_at outbound — soft-delete is set via separate update
  delete converted.deleted_at;

  return converted;
}
