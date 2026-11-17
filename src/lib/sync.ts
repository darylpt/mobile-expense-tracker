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
import {
  getDB,
  ensureUuids,
  getDatasetReplacementMarker,
  prepareConflictReplacement,
  setActiveDatasetGeneration,
  adoptUnownedQueueEntries,
  getSyncBaseline,
  putSyncBaseline,
} from './idb';
import { STORES, LAST_USER_STORAGE_KEY } from './constants';
import { normalizeDividendRecord } from './dividends';
import {
  LOCAL_DATASET_OWNER,
  isManagedStore,
  MANAGED_STORES,
  type DatasetReplacementMarker,
} from './dataset-replacement';
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
  accountId: 'account_id',
  useSubSplit: 'use_sub_split',
  subSplits: 'sub_splits',
  exDate: 'ex_date',
  payDate: 'pay_date',
  dividendYield: 'dividend_yield',
  qty: 'qty',
  rate: 'rate',
  fee: 'fee',
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
 * A managed write was fenced because another device advanced the dataset
 * generation. The queue entry that hit this is kept; backgroundSync turns the
 * conflict into a durable conflict marker instead of retrying or dropping it.
 */
class ManagedWriteConflictError extends Error {
  readonly generation: number | null;

  constructor(generation: number | null, message = 'Cloud dataset generation changed during write.') {
    super(message);
    this.name = 'ManagedWriteConflictError';
    this.generation = generation;
  }
}

/**
 * The server row changed since the baseline this client recorded. Retrying
 * cannot fix it: the local mutation must be resolved against the new revision.
 */
class RemoteRevisionChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteRevisionChangedError';
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

function samePersistedValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const entries = Object.entries(left);
  return entries.length === Object.keys(right).length && entries.every(([key, value]) =>
    Object.hasOwn(right, key) && samePersistedValue(value, (right as Record<string, unknown>)[key]));
}

/**
 * Fields the server owns. They are never part of a business payload and never
 * part of the acknowledgement comparison: a pulled row carries them, and a
 * comparison that included them would report a false conflict.
 */
const SERVER_METADATA_FIELDS = ['revision', 'user_id', 'dataset_generation'] as const;

function withoutServerMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...payload };
  for (const field of SERVER_METADATA_FIELDS) delete copy[field];
  return copy;
}

/**
 * True when the persisted row carries every intended business value. A missing
 * expected field fails: "the server stored something else" must never read as
 * success.
 */
function persistedMatchesIntended(
  row: Record<string, unknown>,
  intended: Record<string, unknown>,
): boolean {
  return Object.entries(intended).every(([key, value]) => {
    if (value === undefined) return true;
    if (!Object.hasOwn(row, key)) return false;
    return samePersistedValue(row[key], value);
  });
}

/** The compare-and-set token a server row currently carries. */
function rowRevision(row: Record<string, unknown>): string | null {
  return ((row.updated_at as string | undefined) ??
    (row.created_at as string | undefined) ??
    null);
}

async function fetchRemoteRow(
  tableName: string,
  recordId: string,
  userId: string,
): Promise<Record<string, unknown> | undefined> {
  const { data, error } = await supabase!
    .from(tableName)
    .select('*')
    .eq('id', recordId)
    .eq('user_id', userId);
  if (error) throw error;
  return data?.[0];
}


/**
 * Stores served by the transactional revision RPC (migration 009). Everything
 * else keeps its existing path, including the managed generation fence.
 */
const REVISION_PROTOCOL_STORES: Record<string, true> = {
  [STORES.STOCKS]: true,
  [STORES.STOCK_TRANSACTIONS]: true,
  [STORES.DIVIDENDS]: true,
  [STORES.BALANCE_SNAPSHOTS]: true,
};

type RevisionProtocolState = 'unknown' | 'available' | 'absent';
let revisionProtocolState: RevisionProtocolState = 'unknown';

interface RevisionWriteResponse {
  status: 'applied' | 'replayed' | 'conflict';
  revision: number | null;
}

function readRevisionWriteResponse(value: unknown): RevisionWriteResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  const { status, revision } = value as { status?: unknown; revision?: unknown };
  if (status !== 'applied' && status !== 'replayed' && status !== 'conflict') return null;
  return {
    status,
    revision: typeof revision === 'number' && Number.isFinite(revision) ? revision : null,
  };
}

/**
 * Try the transactional revision write. Returns false when the server does not
 * have the RPC yet, so the caller keeps the proven legacy path. Any other error
 * propagates: a real failure must not silently fall back.
 */
/** Test seam: forget the capability-probe result. */
export function resetRevisionProtocolState(): void {
  revisionProtocolState = 'unknown';
}

async function tryRevisionWrite(
  entry: { id: string; storeName: string; recordId: string; operation: string },
  userId: string,
  expectedRevision: number,
  record: Record<string, unknown> | null,
): Promise<boolean> {
  if (revisionProtocolState === 'absent') return false;
  const { data, error } = await supabase!.rpc('apply_revision_write', {
    p_store: entry.storeName,
    p_operation: entry.operation,
    p_record_id: entry.recordId,
    p_expected_revision: expectedRevision,
    p_record: record,
    p_operation_id: entry.id,
  });
  if (error) {
    if (errorCode(error) === 'PGRST202') {
      revisionProtocolState = 'absent';
      return false;
    }
    throw error;
  }
  revisionProtocolState = 'available';
  const response = readRevisionWriteResponse(data);
  if (!response) throw new Error('Revision write returned an unexpected response.');
  if (response.status === 'conflict') {
    throw new RemoteRevisionChangedError(
      'Server revision conflict; the queued edit needs reconciliation.',
    );
  }
  await putSyncBaseline(entry.storeName, entry.recordId, userId, null, response.revision);
  return true;
}

