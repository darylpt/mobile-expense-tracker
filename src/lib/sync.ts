// ============================================================
// sync.ts — Local-First Background Sync (Phase 3A safety release)
//
// Outbox invariants:
//   - Queue entries are only removed after a verified server readback.
//   - Failed entries are kept forever (paused after repeated failures).
//   - Legacy / unowned entries are quarantined and never auto-replayed.
//   - Every mutation carries the account that produced it.
//
// Conflict invariants:
//   - Pending local work is never overwritten or deleted by a pull.
//   - Uploads compare the remote row against a stored server baseline
//     (raw `updated_at` / immutable `created_at`), never a device clock.
//   - Any mismatch preserves both versions and records a durable conflict.
//
// Identity invariants:
//   - A cycle captures one auth scope at entry and never recaptures it.
//   - Transaction/account invalidation aborts in-flight merge transactions.
//   - A stale response or merge is cancellation, never success or failure.
//
// Soft-delete strategy:
//   "Delete" sets `deleted_at` on Supabase (never hard-delete). Local paths
//   archive the complete record before removing it.
// ============================================================

'use client';

import type { IDBPDatabase } from 'idb';
import { supabase } from './supabase';
import { getDB, ensureUuids } from './idb';
import type {
  SyncQueueEntry,
  SyncMetaEntry,
  SyncDeletionSnapshot,
  ExpenseTrackerDB,
} from './idb';
import {
  STORES,
  DATA_STORES,
  SYNC_RETRY_PAUSE_THRESHOLD,
} from './constants';
import { normalizeDividendRecord } from './dividends';
import {
  captureAuthScope,
  isAuthScopeCurrent,
  registerAuthTransaction,
  type AuthScope,
} from './auth-scope';

const KNOWN_OPERATIONS: Record<string, true> = {
  create: true,
  update: true,
  delete: true,
};
const SYNCABLE_STORES: Record<string, true> = Object.fromEntries(
  DATA_STORES.map((store) => [store, true] as const)
);

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
      (camelKey === 'createdAt' ||
        camelKey === 'updatedAt' ||
        camelKey === 'deletedAt' ||
        camelKey === 'priceUpdatedAt') &&
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
// Shared helpers
// ============================================================

type RemoteRow = Record<string, unknown>;

function recordKey(storeName: string, recordId: string): string {
  return `${storeName}:${recordId}`;
}

function serverRevision(remote: RemoteRow): string | null {
  const value = remote.updated_at ?? remote.created_at ?? null;
  return typeof value === 'string' ? value : null;
}

/**
 * Returned by readbacks when account work loses the identity generation that
 * authorized it. Callers must stop the cycle without settling queue work.
 */
const SCOPE_INVALIDATED = Symbol('sync-scope-invalidated');

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = err.message;
    if (message != null) return String(message);
  }
  return String(err);
}

function errorCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = err.code;
    return code == null ? null : String(code);
  }
  return null;
}

function localUpdatedAt(record: unknown): number | null {
  if (typeof record !== 'object' || record === null || !('updatedAt' in record)) {
    return null;
  }
  const value = record.updatedAt;
  return typeof value === 'number' ? value : null;
}

function convertTimestamps(converted: RemoteRow): void {
  for (const key of ['created_at', 'updated_at', 'price_updated_at']) {
    if (typeof converted[key] === 'number') {
      converted[key] = new Date(converted[key] as number).toISOString();
    }
  }
}

/**
 * Convert a local payload (camelCase, ms timestamps) to Supabase format
 * (snake_case, ISO timestamps). `deleted_at` is never sent on writes.
 */
export function preparePayloadForRemote(
  payload: Record<string, unknown> | null,
  userId?: string
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
  if (userId) converted.user_id = userId;

  convertTimestamps(converted);

  // Strip deleted_at outbound — soft-delete is set via a separate CAS update
  delete converted.deleted_at;

  return converted;
}

/** Remove fields that exist only in IndexedDB and have no remote column. */
function outboundPayload(
  storeName: string,
  localRecord: unknown,
  userId?: string
): Record<string, unknown> {
  if (!localRecord || typeof localRecord !== 'object') return {};
  const outbound = preparePayloadForRemote(localRecord as Record<string, unknown>, userId);
  if (storeName === STORES.CATEGORIES) delete outbound.has_destination_account;
  if (storeName === STORES.TRANSACTIONS) delete outbound.account;
  delete outbound.user_id;
  if (userId) outbound.user_id = userId;
  return outbound;
}

/** Structural comparison for local payload values and remote row values. */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (typeof a === 'object' || typeof b === 'object') {
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      return a.every((value, index) => valuesEqual(value, b[index]));
    }
    const aObject = a as Record<string, unknown>;
    const bObject = b as Record<string, unknown>;
    const aKeys = Object.keys(aObject);
    if (aKeys.length !== Object.keys(bObject).length) return false;
    return aKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(bObject, key) && valuesEqual(aObject[key], bObject[key])
    );
  }
  return String(a) === String(b);
}

/**
 * Verify that the server row matches the complete intended local record.
 * Used before acknowledging a create or treating a CAS miss as our own write.
 */
function matchesIntendedRemote(
  storeName: string,
  localRecord: unknown,
  remote: RemoteRow
): boolean {
  if (!localRecord || typeof localRecord !== 'object') return false;
  const intended = outboundPayload(storeName, localRecord);
  for (const [key, value] of Object.entries(intended)) {
    if (key === 'deleted_at' || value === undefined) continue;
    if (!valuesEqual(value, remote[key])) return false;
  }
  return true;
}

function remoteToLocalRecord(storeName: string, record: RemoteRow): Record<string, unknown> {
  return storeName === STORES.DIVIDENDS
    ? normalizeDividendRecord(record) as Record<string, unknown>
    : snakeToCamel(record);
}

