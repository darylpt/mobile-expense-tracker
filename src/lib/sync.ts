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
import { getDB, ensureUuids } from './idb';
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
  userId: 'user_id',
  sortOrder: 'sort_order',
  currentPrice: 'current_price',
  priceUpdatedAt: 'price_updated_at',
  stockId: 'stock_id',
  pricePerShare: 'price_per_share',
  sharesReceived: 'shares_received',
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

  // Clear previous failure count — we're retrying now
  try { localStorage.removeItem('sync_failed_count'); } catch { /* ignore */ }

  // Resolve current user — bail if no session
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const db = await getDB();

  // Read — single read-only transaction  (ponytail: getAllFromIndex preserves FIFO order from the index)
  const allEntries = await db.getAllFromIndex(STORES.SYNC_QUEUE, 'byTimestamp');
  if (allEntries.length === 0) return;

  // ── 2. Process — network calls OUTSIDE any IndexedDB transaction ──
  // Collect write operations to apply in a fresh transaction below.
  // IndexedDB transactions auto-commit when control returns to the event loop,
  // so we cannot hold one open across an await boundary.
  const drops: IDBValidKey[] = [];
  const retries: Array<typeof allEntries[number]> = [];

  for (const entry of allEntries) {
    try {
      const tableName = storeNameToTable(entry.storeName);

      switch (entry.operation) {
        case 'create':
        case 'update': {
          // Stamp user_id on outgoing payload before transform
          const payload = { ...(entry.payload as Record<string, unknown>), userId: user.id };
          // Cast dates from ms-number to ISO string for Postgres
          const remotePayload = preparePayloadForRemote(payload);
          const { error: upsertError } = await supabase.from(tableName).upsert(remotePayload, {
            onConflict: 'id',
            ignoreDuplicates: false,
          });
          if (upsertError) throw upsertError;
          break;
        }
        case 'delete': {
          // Soft-delete: set deleted_at + updated_at instead of hard DELETE
          const now = new Date().toISOString();
          const { error: deleteError } = await supabase
            .from(tableName)
            .update({ deleted_at: now, updated_at: now })
            .eq('id', entry.recordId);
          if (deleteError) throw deleteError;
          break;
        }
      }

      // Success — will drop from queue
      drops.push(entry.id);
    } catch (err) {
      console.warn('[Sync] Failed to sync entry, retrying later:', entry.id, err);
      entry.retryCount++;
      if (entry.retryCount >= 5) {
        console.warn('[Sync] Dropping queue entry after 5 retries:', entry.id);
        drops.push(entry.id);
        try {
          const prev = parseInt(localStorage.getItem('sync_failed_count') ?? '0', 10);
          localStorage.setItem('sync_failed_count', String(prev + 1));
        } catch { /* localStorage unavailable */ }
      } else {
        retries.push(entry);
      }
    }
  }

  // ── 3. Write — fresh readwrite transaction (no network calls) ──
  const tx = db.transaction(STORES.SYNC_QUEUE, 'readwrite');
  for (const id of drops) {
    await tx.store.delete(id);
  }
  for (const entry of retries) {
    await tx.store.put(entry);
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
export async function pullStore(storeName: string, userId: string): Promise<void> {
  if (!supabase) return;

  const tableName = storeNameToTable(storeName);
  const { data: remoteRecords, error } = await supabase
    .from(tableName)
    .select('*')
    .eq('user_id', userId);

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
  for (const [, remote] of remoteMap.entries()) {
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

// Module-level guard — prevents concurrent sync cycles from compounding
// retry storms (e.g. mount + online event + manual "Sync now" at the same time).
let syncInFlight = false;

/**
 * Run a full sync cycle: push local changes, then pull fresh data.
 * Called on app mount (background) and when transitioning online→offline.
 */
export async function backgroundSync(): Promise<void> {
  if (!supabase || syncInFlight) return; // not configured or already running
  syncInFlight = true;

  // Resolve current user — bail if no session
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { syncInFlight = false; return; }

  try {
    // 0. Migrate any legacy slug IDs to proper UUIDs before syncing
    await ensureUuids();

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
      STORES.STOCKS,
      STORES.STOCK_TRANSACTIONS,
      STORES.DIVIDENDS,
    ];

    // Sequential to avoid concurrent IDB transactions
    for (const store of allStores) {
      await pullStore(store, user.id);
    }

    // Record successful sync time for UI display
    localStorage.setItem('last_sync_time', Date.now().toString());
  } catch (err) {
    console.error('[Sync] background sync failed:', err);
    // ponytail: silent failure. User's UI is intact from IDB cache.
    // Add a toast if offline-notification is desired.
  } finally {
    syncInFlight = false;
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
    stocks: 'stocks',
    stockTransactions: 'stock_transactions',
    dividends: 'dividends',
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

/** Number of sync entries that were dropped after max retries. */
export function getFailedSyncCount(): number {
  try {
    return parseInt(localStorage.getItem('sync_failed_count') ?? '0', 10);
  } catch {
    return 0;
  }
}

/** Clear the failed sync counter (call after retry). */
export function clearFailedSyncCount(): void {
  try {
    localStorage.removeItem('sync_failed_count');
  } catch { /* ignore */ }
}