function assertManagedWriteApplied(data: unknown, action: 'write' | 'delete'): void {
  const response = readManagedWriteResponse(data);
  if (response?.status === 'conflict') {
    throw new ManagedWriteConflictError(response.generation);
  }
  if (response?.status !== 'applied') {
    throw new Error(`Cloud dataset generation changed during ${action}.`);
  }
}

class StaleSyncCycleError extends Error {}

async function requireAppliedGeneration(userId: string, generation: number): Promise<void> {
  const current = await getDatasetReplacementMarker(userId);
  if (!current || current.status !== 'applied' || current.generation !== generation) {
    throw new StaleSyncCycleError('Local dataset changed during sync.');
  }
}

/**
 * Process the local sync queue — push pending changes to Supabase.
 * Skips if offline or Supabase is not configured.
 *
 * A managed entry stamped below the active generation is a post-snapshot edit
 * from a tab whose in-memory generation is stale. It raises a managed conflict
 * before any write or pull so the queue and local rows are preserved for
 * explicit resolution instead of being dropped as superseded.
 *
 * enqueueSyncEntry() is in idb.ts (called after each local CRUD).
 */
export async function processSyncQueue(generation: number): Promise<void> {
  if (!navigator.onLine || !supabase) return;

  // Clear previous failure count — we're retrying now
  try { localStorage.removeItem('sync_failed_count'); } catch { /* ignore */ }

  // Resolve current user — bail if no session
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  await requireAppliedGeneration(user.id, generation);
  const db = await getDB();

  // Read — single read-only transaction  (ponytail: getAllFromIndex preserves FIFO order from the index)
  let allEntries = await db.getAllFromIndex(STORES.SYNC_QUEUE, 'byTimestamp');
  if (allEntries.length === 0) return;

  // Work written before the cache had an owner can be claimed only when the
  // verified marker already names this account. Entries stamped for another
  // account are never reassigned.
  let cacheOwner: string | null = null;
  try {
    cacheOwner = localStorage.getItem(LAST_USER_STORAGE_KEY);
  } catch { /* unavailable */ }
  if (cacheOwner === user.id) {
    const adopted = await adoptUnownedQueueEntries(user.id);
    if (adopted > 0) {
      allEntries = await db.getAllFromIndex(STORES.SYNC_QUEUE, 'byTimestamp');
    }
  }

  // A replacement transaction clears managed entries atomically, so an
  // older-generation entry that still exists was enqueued afterwards by a tab
  // whose in-memory generation is stale. It is a post-snapshot edit, not a
  // superseded write, so preserve it and let explicit resolution decide.
  if (
    allEntries.some(
      (entry) =>
        isManagedStore(entry.storeName) && (entry.datasetGeneration ?? 0) !== generation
    )
  ) {
    throw new ManagedWriteConflictError(generation);
  }

  // ── 2. Process — network calls OUTSIDE any IndexedDB transaction ──
  // Collect write operations to apply in a fresh transaction below.
  // IndexedDB transactions auto-commit when control returns to the event loop,
  // so we cannot hold one open across an await boundary.
  const drops: IDBValidKey[] = [];
  const retries: Array<typeof allEntries[number]> = [];
  let conflict: ManagedWriteConflictError | null = null;
  let managedFailure: unknown = null;

  for (const entry of allEntries) {
    // Paused work waits for an explicit retry; revision conflicts wait for an
    // explicit resolution. Neither is attempted or dropped automatically.
    if (entry.state === 'paused') continue;
    if (entry.state === 'blocked' && entry.blockReason === 'revision') continue;

    // Ownership must be provable. Unstamped work is claimed only through the
    // marker-matched adoption above; anything still unowned or stamped for
    // another account is blocked in place, never replayed under this one.
    if (!entry.ownerId || entry.ownerId !== user.id) {
      if (entry.state !== 'blocked') {
        await db.put(STORES.SYNC_QUEUE, {
          ...entry,
          state: 'blocked',
          blockReason: 'ownership',
          lastError: entry.ownerId
            ? 'Queued work belongs to a different account'
            : 'Queued work has no proven owner',
        });
        try {
          const prev = parseInt(localStorage.getItem('sync_failed_count') ?? '0', 10);
          localStorage.setItem('sync_failed_count', String(prev + 1));
        } catch { /* localStorage unavailable */ }
      }
      continue;
    }

    try {
      const tableName = storeNameToTable(entry.storeName);
      const managed = isManagedStore(entry.storeName);
      await requireAppliedGeneration(user.id, generation);

      switch (entry.operation) {
        case 'create':
        case 'update': {
          // Stamp user_id and the dataset generation on outgoing payload before transform
          const payload: Record<string, unknown> = {
            ...(entry.payload as Record<string, unknown>),
            userId: user.id,
          };
          if (managed) {
            payload.dataset_generation = generation;
            if (entry.storeName !== STORES.CASH_DENOMINATIONS &&
              typeof payload.updatedAt !== 'number') payload.updatedAt = Date.now();
          }
          // Cast dates from ms-number to ISO string for Postgres
          const remotePayload = preparePayloadForRemote(payload);
          if (managed) {
            const { data, error } = await supabase.rpc('apply_managed_write', {
              p_generation: generation,
              p_store: tableName,
              p_operation: entry.operation,
              p_record_id: entry.recordId,
              p_record: remotePayload,
            });
            if (error) throw error;
            assertManagedWriteApplied(data, 'write');
            const { data: persisted, error: readError } = await supabase.from(tableName)
              .select('*').eq('user_id', user.id).eq('id', entry.recordId);
            if (readError) throw readError;
            const row = persisted?.find((record) => record.id === entry.recordId);
            if (!row || row.deleted_at ||
              (entry.storeName !== STORES.CASH_DENOMINATIONS &&
                new Date(row.updated_at).getTime() !== new Date(remotePayload.updated_at as string).getTime()) ||
              Object.entries(remotePayload).some(([key, value]) =>
                key !== 'created_at' && key !== 'updated_at' && value !== undefined &&
                Object.hasOwn(row, key) &&
                !samePersistedValue(row[key], value))) {
              throw new ManagedWriteConflictError(
                generation, 'Managed write was not persisted; local edit remains queued.'
              );
            }
          } else {
            // Non-managed stores have no server-side generation check. Where the
            // server offers the transactional revision RPC, use it; otherwise
            // prove the write locally: compare-and-set against the recorded
            // baseline, then compare the persisted row with what it intended.
            const intended = withoutServerMetadata(remotePayload);
            const baseline = await getSyncBaseline(entry.storeName, entry.recordId);

            if (REVISION_PROTOCOL_STORES[entry.storeName]) {
              const expected = entry.operation === 'create' ? 0 : baseline?.revision;
              if (typeof expected === 'number') {
                const handled = await tryRevisionWrite(entry, user.id, expected, remotePayload);
                if (handled) break;
              }
            }

            if (entry.operation === 'create') {
              const { error: insertError } = await supabase.from(tableName).insert(remotePayload);
              if (insertError && errorCode(insertError) !== '23505') throw insertError;
            } else if (!baseline?.baselineRevision) {
              // No trustworthy pre-edit base: an update must not become an
              // upsert that overwrites whatever is on the server now.
              const remote = await fetchRemoteRow(tableName, entry.recordId, user.id);
              if (!remote || remote.deleted_at) {
                throw new RemoteRevisionChangedError(
                  'Remote row is gone; the queued edit needs an explicit create or recovery decision.',
                );
              }
              if (!persistedMatchesIntended(remote, intended)) {
                throw new RemoteRevisionChangedError(
                  'No recorded baseline for this row; the queued edit needs reconciliation.',
                );
              }
              // Already exactly what the queued edit asks for.
              await putSyncBaseline(
                entry.storeName,
                entry.recordId,
                user.id,
                rowRevision(remote),
              );
              break;
            } else {
              const { data, error } = await supabase
                .from(tableName)
                .update(remotePayload)
                .eq('id', entry.recordId)
                .eq('user_id', user.id)
                .eq('updated_at', baseline.baselineRevision)
                .select('*');
              if (error) throw error;
              const applied = data?.[0];
              if (!applied) {
                const remote = await fetchRemoteRow(tableName, entry.recordId, user.id);
                if (remote && !remote.deleted_at && persistedMatchesIntended(remote, intended)) {
                  await putSyncBaseline(
                    entry.storeName,
                    entry.recordId,
                    user.id,
                    rowRevision(remote),
                  );
                  break;
                }
                throw new RemoteRevisionChangedError(
                  'Remote row changed since the recorded baseline; the queued edit needs reconciliation.',
                );
              }
              if (!persistedMatchesIntended(applied, intended)) {
                throw new RemoteRevisionChangedError(
                  'Server stored a different row than the queued edit; it needs reconciliation.',
                );
              }
              await putSyncBaseline(
                entry.storeName,
                entry.recordId,
                user.id,
                rowRevision(applied),
              );
              break;
            }

            // Create path: confirm the row exists and matches what was sent.
            const row = await fetchRemoteRow(tableName, entry.recordId, user.id);
            if (!row || row.deleted_at) {
              throw new Error('Server did not confirm the create; local change kept in the queue.');
            }
            if (!persistedMatchesIntended(row, intended)) {
              throw new RemoteRevisionChangedError(
                'A different row already uses this id; the queued create needs reconciliation.',
              );
            }
            await putSyncBaseline(
              entry.storeName,
              entry.recordId,
              user.id,
              rowRevision(row),
            );
          }
          break;
        }
        case 'delete': {
          if (managed) {
            const { data, error } = await supabase.rpc('apply_managed_write', {
              p_generation: generation,
              p_store: tableName,
              p_operation: 'delete',
              p_record_id: entry.recordId,
              p_record: null,
            });
            if (error) throw error;
            assertManagedWriteApplied(data, 'delete');
          } else {
            if (REVISION_PROTOCOL_STORES[entry.storeName]) {
              const baseline = await getSyncBaseline(entry.storeName, entry.recordId);
              if (typeof baseline?.revision === 'number') {
                const handled = await tryRevisionWrite(entry, user.id, baseline.revision, null);
                if (handled) break;
              }
            }
            // Soft-delete, pinned to the recorded baseline. Without one, the
            // delete must not guess which row it is deleting.
            const remote = await fetchRemoteRow(tableName, entry.recordId, user.id);
            if (!remote || remote.deleted_at) break; // already satisfied
            const baseline = await getSyncBaseline(entry.storeName, entry.recordId);
            if (!baseline?.baselineRevision) {
              throw new RemoteRevisionChangedError(
                'No recorded baseline for this delete; it needs reconciliation.',
              );
            }
            const now = new Date().toISOString();
            const { data, error } = await supabase
              .from(tableName)
              .update({ deleted_at: now, updated_at: now })
              .eq('id', entry.recordId)
              .eq('user_id', user.id)
              .eq('updated_at', baseline.baselineRevision)
              .select('*');
            if (error) throw error;
            if (!data || data.length === 0) {
              const after = await fetchRemoteRow(tableName, entry.recordId, user.id);
              if (after?.deleted_at) break; // another client already deleted it
              throw new RemoteRevisionChangedError(
                'Remote row changed before the delete; the queued delete needs reconciliation.',
              );
            }
          }
          break;
        }
      }

      // Success — will drop from queue
      drops.push(entry.id);
    } catch (err) {
      if (err instanceof StaleSyncCycleError) throw err;
      if (err instanceof RemoteRevisionChangedError) {
        // Not retryable: the local mutation needs reconciling with the row the
        // server now holds. Keep it, blocked, with its payload.
        retries.push({ ...entry, state: 'blocked', blockReason: 'revision', lastError: err.message });
        try {
          const prev = parseInt(localStorage.getItem('sync_failed_count') ?? '0', 10);
          localStorage.setItem('sync_failed_count', String(prev + 1));
        } catch { /* localStorage unavailable */ }
        continue;
      }
      if (err instanceof ManagedWriteConflictError) {
        conflict = err;
        break;
      }
      if (isManagedStore(entry.storeName)) {
        managedFailure = err;
        break;
      }
      console.warn('[Sync] Failed to sync entry, retrying later:', entry.id, err);
      entry.retryCount++;
      entry.lastError =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null && 'message' in err
            ? String((err as { message: unknown }).message)
            : String(err);
      if (entry.retryCount >= 5) {
        // Never delete work because it failed: pause it with its payload so the
        // user can retry or export it.
        console.warn('[Sync] Pausing queue entry after 5 failed attempts:', entry.id);
        retries.push({ ...entry, state: 'paused' });
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
  const tx = db.transaction([STORES.SYNC_QUEUE, STORES.DATASET_MARKERS], 'readwrite');
  const currentMarker = await tx.objectStore(STORES.DATASET_MARKERS).get(user.id);
  if (!currentMarker || currentMarker.status !== 'applied' || currentMarker.generation !== generation) {
    await tx.done;
    throw new StaleSyncCycleError('Local dataset changed during sync.');
  }
  const queue = tx.objectStore(STORES.SYNC_QUEUE);
  for (const id of drops) {
    await queue.delete(id);
  }
  for (const entry of retries) {
    // A dataset replacement may have deleted this entry while the network
    // call was in flight. Only re-put entries that still exist.
    const current = await queue.get(entry.id);
    if (current) await queue.put(entry);
  }
  await tx.done;

  if (conflict) throw conflict;
  if (managedFailure) throw managedFailure;
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
export async function pullStore(
  storeName: string,
  userId: string,
  generation: number
): Promise<void> {
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

  const managed = isManagedStore(storeName);
  const isStale = (record: Record<string, unknown>): boolean => {
    if (!managed) return false;
    const remoteGeneration = Number(record.dataset_generation ?? 0);
    return Number.isFinite(remoteGeneration) && remoteGeneration < generation;
  };

  const db = await getDB();
  const tx = db.transaction(
    managed
      ? [storeName, STORES.DATASET_MARKERS, STORES.SYNC_QUEUE, STORES.SYNC_DELETIONS, STORES.SYNC_META]
      : [storeName, STORES.SYNC_QUEUE, STORES.SYNC_DELETIONS, STORES.SYNC_META],
    'readwrite',
  );
  if (managed) {
    const current = await tx.objectStore(STORES.DATASET_MARKERS).get(userId);
    if (!current || current.status !== 'applied' || current.generation !== generation) {
      await tx.done;
      throw new StaleSyncCycleError('Local dataset changed during pull.');
    }
  }
  // Every store's pending work is preserved, managed or not: a queued row is
  // newer than whatever the pull would write over it.
  const pendingIds = new Set(
    (await tx.objectStore(STORES.SYNC_QUEUE).getAll())
      .filter((entry) => entry.storeName === storeName)
      .map((entry) => entry.recordId),
  );
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
    if (pendingIds.has(local.id as string) || !remote) {
      // Local-only — may not yet be synced. Keep it.
      toWrite.push(local as unknown as Record<string, unknown>);
    } else if (remote.deleted_at || isStale(remote)) {
      // Remote soft-deleted, or the row belongs to a superseded dataset generation.
      toDeleteIds.push(local.id as string);
    } else {
      const localUpdated = (local as Record<string, unknown>).updatedAt as number;
      const remoteUpdated = new Date(remote.updated_at as string).getTime();
      if (remoteUpdated > localUpdated) {
        toWrite.push(remoteToLocalRecord(storeName, remote));
      } else {
        // Local is same or newer — keep local
        toWrite.push(local as unknown as Record<string, unknown>);
      }
    }
    remoteMap.delete(local.id as string);
  }

  // Remaining in remoteMap are new remote-only records (skip deleted and stale)
  for (const [, remote] of remoteMap.entries()) {
    if (!pendingIds.has(remote.id as string) && !remote.deleted_at && !isStale(remote)) {
      toWrite.push(remoteToLocalRecord(storeName, remote));
    }
  }

  const cacheBelongsToUser = localStorage.getItem('lastUserId') === userId;
  if (!cacheBelongsToUser) {
    await tx.done;
    return;
  }

  // Apply: archive purged rows, delete them, write merged
  const deletionStore = tx.objectStore(STORES.SYNC_DELETIONS);
  const localById = new Map(localRecords.map((record) => [String(record.id), record]));
  for (const id of toDeleteIds) {
    const record = localById.get(id);
    const remote = remoteRecords.find((row) => row.id === id);
    if (record) {
      // The local copy is the only remaining evidence of this record. Keep a
      // recoverable snapshot rather than deleting it irreversibly.
      await deletionStore.put({
        id: `remote-delete:${storeName}:${id}:${Date.now()}`,
        storeName,
        recordId: id,
        payload: record,
        deletedAt: Date.now(),
        reason: remote?.deleted_at ? 'remote-tombstone' : 'stale-dataset-generation',
        remoteDeletedAt: (remote?.deleted_at as string) ?? null,
      });
    }
    await localStore.delete(id);
  }
  for (const record of toWrite) {
    await localStore.put(record);
  }

  // Baselines belong to the same transaction as the merge: a crash must not
  // leave rows updated with stale tokens. Rows with queued local work keep the
  // baseline they already had, so their CAS still fails if the cloud moved.
  if (cacheBelongsToUser) {
    const metaStore = tx.objectStore(STORES.SYNC_META);
    for (const remote of remoteRecords) {
      const id = String(remote.id ?? '');
      if (!id || remote.deleted_at || isStale(remote) || pendingIds.has(id)) continue;
      await metaStore.put({
        id: `${storeName}:${id}`,
        storeName,
        recordId: id,
        ownerId: userId,
        baselineRevision: rowRevision(remote),
        revision: typeof remote.revision === 'number' ? remote.revision : null,
        updatedAt: Date.now(),
      });
    }
  }

  await tx.done;
}

// ============================================================
// Dataset replacement
// ============================================================

interface ReplaceDatasetResponse {
  status: 'applied' | 'conflict';
  generation: number;
}

function readReplaceDatasetResponse(value: unknown): ReplaceDatasetResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('status' in value) || !('generation' in value)) return null;
  const { status, generation } = value;
  if (status !== 'applied' && status !== 'conflict') return null;
  if (typeof generation !== 'number' || !Number.isFinite(generation)) return null;
  return { status, generation };
}

function readRemoteGeneration(value: unknown): number | null {
  if (typeof value !== 'object' || value === null || !('generation' in value)) return null;
  const generation = value.generation;
  if (typeof generation !== 'number' || !Number.isFinite(generation)) return 0;
  return generation;
}

interface ManagedWriteResponse {
  status: 'applied' | 'conflict';
  generation: number | null;
}

function readManagedWriteResponse(value: unknown): ManagedWriteResponse | null {
  if (typeof value !== 'object' || value === null || !('status' in value)) return null;
  const status = value.status;
  if (status !== 'applied' && status !== 'conflict') return null;
  const rawGeneration = 'generation' in value ? value.generation : null;
  const generation =
    typeof rawGeneration === 'number' && Number.isFinite(rawGeneration) ? rawGeneration : null;
  return { status, generation };
}

function toRemoteManagedRecord<T extends object>(
  record: T,
  userId: string,
  generation: number
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) payload[key] = value;
  payload.userId = userId;
  payload.dataset_generation = generation;
  return preparePayloadForRemote(payload);
}