function metaForRemote(
  storeName: string,
  remote: RemoteRow,
  ownerId: string,
  local: unknown
): SyncMetaEntry {
  const now = Date.now();
  return {
    id: recordKey(storeName, String(remote.id)),
    storeName,
    recordId: String(remote.id),
    ownerId,
    baseline: remote,
    baselineRevision: serverRevision(remote),
    localUpdatedAt: localUpdatedAt(local),
    state: 'clean',
    conflict: null,
    lastError: null,
    lastAttemptAt: null,
    updatedAt: now,
  };
}

function conflictMeta(
  storeName: string,
  recordId: string,
  ownerId: string | null,
  local: unknown,
  remote: RemoteRow | null,
  reason: string,
  previous?: SyncMetaEntry
): SyncMetaEntry {
  const now = Date.now();
  return {
    id: recordKey(storeName, recordId),
    storeName,
    recordId,
    ownerId: previous?.ownerId ?? ownerId,
    baseline: previous?.baseline ?? null,
    baselineRevision: previous?.baselineRevision ?? null,
    localUpdatedAt: localUpdatedAt(local),
    state: 'conflict',
    conflict: { local, remote, reason, detectedAt: now },
    lastError: reason,
    lastAttemptAt: now,
    updatedAt: now,
  };
}

/** Atomically apply the outcome of one queue entry. */
async function commitOutcome(
  db: IDBPDatabase<ExpenseTrackerDB>,
  options: {
    queueEntry?: SyncQueueEntry;
    removeQueueId?: string;
    meta?: SyncMetaEntry;
    deletionId?: string;
    deletionPatch?: Partial<SyncDeletionSnapshot>;
  },
  scope: AuthScope
): Promise<boolean> {
  if (!isAuthScopeCurrent(scope)) return false;

  const storeNames = [STORES.SYNC_QUEUE, STORES.SYNC_META] as const;
  const tx = db.transaction(
    options.deletionId
      ? [...storeNames, STORES.SYNC_DELETIONS]
      : [...storeNames],
    'readwrite'
  );
  // Cancellation aborts the transaction before it is awaited; keep that
  // rejection handled without changing the awaited result below.
  void tx.done.catch(() => {});

  // Invalidation may land between the preflight check above and this
  // registration; registerAuthTransaction aborts synchronously in that case.
  let cancelled = false;
  const release = registerAuthTransaction(scope, {
    abort: () => {
      cancelled = true;
      try {
        tx.abort();
      } catch {
        // The transaction already settled; nothing left to cancel.
      }
    },
  });

  try {
    if (cancelled || !isAuthScopeCurrent(scope)) {
      try {
        tx.abort();
      } catch {
        // Already aborted by the registration callback.
      }
      return false;
    }

    if (options.removeQueueId) {
      await tx.objectStore(STORES.SYNC_QUEUE).delete(options.removeQueueId);
    } else if (options.queueEntry) {
      await tx.objectStore(STORES.SYNC_QUEUE).put(options.queueEntry);
    }
    if (options.meta) {
      await tx.objectStore(STORES.SYNC_META).put(options.meta);
    }
    if (options.deletionId && options.deletionPatch) {
      const existing = await tx.objectStore(STORES.SYNC_DELETIONS).get(options.deletionId);
      if (existing) {
        await tx.objectStore(STORES.SYNC_DELETIONS).put({
          ...existing,
          ...options.deletionPatch,
        });
      }
    }
    await tx.done;
    return true;
  } catch (err) {
    // An aborted transaction is cancellation, not a queue failure. The caller
    // must retain the local work and withhold acknowledgment.
    if (cancelled || !isAuthScopeCurrent(scope)) return false;
    throw err;
  } finally {
    release();
  }
}

async function selectRemoteRow(
  tableName: string,
  recordId: string,
  userId: string,
  scope: AuthScope
): Promise<RemoteRow | null | typeof SCOPE_INVALIDATED> {
  if (!isAuthScopeCurrent(scope)) return SCOPE_INVALIDATED;
  if (!supabase) return null;
  const { data, error } = await supabase
    .from(tableName)
    .select('*')
    .eq('id', recordId)
    .eq('user_id', userId)
    .limit(1);
  if (!isAuthScopeCurrent(scope)) return SCOPE_INVALIDATED;
  if (error) throw error;
  return (data?.[0] as RemoteRow | undefined) ?? null;
}

/** True when a child record's stock parent still has unfinished queue work. */
function stockParentUnresolved(
  entries: SyncQueueEntry[],
  remainingIds: Set<string>,
  stockId: string
): boolean {
  return entries.some((candidate) =>
    remainingIds.has(candidate.id) &&
    candidate.storeName === STORES.STOCKS &&
    candidate.recordId === stockId
  );
}

// ============================================================
// Push — process the local outbox
// ============================================================

export interface SyncPushSummary {
  attempted: number;
  acknowledged: number;
  failed: number;
  /** Queue entries still present after the run (all states). */
  remaining: number;
}

/**
 * Process the local sync queue — push pending changes to Supabase.
 * Settled entries are deleted only after a verified readback; everything else
 * is retained with its attempt count, payload, and last error.
 *
 * A caller-supplied user ID may only confirm the captured scope. It is never
 * an authorization bypass: missing/mismatched owner markers and stale
 * generations stop before any queue or network work.
 */
export async function processSyncQueue(userIdArg?: string): Promise<SyncPushSummary> {
  const empty: SyncPushSummary = { attempted: 0, acknowledged: 0, failed: 0, remaining: 0 };
  if (!navigator.onLine || !supabase) return empty;

  const scope = captureAuthScope();
  if (!scope) return empty;
  if (userIdArg != null && userIdArg !== scope.userId) return empty;

  return processSyncQueueForScope(scope);
}

/**
 * Push work already authorized by `scope`. `backgroundSync` passes the token
 * captured at cycle entry so an A → signed-out → A transition cannot let an
 * old cycle recapture the new A generation.
 */