/**
 * Read the current remote dataset generation. Returns null when the lookup
 * fails, so the caller can leave local data and the queue untouched.
 */
export async function fetchRemoteGeneration(userId: string): Promise<number | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('dataset_generations')
    .select('generation')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error('[Sync] Failed to read dataset generation:', error);
    return null;
  }
  if (data === null) return 0;
  return readRemoteGeneration(data);
}

async function adoptLocalReplacementMarker(userId: string): Promise<void> {
  if (userId === LOCAL_DATASET_OWNER) return;

  const db = await getDB();
  const tx = db.transaction(STORES.DATASET_MARKERS, 'readwrite');
  const markers = tx.objectStore(STORES.DATASET_MARKERS);

  const existing = await markers.get(userId);
  const local = existing ? null : await markers.get(LOCAL_DATASET_OWNER);
  if (existing || !local || local.status === 'applied') {
    await tx.done;
    return;
  }

  await markers.put({ ...local, userId, updatedAt: Date.now() });
  await markers.delete(LOCAL_DATASET_OWNER);
  await tx.done;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  return Object.fromEntries(Object.entries(value));
}

/**
 * True when the current applied marker still represents the marker a
 * reconciliation started from. Any replacement, import, or resolution in the
 * meantime produces a different identity and must win.
 */
function isSameAppliedMarker(
  current: DatasetReplacementMarker | null,
  expected: DatasetReplacementMarker
): current is DatasetReplacementMarker {
  return (
    current !== null &&
    current.userId === expected.userId &&
    current.status === 'applied' &&
    current.generation === expected.generation &&
    current.snapshotId === expected.snapshotId
  );
}

/** True when the current marker is the exact marker an RPC attempt started from. */
function isSameReplacementMarker(
  current: DatasetReplacementMarker | null,
  expected: DatasetReplacementMarker
): current is DatasetReplacementMarker {
  return (
    current !== null &&
    current.userId === expected.userId &&
    current.snapshotId === expected.snapshotId &&
    current.generation === expected.generation &&
    current.status === expected.status
  );
}

interface ReplacementCommit {
  marker: DatasetReplacementMarker | null;
  committed: boolean;
}

/**
 * Commit an RPC outcome only if the marker is still the one the attempt read.
 * A newer import may have committed its own marker while the RPC was in flight;
 * in that case the newer marker and its snapshot win and nothing is written.
 */
async function commitReplacementMarker(
  expected: DatasetReplacementMarker,
  next: DatasetReplacementMarker
): Promise<ReplacementCommit> {
  const db = await getDB();
  let replayTime = 0;
  if (next.status === 'applied' && expected.status !== 'applied') {
    for (const store of MANAGED_STORES) {
      for (const row of await fetchAllRemoteRows(storeNameToTable(store), expected.userId)) {
        replayTime = Math.max(replayTime, new Date(row.updated_at as string).getTime() || 0);
      }
    }
  }
  const tx = db.transaction([STORES.DATASET_MARKERS, STORES.SYNC_QUEUE], 'readwrite');
  const markers = tx.objectStore(STORES.DATASET_MARKERS);
  const current = (await markers.get(expected.userId)) ?? null;
  if (!isSameReplacementMarker(current, expected)) {
    await tx.done;
    return { marker: current, committed: false };
  }
  if (next.status === 'applied' && expected.status !== 'applied') {
    const queue = tx.objectStore(STORES.SYNC_QUEUE);
    const entries = await queue.index('byTimestamp').getAll();
    for (const entry of entries) {
      const payload = asRecord(entry.payload);
      if (!isManagedStore(entry.storeName) || entry.storeName === STORES.CASH_DENOMINATIONS || !payload) continue;
      replayTime = Math.max(replayTime + 1, Number(payload.updatedAt) || 0);
      await queue.put({ ...entry, payload: { ...payload, updatedAt: replayTime } });
    }
  }
  await markers.put(next);
  await tx.done;
  return { marker: next, committed: true };
}