async function processSyncQueueForScope(scope: AuthScope): Promise<SyncPushSummary> {
  const empty: SyncPushSummary = { attempted: 0, acknowledged: 0, failed: 0, remaining: 0 };
  if (!navigator.onLine || !supabase) return empty;
  if (!isAuthScopeCurrent(scope)) return empty;

  const userId = scope.userId;
  const db = await getDB();
  if (!isAuthScopeCurrent(scope)) return empty;
  const allEntries = await db.getAllFromIndex(STORES.SYNC_QUEUE, 'byTimestamp');
  if (!isAuthScopeCurrent(scope)) return empty;
  if (allEntries.length === 0) return empty;

  const remainingIds = new Set(allEntries.map((entry) => entry.id));
  const failedRecordKeys = new Set<string>();
  const deferredRecordKeys = new Set<string>();
  const unresolvedRecordKeys = new Set(
    allEntries
      .filter((entry) => entry.state !== 'pending')
      .map((entry) => recordKey(entry.storeName, entry.recordId))
  );
  let acknowledged = 0;
  let failed = 0;
  let attempted = 0;

  const summarize = (): SyncPushSummary => ({
    attempted,
    acknowledged,
    failed,
    remaining: allEntries.length - acknowledged,
  });

  for (const original of allEntries) {
    if (!isAuthScopeCurrent(scope)) return summarize();
    if (original.state !== 'pending') continue;

    // Ownership must be proven. Never stamp the current user onto legacy work.
    if (original.ownerId == null) {
      const quarantined: SyncQueueEntry = {
        ...original,
        state: 'quarantined',
        lastError: original.lastError ?? 'Legacy queue entry: owning account is unknown',
        quarantinedAt: original.quarantinedAt ?? Date.now(),
      };
      if (!(await commitOutcome(db, {
        queueEntry: quarantined,
        meta: {
          id: recordKey(original.storeName, original.recordId),
          storeName: original.storeName,
          recordId: original.recordId,
          ownerId: null,
          baseline: original.baseline,
          baselineRevision: original.baselineRevision,
          localUpdatedAt: localUpdatedAt(original.payload),
          state: 'quarantined',
          conflict: null,
          lastError: quarantined.lastError,
          lastAttemptAt: null,
          updatedAt: Date.now(),
        },
      }, scope))) return summarize();
      continue;
    }
    if (original.ownerId !== userId) {
      const blocked: SyncQueueEntry = {
        ...original,
        state: 'blocked',
        lastError: 'Local change belongs to a different signed-in account',
        lastAttemptAt: Date.now(),
      };
      if (!(await commitOutcome(db, { queueEntry: blocked }, scope))) return summarize();
      continue;
    }

    if (!SYNCABLE_STORES[original.storeName] || !KNOWN_OPERATIONS[original.operation]) {
      const quarantined: SyncQueueEntry = {
        ...original,
        state: 'quarantined',
        lastError: 'Unknown store or operation; entry preserved but not replayed',
        quarantinedAt: original.quarantinedAt ?? Date.now(),
      };
      if (!(await commitOutcome(db, {
        queueEntry: quarantined,
        meta: {
          id: recordKey(original.storeName, original.recordId),
          storeName: original.storeName,
          recordId: original.recordId,
          ownerId: original.ownerId,
          baseline: original.baseline,
          baselineRevision: original.baselineRevision,
          localUpdatedAt: localUpdatedAt(original.payload),
          state: 'quarantined',
          conflict: null,
          lastError: quarantined.lastError,
          lastAttemptAt: null,
          updatedAt: Date.now(),
        },
      }, scope))) return summarize();
      continue;
    }

    const key = recordKey(original.storeName, original.recordId);
    if (
      failedRecordKeys.has(key) ||
      deferredRecordKeys.has(key) ||
      unresolvedRecordKeys.has(key)
    ) {
      continue; // preserve per-record ordering
    }

    const isStockChild =
      original.storeName === STORES.STOCK_TRANSACTIONS ||
      original.storeName === STORES.DIVIDENDS;
    if (isStockChild) {
      const payload = original.payload as Record<string, unknown> | null;
      const stockId = payload?.stockId;
      if (typeof stockId === 'string' && stockParentUnresolved(allEntries, remainingIds, stockId)) {
        deferredRecordKeys.add(key);
        continue; // parent must be settled first
      }
    }

    attempted++;
    const tableName = storeNameToTable(original.storeName);
    const metaKey = recordKey(original.storeName, original.recordId);
    let meta: SyncMetaEntry | undefined;
    try {
      meta = await db.get(STORES.SYNC_META, metaKey);
    } catch {
      meta = undefined;
    }

    try {
      switch (original.operation) {
        case 'create': {
          const payload = original.payload as Record<string, unknown> | null;
          if (!payload) throw new Error('Create queue entry has no payload');
          const outbound = outboundPayload(original.storeName, payload, userId);

          let remote: RemoteRow | null = null;
          if (!isAuthScopeCurrent(scope)) return summarize();
          const { data, error } = await supabase
            .from(tableName)
            .insert(outbound)
            .select('*');
          if (!isAuthScopeCurrent(scope)) return summarize();

          if (error && errorCode(error) !== '23505') throw error;

          if (!error && data && data.length > 0) {
            remote = data[0] as RemoteRow;
          } else {
            // Duplicate or suppressed write — read back before acknowledging.
            const readback = await selectRemoteRow(tableName, original.recordId, userId, scope);
            if (readback === SCOPE_INVALIDATED) return summarize();
            remote = readback;
          }

          if (!remote) {
            throw new Error('Server did not confirm the inserted record');
          }
          if (remote.deleted_at) {
            const conflict = conflictMeta(
              original.storeName, original.recordId, userId,
              payload, remote, 'Remote record is deleted; local create preserved', meta
            );
            if (!(await commitOutcome(db, {
              queueEntry: {
                ...original,
                state: 'conflict',
                lastError: conflict.lastError ?? 'Remote tombstone',
                lastAttemptAt: Date.now(),
              },
              meta: conflict,
            }, scope))) return summarize();
            failed++;
            failedRecordKeys.add(key);
            continue;
          }
          if (!matchesIntendedRemote(original.storeName, payload, remote)) {
            const conflict = conflictMeta(
              original.storeName, original.recordId, userId,
              payload, remote, 'Remote record differs from the local create', meta
            );
            if (!(await commitOutcome(db, {
              queueEntry: {
                ...original,
                state: 'conflict',
                lastError: conflict.lastError ?? 'Remote mismatch',
                lastAttemptAt: Date.now(),
              },
              meta: conflict,
            }, scope))) return summarize();
            failed++;
            failedRecordKeys.add(key);
            continue;
          }

          if (!(await commitOutcome(db, {
            removeQueueId: original.id,
            meta: metaForRemote(original.storeName, remote, userId, payload),
          }, scope))) return summarize();
          acknowledged++;
          remainingIds.delete(original.id);
          break;
        }

        case 'update': {
          const payload = original.payload as Record<string, unknown> | null;
          if (!payload) throw new Error('Update queue entry has no payload');
          const baselineRevision = meta?.baselineRevision ?? original.baselineRevision;
          if (!baselineRevision || original.storeName === STORES.CASH_DENOMINATIONS) {
            const remote = await selectRemoteRow(tableName, original.recordId, userId, scope);
            if (remote === SCOPE_INVALIDATED) return summarize();
            const conflict = conflictMeta(
              original.storeName, original.recordId, userId,
              payload, remote, 'No server baseline available for update', meta
            );
            if (!(await commitOutcome(db, {
              queueEntry: {
                ...original,
                state: 'conflict',
                lastError: conflict.lastError ?? 'Missing baseline',
                lastAttemptAt: Date.now(),
              },
              meta: conflict,
            }, scope))) return summarize();
            failed++;
            failedRecordKeys.add(key);
            continue;
          }

          const outbound = outboundPayload(original.storeName, payload, userId);
          const baselineMs = Date.parse(baselineRevision);
          const localMs = localUpdatedAt(payload) ?? Date.now();
          const nextMs = Math.max(
            localMs,
            Number.isFinite(baselineMs) ? baselineMs + 1 : 0
          );
          outbound.updated_at = new Date(nextMs).toISOString();

          if (!isAuthScopeCurrent(scope)) return summarize();
          const { data, error } = await supabase
            .from(tableName)
            .update(outbound)
            .eq('id', original.recordId)
            .eq('updated_at', baselineRevision)
            .eq('user_id', userId)
            .is('deleted_at', null)
            .select('*');
          if (!isAuthScopeCurrent(scope)) return summarize();
          if (error) throw error;

          if (!data || data.length === 0) {
            // A CAS miss is never acknowledged: preserve both versions.
            const remote = await selectRemoteRow(tableName, original.recordId, userId, scope);
            if (remote === SCOPE_INVALIDATED) return summarize();
            const conflict = conflictMeta(
              original.storeName, original.recordId, userId,
              payload, remote, 'Remote update no longer matches the recorded baseline', meta
            );
            if (!(await commitOutcome(db, {
              queueEntry: {
                ...original,
                state: 'conflict',
                lastError: conflict.lastError ?? 'Update conflict',
                lastAttemptAt: Date.now(),
              },
              meta: conflict,
            }, scope))) return summarize();
            failed++;
            failedRecordKeys.add(key);
            continue;
          }

          const remote = data[0] as RemoteRow;
          const intended = { ...payload, updatedAt: nextMs };
          if (!matchesIntendedRemote(original.storeName, intended, remote)) {
            const conflict = conflictMeta(
              original.storeName, original.recordId, userId,
              payload, remote, 'Server representation did not match the update', meta
            );
            if (!(await commitOutcome(db, {
              queueEntry: {
                ...original,
                state: 'conflict',
                lastError: conflict.lastError ?? 'Update mismatch',
                lastAttemptAt: Date.now(),
              },
              meta: conflict,
            }, scope))) return summarize();
            failed++;
            failedRecordKeys.add(key);
            continue;
          }

          if (!(await commitOutcome(db, {
            removeQueueId: original.id,
            meta: metaForRemote(original.storeName, remote, userId, payload),
          }, scope))) return summarize();
          acknowledged++;
          remainingIds.delete(original.id);
          break;
        }

        case 'delete': {
          const nowIso = new Date().toISOString();
          const baselineRevision = meta?.baselineRevision ?? original.baselineRevision ?? null;

          if (original.storeName === STORES.CASH_DENOMINATIONS) {
            // cash_denominations: immutable created_at + not already deleted.
            if (!baselineRevision) {
              const remote = await selectRemoteRow(tableName, original.recordId, userId, scope);
              if (remote === SCOPE_INVALIDATED) return summarize();
              const conflict = conflictMeta(
                original.storeName, original.recordId, userId,
                original.payload, remote, 'No immutable baseline available for delete', meta
              );
              if (!(await commitOutcome(db, {
                queueEntry: {
                  ...original,
                  state: 'conflict',
                  lastError: conflict.lastError ?? 'Delete conflict',
                  lastAttemptAt: Date.now(),
                },
                meta: conflict,
                deletionId: original.deletionSnapshotId ?? undefined,
                deletionPatch: { state: 'conflict', lastError: conflict.lastError, updatedAt: Date.now() },
              }, scope))) return summarize();
              failed++;
              failedRecordKeys.add(key);
              continue;
            }

            if (!isAuthScopeCurrent(scope)) return summarize();
            const { data, error } = await supabase
              .from(tableName)
              .update({ deleted_at: nowIso })
              .eq('id', original.recordId)
              .eq('created_at', baselineRevision)
              .eq('user_id', userId)
              .is('deleted_at', null)
              .select('*');
            if (!isAuthScopeCurrent(scope)) return summarize();
            if (error) throw error;

            if (!data || data.length === 0) {
              const remote = await selectRemoteRow(tableName, original.recordId, userId, scope);
              if (remote === SCOPE_INVALIDATED) return summarize();
              const conflict = conflictMeta(
                original.storeName, original.recordId, userId,
                original.payload, remote, 'Cash deletion no longer matches the recorded baseline', meta
              );
              if (!(await commitOutcome(db, {
                queueEntry: {
                  ...original,
                  state: 'conflict',
                  lastError: conflict.lastError ?? 'Delete conflict',
                  lastAttemptAt: Date.now(),
                },
                meta: conflict,
                deletionId: original.deletionSnapshotId ?? undefined,
                deletionPatch: { state: 'conflict', lastError: conflict.lastError, updatedAt: Date.now() },
              }, scope))) return summarize();
              failed++;
              failedRecordKeys.add(key);
              continue;
            }

            if (!(await commitOutcome(db, {
              removeQueueId: original.id,
              meta: metaForRemote(original.storeName, data[0] as RemoteRow, userId, original.payload),
              deletionId: original.deletionSnapshotId ?? undefined,
              deletionPatch: { state: 'synced', lastError: null, updatedAt: Date.now() },
            }, scope))) return summarize();
            acknowledged++;
            remainingIds.delete(original.id);
            break;
          }

          if (!baselineRevision) {
            const remote = await selectRemoteRow(tableName, original.recordId, userId, scope);
            if (remote === SCOPE_INVALIDATED) return summarize();
            const conflict = conflictMeta(
              original.storeName, original.recordId, userId,
              original.payload, remote, 'No stored server baseline for delete', meta
            );
            if (!(await commitOutcome(db, {
              queueEntry: {
                ...original,
                state: 'conflict',
                lastError: conflict.lastError ?? 'Delete conflict',
                lastAttemptAt: Date.now(),
              },
              meta: conflict,
              deletionId: original.deletionSnapshotId ?? undefined,
              deletionPatch: { state: 'conflict', lastError: conflict.lastError, updatedAt: Date.now() },
            }, scope))) return summarize();
            failed++;
            failedRecordKeys.add(key);
            continue;
          }

          const baselineMs = Date.parse(baselineRevision);
          const nextIso = new Date(
            Number.isFinite(baselineMs) ? Math.max(Date.now(), baselineMs + 1) : Date.now()
          ).toISOString();
          if (!isAuthScopeCurrent(scope)) return summarize();
          const { data, error } = await supabase
            .from(tableName)
            .update({ deleted_at: nowIso, updated_at: nextIso })
            .eq('id', original.recordId)
            .eq('updated_at', baselineRevision)
            .eq('user_id', userId)
            .is('deleted_at', null)
            .select('*');
          if (!isAuthScopeCurrent(scope)) return summarize();
          if (error) throw error;

          if (!data || data.length === 0) {
            const remote = await selectRemoteRow(tableName, original.recordId, userId, scope);
            if (remote === SCOPE_INVALIDATED) return summarize();
            const conflict = conflictMeta(
              original.storeName, original.recordId, userId,
              original.payload, remote, 'Remote record changed before delete', meta
            );
            if (!(await commitOutcome(db, {
              queueEntry: {
                ...original,
                state: 'conflict',
                lastError: conflict.lastError ?? 'Delete conflict',
                lastAttemptAt: Date.now(),
              },
              meta: conflict,
              deletionId: original.deletionSnapshotId ?? undefined,
              deletionPatch: { state: 'conflict', lastError: conflict.lastError, updatedAt: Date.now() },
            }, scope))) return summarize();
            failed++;
            failedRecordKeys.add(key);
            continue;
          }

          if (!(await commitOutcome(db, {
            removeQueueId: original.id,
            meta: metaForRemote(original.storeName, data[0] as RemoteRow, userId, original.payload),
            deletionId: original.deletionSnapshotId ?? undefined,
            deletionPatch: { state: 'synced', lastError: null, updatedAt: Date.now() },
          }, scope))) return summarize();
          acknowledged++;
          remainingIds.delete(original.id);
          break;
        }
      }
    } catch (err) {
      // A stale generation is cancellation, never a retry/blocked outcome.
      if (!isAuthScopeCurrent(scope)) return summarize();
      const retryCount = original.retryCount + 1;
      const next: SyncQueueEntry = {
        ...original,
        retryCount,
        state: retryCount >= SYNC_RETRY_PAUSE_THRESHOLD ? 'blocked' : 'pending',
        lastError: errorText(err),
        lastAttemptAt: Date.now(),
      };
      if (!(await commitOutcome(db, {
        queueEntry: next,
        meta: meta
          ? { ...meta, state: next.state, lastError: next.lastError ?? null, lastAttemptAt: next.lastAttemptAt ?? null, updatedAt: Date.now() }
          : undefined,
      }, scope))) return summarize();
      failed++;
      failedRecordKeys.add(key);
      console.warn('[Sync] Entry retained after failure:', original.id, next.lastError);
    }
  }

  return summarize();
}

// ============================================================
// Pull — merge remote state without losing local work
// ============================================================

function localChangedSinceBaseline(meta: SyncMetaEntry | undefined, local: unknown): boolean {
  if (!meta || meta.localUpdatedAt == null) return false;
  const current = localUpdatedAt(local);
  if (current == null) return false;
  return current !== meta.localUpdatedAt;
}

function remoteChangedSinceBaseline(
  meta: SyncMetaEntry | undefined,
  remote: RemoteRow
): boolean {
  if (!meta?.baselineRevision) return true;
  return serverRevision(remote) !== meta.baselineRevision;
}

/**
 * Pull all remote records for a store and merge into local IDB.
 *
 * Records with pending local work are never overwritten or deleted. When both
 * sides changed, local and remote versions are preserved in `syncMeta` and the
 * affected queue entries are marked `conflict`.
 *
 * Direct callers are authorized only for the exact scope captured from the
 * active identity (same user, same generation, matching owner marker). The
 * supplied user ID narrows that scope; it never widens it.
 */
export async function pullStore(storeName: string, userId: string): Promise<boolean> {
  if (!supabase) return false;
  const scope = captureAuthScope();
  if (!scope || scope.userId !== userId) return false;
  return pullStoreForScope(storeName, userId, scope);
}

/**
 * Perform one pull under an already-authorized scope. `backgroundSync` passes
 * the token captured at cycle entry so A → signed out → A cannot recapture a
 * fresh generation and revive old work.
 */