async function fetchAllRemoteRows(
  table: string,
  userId: string
): Promise<Record<string, unknown>[]> {
  if (!supabase) throw new Error('Supabase is not configured.');

  const pageSize = 1000;
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq('user_id', userId)
      .order('id')
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;

    for (const value of data) {
      const record = asRecord(value);
      if (record) rows.push(record);
    }
    if (data.length < pageSize) break;
  }
  return rows;
}

async function reconcileManagedSnapshot(
  userId: string,
  marker: DatasetReplacementMarker,
  generation: number
): Promise<DatasetReplacementMarker> {
  const remote = new Map<string, Record<string, unknown>[]>();
  for (const storeName of MANAGED_STORES) {
    const rows = await fetchAllRemoteRows(storeNameToTable(storeName), userId);
    remote.set(
      storeName,
      rows.filter(
        (row) => !row.deleted_at && Number(row.dataset_generation ?? 0) >= generation
      )
    );
  }

  const db = await getDB();
  const tx = db.transaction(
    [...MANAGED_STORES, STORES.SYNC_QUEUE, STORES.DATASET_MARKERS],
    'readwrite'
  );
  const markers = tx.objectStore(STORES.DATASET_MARKERS);
  const currentMarker = (await markers.get(userId)) ?? null;

  // A concurrent import or replacement committed its own marker while the
  // remote pages were fetched. Preserve its stores, queue, and marker; the new
  // pending/conflict state is what backgroundSync must act on next.
  if (!isSameAppliedMarker(currentMarker, marker)) {
    await tx.done;
    return currentMarker ?? marker;
  }

  const queued = await tx.objectStore(STORES.SYNC_QUEUE).getAll();

  if (queued.some((entry) => isManagedStore(entry.storeName))) {
    const [accounts, categories, transactions, cashDenominations, payouts, budgetTargets] =
      await Promise.all([
        tx.objectStore(STORES.ACCOUNTS).getAll(),
        tx.objectStore(STORES.CATEGORIES).getAll(),
        tx.objectStore(STORES.TRANSACTIONS).getAll(),
        tx.objectStore(STORES.CASH_DENOMINATIONS).getAll(),
        tx.objectStore(STORES.PAYOUTS).getAll(),
        tx.objectStore(STORES.BUDGET_TARGETS).getAll(),
      ]);
    const conflicted: DatasetReplacementMarker = {
      ...currentMarker,
      status: 'conflict',
      remoteGeneration: generation,
      snapshot: { accounts, categories, transactions, cashDenominations, payouts, budgetTargets },
      snapshotId: crypto.randomUUID(),
      lastError: `Cloud data was replaced by another device (generation ${generation}). Local managed edits are waiting.`,
      updatedAt: Date.now(),
    };
    await markers.put(conflicted);
    await tx.done;
    return conflicted;
  }

  for (const storeName of MANAGED_STORES) {
    const store = tx.objectStore(storeName);
    await store.clear();
    for (const row of remote.get(storeName) ?? []) {
      await store.put(remoteToLocalRecord(storeName, row) as never);
    }
  }

  const updated: DatasetReplacementMarker = {
    ...currentMarker,
    status: 'applied',
    generation,
    snapshot: null,
    remoteGeneration: null,
    lastError: null,
    updatedAt: Date.now(),
  };
  await markers.put(updated);
  await tx.done;

  setActiveDatasetGeneration(generation);
  return updated;
}