async function pullStoreForScope(
  storeName: string,
  userId: string,
  scope: AuthScope
): Promise<boolean> {
  if (!supabase) return false;
  if (!isAuthScopeCurrent(scope) || scope.userId !== userId) return false;

  const tableName = storeNameToTable(storeName);
  const { data: remoteRecords, error } = await supabase
    .from(tableName)
    .select('*')
    .eq('user_id', userId);

  // The response was authorized for the generation captured before the
  // request. A sign-out, account switch, or same-user re-login that happened
  // while it was in flight makes it stale — including an empty snapshot.
  if (!isAuthScopeCurrent(scope)) return false;
  if (error) {
    console.error(`[Sync] Failed to pull ${storeName}:`, error);
    return false;
  }
  if (!remoteRecords || remoteRecords.length === 0) return true;

  const db = await getDB();
  if (!isAuthScopeCurrent(scope)) return false;

  // The remote snapshot above was fetched over the network, outside any IDB
  // transaction. Every decision below must be made from state read inside the
  // same readwrite transaction that applies the merge, otherwise a local
  // mutation committed after a separate pre-merge read could be overwritten
  // (or a local delete resurrected) from stale queue/meta/local maps.
  //
  // backgroundSync only passes the known DATA_STORES list.
  const dataStoreName = storeName as (typeof STORES)[keyof typeof STORES];
  const tx = db.transaction(
    [dataStoreName, STORES.SYNC_QUEUE, STORES.SYNC_META, STORES.SYNC_DELETIONS],
    'readwrite'
  );
  // An operation failure rejects before `tx.done` is awaited; handle the
  // rejection here so it cannot surface as unhandled, while the original
  // error (or the later `tx.done` rejection) still propagates to the caller.
  void tx.done.catch(() => {});

  // Invalidation may land between the preflight above and this registration;
  // registerAuthTransaction aborts synchronously in that case.
  let cancelled = false;
  const release = registerAuthTransaction(scope, {
    abort: () => {
      cancelled = true;
      try {
        tx.abort();
      } catch {
        // The transaction already settled; nothing left to cancel.
      }
    },
  });

  try {
    if (cancelled || !isAuthScopeCurrent(scope)) {
      try {
        tx.abort();
      } catch {
        // Already aborted by the registration callback.
      }
      return false;
    }

    const localStore = tx.objectStore(dataStoreName) as unknown as {
      getAll(): Promise<unknown[]>;
      put(value: unknown): Promise<unknown>;
      delete(key: string): Promise<void>;
    };
    const metaStore = tx.objectStore(STORES.SYNC_META);
    const queueStore = tx.objectStore(STORES.SYNC_QUEUE);
    const deletionStore = tx.objectStore(STORES.SYNC_DELETIONS);
    const [localRecords, allEntries, metaRows] = await Promise.all([
      localStore.getAll(),
      queueStore.getAll(),
      metaStore.index('byStoreName').getAll(storeName),
    ]);

    // The reads above are the last await before decisions; a transition at
    // any point during them aborts this transaction.
    if (cancelled || !isAuthScopeCurrent(scope)) {
      try {
        tx.abort();
      } catch {
        // Already aborted by the registration callback.
      }
      return false;
    }

    const queueByRecord = new Map<string, SyncQueueEntry[]>();
    for (const entry of allEntries) {
      if (entry.storeName !== storeName) continue;
      const list = queueByRecord.get(entry.recordId) ?? [];
      list.push(entry);
      queueByRecord.set(entry.recordId, list);
    }
    const metaByRecord = new Map<string, SyncMetaEntry>();
    for (const meta of metaRows) metaByRecord.set(meta.recordId, meta);

    const remoteMap = new Map<string, RemoteRow>();
    for (const remote of remoteRecords) {
      remoteMap.set(String(remote.id), remote as RemoteRow);
    }

    const toWrite: Record<string, unknown>[] = [];
    const toDeleteIds: string[] = [];

    const markConflict = async (
      local: Record<string, unknown>,
      remote: RemoteRow | null,
      reason: string,
      pending: SyncQueueEntry[]
    ): Promise<void> => {
      const recordId = String(local.id);
      const previous = metaByRecord.get(recordId);
      await metaStore.put(
        conflictMeta(storeName, recordId, userId, local, remote, reason, previous)
      );
      for (const entry of pending) {
        if (entry.state === 'conflict') continue;
        await queueStore.put({
          ...entry,
          state: 'conflict',
          lastError: reason,
          lastAttemptAt: Date.now(),
        } satisfies SyncQueueEntry);
      }
    };

    for (const localRecord of localRecords) {
      const local = localRecord as unknown as Record<string, unknown>;
      const recordId = String(local.id);
      const remote = remoteMap.get(recordId);
      const pending = queueByRecord.get(recordId) ?? [];
      const meta = metaByRecord.get(recordId);
      const hasPending = pending.length > 0;

      if (!remote) {
        if (hasPending) {
          if (!meta) {
            await metaStore.put({
              id: recordKey(storeName, recordId),
              storeName,
              recordId,
              ownerId: userId,
              baseline: null,
              baselineRevision: null,
              localUpdatedAt: localUpdatedAt(local),
              state: 'pending',
              conflict: null,
              lastError: null,
              lastAttemptAt: null,
              updatedAt: Date.now(),
            } satisfies SyncMetaEntry);
          }
          toWrite.push(local);
          continue;
        }
        if (meta?.baselineRevision) {
          // The remote row vanished without a known local mutation. Keep both.
          await markConflict(local, null, 'Remote record disappeared since the last baseline', pending);
          toWrite.push(local);
          continue;
        }
        // Local-only record with unproven ownership: preserve, never upload.
        await metaStore.put({
          id: recordKey(storeName, recordId),
          storeName,
          recordId,
          ownerId: null,
          baseline: null,
          baselineRevision: null,
          localUpdatedAt: localUpdatedAt(local),
          state: 'quarantined',
          conflict: null,
          lastError: 'No remote record proved ownership of this local record',
          lastAttemptAt: null,
          updatedAt: Date.now(),
        } satisfies SyncMetaEntry);
        toWrite.push(local);
        continue;
      }

      if (
        !hasPending &&
        (meta?.state === 'conflict' || meta?.state === 'quarantined' || meta?.state === 'blocked')
      ) {
        // An unresolved record is never auto-resolved or overwritten by pull.
        remoteMap.delete(recordId);
        toWrite.push(local);
        continue;
      }

      if (remote.deleted_at) {
        if (hasPending || localChangedSinceBaseline(meta, local) || !meta?.baselineRevision) {
          await markConflict(local, remote, 'Remote tombstone conflicts with local data', pending);
          remoteMap.delete(recordId);
          toWrite.push(local);
          continue;
        }
        // Recoverable deletion: archive the local copy, then remove it.
        await deletionStore.add({
          id: `${storeName}:remote-tombstone:${recordId}:${Date.now()}`,
          storeName,
          recordId,
          payload: local,
          deletedAt: Date.now(),
          ownerId: meta?.ownerId ?? userId,
          state: 'archived',
          reason: 'remote-tombstone',
          baselineRevision: meta?.baselineRevision ?? null,
          lastError: null,
          updatedAt: Date.now(),
        } satisfies SyncDeletionSnapshot);
        metaByRecord.delete(recordId);
        await metaStore.delete(recordKey(storeName, recordId));
        remoteMap.delete(recordId);
        toDeleteIds.push(recordId);
        continue;
      }

      if (hasPending) {
        if (remoteChangedSinceBaseline(meta, remote)) {
          await markConflict(local, remote, 'Remote changed while local changes are pending', pending);
        }
        remoteMap.delete(recordId);
        toWrite.push(local);
        continue;
      }

      if (!meta) {
        // First time we see this remote row. Only adopt a local row when its
        // content is identical; otherwise both versions are preserved.
        if (matchesIntendedRemote(storeName, local, remote)) {
          const clean = metaForRemote(storeName, remote, userId, local);
          metaByRecord.set(recordId, clean);
          await metaStore.put(clean);
          toWrite.push(local);
        } else {
          await markConflict(local, remote, 'No synchronization baseline for this local record', pending);
          toWrite.push(local);
        }
        remoteMap.delete(recordId);
        continue;
      }

      const remoteChanged = remoteChangedSinceBaseline(meta, remote);
      const localChanged = localChangedSinceBaseline(meta, local);

      if (remoteChanged && localChanged) {
        await markConflict(local, remote, 'Both local and remote records changed', pending);
        toWrite.push(local);
      } else if (remoteChanged) {
        const adopted = remoteToLocalRecord(storeName, remote);
        const clean = metaForRemote(storeName, remote, userId, adopted);
        metaByRecord.set(recordId, clean);
        await metaStore.put(clean);
        toWrite.push(adopted);
      } else if (localChanged) {
        await markConflict(local, remote, 'Local record changed without a queued mutation', pending);
        toWrite.push(local);
      } else {
        const clean: SyncMetaEntry = {
          ...meta,
          ownerId: userId,
          state: 'clean',
          conflict: null,
          lastError: null,
          lastAttemptAt: null,
          updatedAt: Date.now(),
        };
        metaByRecord.set(recordId, clean);
        await metaStore.put(clean);
        toWrite.push(local);
      }

      remoteMap.delete(recordId);
    }

    // Remaining remote rows are new to this device — unless a local mutation is
    // still pending. A pending delete must never be undone by a pull.
    for (const [recordId, remote] of remoteMap.entries()) {
      const pending = queueByRecord.get(recordId) ?? [];
      if (pending.length > 0) {
        const meta = metaByRecord.get(recordId);
        if (!remote.deleted_at && remoteChangedSinceBaseline(meta, remote)) {
          await markConflict(
            (pending[0].payload as Record<string, unknown> | null) ?? { id: recordId },
            remote,
            'Remote changed while a local mutation is pending',
            pending
          );
        }
        continue;
      }
      if (remote.deleted_at) continue;
      const adopted = remoteToLocalRecord(storeName, remote);
      const clean = metaForRemote(storeName, remote, userId, adopted);
      metaByRecord.set(recordId, clean);
      await metaStore.put(clean);
      toWrite.push(adopted);
    }

    for (const id of toDeleteIds) {
      await localStore.delete(id);
    }
    for (const record of toWrite) {
      await localStore.put(record);
    }

    // Success is only reported after the atomic merge commits AND the
    // authorizing generation is still current. An abort, rollback, or a
    // transition during the commit is a cancellation, never a success.
    await tx.done;
    if (cancelled || !isAuthScopeCurrent(scope)) return false;
    return true;
  } catch (err) {
    // An aborted merge is a cancellation, not a sync failure: retain local
    // work and withhold acknowledgment. Other errors still propagate.
    if (cancelled || !isAuthScopeCurrent(scope)) return false;
    throw err;
  } finally {
    release();
  }
}