/**
 * Turn a managed write fenced by the RPC into a durable conflict marker. The
 * marker is re-read inside the snapshot transaction so a concurrent import or
 * reconciliation is not overwritten with this cycle's stale view. Queue
 * entries are left untouched for the explicit resolution flow.
 */
async function recordManagedConflict(
  marker: DatasetReplacementMarker,
  remoteGeneration: number
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction([...MANAGED_STORES, STORES.DATASET_MARKERS], 'readwrite');
  const markers = tx.objectStore(STORES.DATASET_MARKERS);
  const current = await markers.get(marker.userId);
  if (!current || current.status !== 'applied' || current.generation !== marker.generation) {
    await tx.done;
    return;
  }

  const [accounts, categories, transactions, cashDenominations, payouts, budgetTargets] =
    await Promise.all([
      tx.objectStore(STORES.ACCOUNTS).getAll(),
      tx.objectStore(STORES.CATEGORIES).getAll(),
      tx.objectStore(STORES.TRANSACTIONS).getAll(),
      tx.objectStore(STORES.CASH_DENOMINATIONS).getAll(),
      tx.objectStore(STORES.PAYOUTS).getAll(),
      tx.objectStore(STORES.BUDGET_TARGETS).getAll(),
    ]);
  const conflicted: DatasetReplacementMarker = {
    ...current,
    status: 'conflict',
    remoteGeneration,
    snapshot: { accounts, categories, transactions, cashDenominations, payouts, budgetTargets },
    snapshotId: crypto.randomUUID(),
    lastError: remoteGeneration === current.generation
      ? 'Cloud records conflict with local edits. Local managed edits are waiting for explicit resolution.'
      : `Cloud data was replaced by another device (generation ${remoteGeneration}). Local managed edits are waiting.`,
    updatedAt: Date.now(),
  };
  await markers.put(conflicted);
  await tx.done;
}

/**
 * Read the user's marker and create the initial applied marker in the same
 * readwrite transaction. A concurrent import can commit its pending marker
 * while the remote generation is fetched; the transaction sees that marker and
 * returns it untouched instead of overwriting it with the default.
 *
 * The initial marker starts at generation 0, never at the observed remote
 * generation: an absent marker means this client has never reconciled with a
 * replacement, so any remote generation above 0 must go through the
 * authoritative snapshot reconcile. Seeding it at the remote generation would
 * make the strict `remoteGeneration > marker.generation` check skip that
 * reconcile and a later pull would keep stale local-only managed rows.
 */
async function readOrCreateInitialMarker(
  userId: string
): Promise<DatasetReplacementMarker> {
  const db = await getDB();
  const tx = db.transaction(STORES.DATASET_MARKERS, 'readwrite');
  const markers = tx.objectStore(STORES.DATASET_MARKERS);

  const existing = (await markers.get(userId)) ?? null;
  if (existing) {
    await tx.done;
    return existing;
  }

  const created: DatasetReplacementMarker = {
    userId,
    generation: 0,
    snapshotId: '',
    status: 'applied',
    snapshot: null,
    remoteGeneration: null,
    attempts: 0,
    lastError: null,
    updatedAt: Date.now(),
  };
  await markers.put(created);
  await tx.done;
  return created;
}