// ============================================================
// Orchestration
// ============================================================

// Module-level guard — prevents concurrent sync cycles from compounding
// retry storms (e.g. mount + online event + manual "Sync now" at the same time).
let syncInFlight = false;

/**
 * Run a full sync cycle: push local changes, then pull fresh data.
 * `last_sync_time` advances only when every store reconciled and no
 * pending/blocked/conflicting/quarantined work remains.
 */
export async function backgroundSync(): Promise<boolean> {
  if (!supabase || syncInFlight) return false;

  // Capture before the first await so the whole cycle is tied to the identity
  // generation that authorized it. A re-login as the same user is a new
  // generation and must not revive this cycle.
  const scope = captureAuthScope();
  if (!scope) return false;
  syncInFlight = true;

  try {
    let userId: string | null = null;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      userId = user?.id ?? null;
    } catch (err) {
      console.warn('[Sync] Unable to resolve account for background sync:', errorText(err));
      return false;
    }
    if (!userId) return false;
    if (!isAuthScopeCurrent(scope) || scope.userId !== userId) return false;

    // 0. Migrate any legacy slug IDs to proper UUIDs before syncing.
    await ensureUuids();
    if (!isAuthScopeCurrent(scope)) return false;

    // 1. Push local changes with the exact token captured at cycle entry.
    const push = await processSyncQueueForScope(scope);
    if (!isAuthScopeCurrent(scope)) return false;

    // 2. Pull fresh data for all stores with the same cycle token. A stale
    //    pull rejects its merge transaction and returns false; it never
    //    recaptures the current generation.
    let pullOk = true;
    for (const store of DATA_STORES) {
      if (!isAuthScopeCurrent(scope)) return false;
      try {
        const ok = await pullStoreForScope(store, userId, scope);
        if (!ok) pullOk = false;
      } catch (err) {
        pullOk = false;
        console.error(`[Sync] Pull failed for ${store}:`, err);
      }
    }
    if (!isAuthScopeCurrent(scope)) return false;

    const status = await getSyncStatus();
    if (!isAuthScopeCurrent(scope)) return false;
    const fullyReconciled =
      push.remaining === 0 &&
      push.failed === 0 &&
      pullOk &&
      status.queue === 0 &&
      status.unresolved === 0;

    try {
      if (fullyReconciled) {
        localStorage.setItem('last_sync_time', Date.now().toString());
        localStorage.setItem('sync_last_attempt_failed', '0');
      } else {
        localStorage.setItem('sync_last_attempt_failed', '1');
      }
    } catch { /* ignore */ }

    // Fresh remote data may be available even when some local work is paused.
    if (pullOk) {
      window.dispatchEvent(new CustomEvent('sync-complete'));
    }
    window.dispatchEvent(new CustomEvent('sync-status-changed'));
    return fullyReconciled;
  } catch (err) {
    if (!isAuthScopeCurrent(scope)) return false;
    console.error('[Sync] background sync failed:', err);
    try { localStorage.setItem('sync_last_attempt_failed', '1'); } catch { /* ignore */ }
    return false;
  } finally {
    syncInFlight = false;
  }
}