async function ensureLocalGeneration(
  userId: string
): Promise<DatasetReplacementMarker | null> {
  await adoptLocalReplacementMarker(userId);

  const remoteGeneration = await fetchRemoteGeneration(userId);
  if (remoteGeneration === null) return null;

  const marker = await readOrCreateInitialMarker(userId);
  setActiveDatasetGeneration(marker.generation);

  if (marker.status !== 'applied') return marker;

  if (remoteGeneration > marker.generation) {
    return reconcileManagedSnapshot(userId, marker, remoteGeneration);
  }

  return marker;
}

function buildReplacementParams(
  marker: DatasetReplacementMarker
): Record<string, unknown> | null {
  const snapshot = marker.snapshot;
  if (!snapshot) return null;

  return {
    p_snapshot_id: marker.snapshotId,
    p_generation: marker.generation,
    p_accounts: snapshot.accounts.map((record) =>
      toRemoteManagedRecord(record, marker.userId, marker.generation)
    ),
    p_categories: snapshot.categories.map((record) =>
      toRemoteManagedRecord(record, marker.userId, marker.generation)
    ),
    p_transactions: snapshot.transactions.map((record) =>
      toRemoteManagedRecord(record, marker.userId, marker.generation)
    ),
    p_cash_denominations: snapshot.cashDenominations.map((record) =>
      toRemoteManagedRecord(record, marker.userId, marker.generation)
    ),
    p_payouts: snapshot.payouts.map((record) =>
      toRemoteManagedRecord(record, marker.userId, marker.generation)
    ),
    p_budget_targets: snapshot.budgetTargets.map((record) =>
      toRemoteManagedRecord(record, marker.userId, marker.generation)
    ),
  };
}

/**
 * Apply the durable replacement snapshot through the transactional RPC.
 * A failed attempt keeps the marker and snapshot so it stays actionable and
 * retries with the same snapshot ID, which the RPC treats as idempotent.
 */
export async function applyDatasetReplacement(
  userId: string
): Promise<DatasetReplacementMarker | null> {
  if (!supabase) return null;

  const marker = await getDatasetReplacementMarker(userId);
  if (!marker || marker.status === 'applied') return marker;

  if (!marker.snapshot) {
    const failed: DatasetReplacementMarker = {
      ...marker,
      status: 'failed',
      attempts: marker.attempts + 1,
      lastError: 'The replacement snapshot is missing. Import the CSV again.',
      updatedAt: Date.now(),
    };
    const commit = await commitReplacementMarker(marker, failed);
    return commit.marker;
  }

  const params = buildReplacementParams(marker);
  if (!params) return marker;

  const { data, error } = await supabase.rpc('replace_user_dataset', params);

  if (error) {
    const failed: DatasetReplacementMarker = {
      ...marker,
      status: 'failed',
      attempts: marker.attempts + 1,
      lastError: error.message.trim().split('\n')[0].slice(0, 200),
      updatedAt: Date.now(),
    };
    const commit = await commitReplacementMarker(marker, failed);
    return commit.marker;
  }

  const response = readReplaceDatasetResponse(data);
  if (response?.status === 'conflict') {
    const conflicted: DatasetReplacementMarker = {
      ...marker,
      status: 'conflict',
      remoteGeneration: response.generation,
      attempts: marker.attempts + 1,
      lastError: `Cloud data was replaced by another device (generation ${response.generation}).`,
      updatedAt: Date.now(),
    };
    const commit = await commitReplacementMarker(marker, conflicted);
    return commit.marker;
  }

  if (response?.status === 'applied') {
    const applied: DatasetReplacementMarker = {
      ...marker,
      status: 'applied',
      generation: response.generation,
      snapshot: null,
      remoteGeneration: null,
      lastError: null,
      updatedAt: Date.now(),
    };
    const commit = await commitReplacementMarker(marker, applied);
    if (commit.committed) setActiveDatasetGeneration(applied.generation);
    return commit.marker;
  }

  const failed: DatasetReplacementMarker = {
    ...marker,
    status: 'failed',
    attempts: marker.attempts + 1,
    lastError: 'Cloud replacement returned an unexpected response.',
    updatedAt: Date.now(),
  };
  const commit = await commitReplacementMarker(marker, failed);
  return commit.marker;
}

/**
 * Rebuild and apply a conflicted replacement. Preparation re-reads the marker
 * inside its own transaction and derives the next generation from that fresh
 * view; when the marker is no longer a conflict (for example a concurrent
 * import landed), nothing is rebuilt or applied.
 */