// ============================================================
// Status / recovery
// ============================================================

export interface SyncStatus {
  /** Total outbox rows, regardless of state. */
  queue: number;
  /** Work eligible for the next automatic attempt. */
  pending: number;
  /** Paused after repeated transient failures. */
  blocked: number;
  /** Conflicting local/remote versions awaiting a user decision. */
  conflict: number;
  /** Unowned legacy work that is never auto-replayed. */
  quarantined: number;
  /** Entries that have failed at least once. */
  failed: number;
  /** Any state that prevents claiming a complete sync. */
  unresolved: number;
  lastSyncAt: number | null;
  /** True when the most recent sync attempt had a push/pull failure. */
  lastAttemptFailed: boolean;
  /** True only when everything reconciled with no unresolved work. */
  canClaimSynced: boolean;
}

/**
 * Derive user-facing sync status from the outbox and conflict metadata.
 * An empty queue alone is not enough to claim "Synced".
 */
export async function getSyncStatus(): Promise<SyncStatus> {
  const db = await getDB();
  let entries: SyncQueueEntry[] = [];
  let metaConflicts: SyncMetaEntry[] = [];
  let metaQuarantined: SyncMetaEntry[] = [];
  try {
    entries = await db.getAllFromIndex(STORES.SYNC_QUEUE, 'byTimestamp');
  } catch {
    entries = [];
  }
  try {
    metaConflicts = await db.getAllFromIndex(STORES.SYNC_META, 'byState', 'conflict');
  } catch {
    metaConflicts = [];
  }
  try {
    metaQuarantined = await db.getAllFromIndex(STORES.SYNC_META, 'byState', 'quarantined');
  } catch {
    metaQuarantined = [];
  }

  const pending = entries.filter((entry) => entry.state === 'pending').length;
  const blocked = entries.filter((entry) => entry.state === 'blocked').length;
  const failed = entries.filter(
    (entry) => entry.retryCount > 0 || entry.state === 'blocked'
  ).length;

  const conflictKeys = new Set<string>();
  const quarantinedKeys = new Set<string>();
  for (const entry of entries) {
    if (entry.state === 'conflict') {
      conflictKeys.add(recordKey(entry.storeName, entry.recordId));
    }
    if (entry.state === 'quarantined') {
      quarantinedKeys.add(recordKey(entry.storeName, entry.recordId));
    }
  }
  for (const meta of metaConflicts) {
    if (meta.state === 'conflict') {
      conflictKeys.add(recordKey(meta.storeName, meta.recordId));
    }
  }
  for (const meta of metaQuarantined) {
    if (meta.state === 'quarantined') {
      quarantinedKeys.add(recordKey(meta.storeName, meta.recordId));
    }
  }
  const conflict = conflictKeys.size;
  const quarantined = quarantinedKeys.size;
  const unresolved = blocked + quarantined + conflict;

  let lastSyncAt: number | null = null;
  let lastAttemptFailed = false;
  try {
    const raw = localStorage.getItem('last_sync_time');
    if (raw) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) lastSyncAt = parsed;
    }
    lastAttemptFailed = localStorage.getItem('sync_last_attempt_failed') === '1';
  } catch {
    lastSyncAt = null;
  }

  return {
    queue: entries.length,
    pending,
    blocked,
    conflict,
    quarantined,
    failed,
    unresolved,
    lastSyncAt,
    lastAttemptFailed,
    canClaimSynced:
      entries.length === 0 &&
      unresolved === 0 &&
      !lastAttemptFailed &&
      lastSyncAt != null,
  };
}

/**
 * Move paused entries back to `pending` without touching payloads, attempt
 * counts, conflicts, quarantine state, or archives. Used by the retry button.
 */
export async function retrySyncWork(): Promise<number> {
  const db = await getDB();
  const entries = await db.getAllFromIndex(STORES.SYNC_QUEUE, 'byTimestamp');
  const tx = db.transaction(STORES.SYNC_QUEUE, 'readwrite');
  let retried = 0;
  for (const entry of entries) {
    if (entry.state === 'blocked') {
      await tx.store.put({ ...entry, state: 'pending' } satisfies SyncQueueEntry);
      retried++;
    }
  }
  await tx.done;
  return retried;
}

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