export async function resolveReplacementConflict(
  userId: string
): Promise<DatasetReplacementMarker | null> {
  const prepared = await prepareConflictReplacement(userId);
  if (!prepared) return getDatasetReplacementMarker(userId);

  return applyDatasetReplacement(userId);
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

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // 0. Migrate any legacy slug IDs to proper UUIDs before syncing
    await ensureUuids();

    // 1. Resolve the dataset generation. Management of the six CSV stores is
    //    gated on the durable replacement marker being applied.
    const marker = await ensureLocalGeneration(user.id);
    if (!marker) return;

    let active = marker;
    if (active.status === 'conflict') {
      // Only the explicit conflict-resolution flow may adopt a new generation.
      window.dispatchEvent(new CustomEvent('sync-complete', { detail: { userId: user.id } }));
      return;
    }
    if (active.status !== 'applied') {
      active = (await applyDatasetReplacement(user.id)) ?? active;
      if (active.status !== 'applied') {
        window.dispatchEvent(new CustomEvent('sync-complete', { detail: { userId: user.id } }));
        return;
      }
    }

    // 2. Push local changes with the applied generation. A managed write
    //    fenced by a newer remote generation stops the cycle: the queue entry
    //    stays put and local edits become a durable conflict marker, with no
    //    pull from the superseding remote snapshot.
    try {
      await processSyncQueue(active.generation);
    } catch (err) {
      if (!(err instanceof ManagedWriteConflictError)) throw err;
      await recordManagedConflict(active, err.generation ?? active.generation + 1);
      window.dispatchEvent(new CustomEvent('sync-complete', { detail: { userId: user.id } }));
      return;
    }

    // 3. Pull fresh data for all stores
    const allStores = [
      STORES.TRANSACTIONS,
      STORES.ACCOUNTS,
      STORES.CATEGORIES,
      STORES.CASH_DENOMINATIONS,
      STORES.PAYOUTS,
      STORES.BUDGET_TARGETS,
      STORES.BALANCE_SNAPSHOTS,
      STORES.STOCKS,
      STORES.STOCK_TRANSACTIONS,
      STORES.DIVIDENDS,
    ];

    // Sequential to avoid concurrent IDB transactions
    for (const store of allStores) {
      await requireAppliedGeneration(user.id, active.generation);
      await pullStore(store, user.id, active.generation);
    }

    // Record successful sync time for UI display
    localStorage.setItem('last_sync_time', Date.now().toString());

    // Notify pages that fresh remote data is available in IDB
    window.dispatchEvent(new CustomEvent('sync-complete', { detail: { userId: user.id } }));
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
    balanceSnapshots: 'balance_snapshots',
  };
  return map[storeName] ?? storeName;
}

function remoteToLocalRecord(storeName: string, record: Record<string, unknown>): Record<string, unknown> {
  return storeName === STORES.DIVIDENDS ? normalizeDividendRecord(record) : snakeToCamel(record);
}


/**
 * Convert a local payload (camelCase, ms timestamps) to
 * Supabase format (snake_case, ISO timestamps, no deleted_at).
 */
export function preparePayloadForRemote(
  payload: Record<string, unknown> | null
): Record<string, unknown> {
  if (!payload) return {};

  const isDividend = payload.stockId != null && (
    'exDate' in payload ||
    'payDate' in payload ||
    'qty' in payload ||
    'rate' in payload ||
    'dividendYield' in payload
  );
  const compatiblePayload = isDividend
    ? { ...payload, ...normalizeDividendRecord(payload) }
    : payload;
  const converted = camelToSnake(compatiblePayload);

  if (isDividend && (converted.date == null || converted.date === '')) {
    converted.date = converted.ex_date;
  }

  // Convert ms timestamps to ISO strings for Postgres
  for (const key of ['created_at', 'updated_at']) {
    if (typeof converted[key] === 'number') {
      converted[key] = new Date(converted[key] as number).toISOString();
    }
  }

  // Strip deleted_at outbound — soft-delete is set via separate update
  delete converted.deleted_at;
  // Server-owned metadata must never be echoed back as business data.
  delete converted.revision;

  return converted;
}

/** Number of sync entries paused after repeated failures (never dropped). */
export function getFailedSyncCount(): number {
  try {
    return parseInt(localStorage.getItem('sync_failed_count') ?? '0', 10);
  } catch {
    return 0;
  }
}

/**
 * Re-arm paused entries for the next cycle. Payloads are untouched, so this
 * cannot lose work; it only clears the failure counter.
 */
export async function retryPausedEntries(): Promise<number> {
  const db = await getDB();
  const tx = db.transaction(STORES.SYNC_QUEUE, 'readwrite');
  const queue = tx.objectStore(STORES.SYNC_QUEUE);
  const all = await queue.getAll();
  let resumed = 0;
  for (const entry of all) {
    // Only transient pauses are safe to retry. Ownership and revision
    // conflicts need an explicit resolution, not another automatic attempt.
    if (entry.state !== 'paused') continue;
    await queue.put({ ...entry, state: 'pending', retryCount: 0 });
    resumed += 1;
  }
  await tx.done;
  if (resumed > 0) clearFailedSyncCount();
  return resumed;
}

/**
 * Re-apply revision-blocked work on top of the row the server holds now. This
 * is the explicit choice to keep the local payload: the current remote revision
 * becomes the baseline, so the next push can prove that base. Work whose remote
 * row is gone stays blocked — creating it again is a separate decision.
 */
export async function resolveRevisionBlockedUploads(): Promise<number> {
  const db = await getDB();
  const all = await db.getAll(STORES.SYNC_QUEUE);
  let resolved = 0;
  for (const entry of all) {
    if (entry.state !== 'blocked' || entry.blockReason !== 'revision') continue;
    if (!entry.ownerId) continue;
    const tableName = storeNameToTable(entry.storeName);
    const remote = await fetchRemoteRow(tableName, entry.recordId, entry.ownerId).catch(() => null);
    if (!remote || remote.deleted_at) continue;
    await putSyncBaseline(entry.storeName, entry.recordId, entry.ownerId, rowRevision(remote));
    await db.put(STORES.SYNC_QUEUE, {
      ...entry,
      state: 'pending',
      retryCount: 0,
      lastError: null,
    });
    resolved += 1;
  }
  return resolved;
}

/** Outstanding failures, derived from durable queue state for one account. */
export async function getSyncFailureSummary(): Promise<{ paused: number; blocked: number }> {
  let owner: string | null = null;
  try {
    owner = localStorage.getItem(LAST_USER_STORAGE_KEY);
  } catch { /* unavailable */ }
  const db = await getDB();
  const entries = await db.getAll(STORES.SYNC_QUEUE);
  const summary = { paused: 0, blocked: 0 };
  for (const entry of entries) {
    if (!owner || entry.ownerId !== owner) continue;
    if (entry.state === 'paused') summary.paused += 1;
    else if (entry.state === 'blocked') summary.blocked += 1;
  }
  return summary;
}

/** Clear the failed sync counter (call after retry). */
export function clearFailedSyncCount(): void {
  try {
    localStorage.removeItem('sync_failed_count');
  } catch { /* ignore */ }
}
