// ============================================================
// outbox-safety.test.ts — failed work is retained, paused and recoverable
//
// Uses fake IndexedDB and the real idb/sync modules; only the Supabase client
// is doubled, so the queue records are the ones the app actually writes.
// ============================================================

import 'fake-indexeddb/auto';

if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (val: unknown) => JSON.parse(JSON.stringify(val));
}

import { STORES } from './constants';
import {
  getFailedSyncCount,
  getSyncFailureSummary,
  processSyncQueue,
  preparePayloadForRemote,
  pullStore,
  resetRevisionProtocolState,
  resolveRevisionBlockedUploads,
  retryPausedEntries,
} from './sync';
import {
  addAccount,
  addCashDenomination,
  deleteCashDenominationsByDate,
  enqueueSyncEntry,
  getDB,
  getSyncQueueCount,
  putDatasetReplacementMarker,
  getSyncBaseline,
  putSyncBaseline,
  resyncAll,
  setActiveDatasetGeneration,
} from './idb';

const USER = 'user-1';
const GENERATION = 3;

interface MockState {
  failWrites: boolean;
  revisionMode: 'absent' | 'applied' | 'replayed' | 'conflict';
  /** Model `prevent_older_update()` skipping the write: return the old row. */
  skipUpdates: boolean;
  /** Accept the write but do not reflect it back (server dropped it). */
  dropWrites: boolean;
  pulls: Record<string, Record<string, unknown>[]>;
  upserts: Array<{ table: string; payload: Record<string, unknown> }>;
}

jest.mock('./supabase', () => {
  const state: MockState = {
    failWrites: false,
    revisionMode: 'absent',
    dropWrites: false,
    skipUpdates: false,
    pulls: {},
    upserts: [],
  };

  function createQuery(table: string) {
    let idFilter: unknown = null;
    let updatePayload: Record<string, unknown> | null = null;
    const filters: Record<string, unknown> = {};
    const query = {
      select() { return query; },
      eq(column: string, value: unknown) {
        if (column === 'id') idFilter = value;
        filters[column] = value;
        return query;
      },
      order() { return query; },
      range() { return query; },
      maybeSingle() { return Promise.resolve({ data: { generation: 3 }, error: null }); },
      update(payload: Record<string, unknown>) {
        updatePayload = payload;
        return query;
      },
      upsert(payload: Record<string, unknown>) {
        state.upserts.push({ table, payload });
        if (state.failWrites) return Promise.resolve({ error: { message: 'network down' } });
        if (state.dropWrites) return Promise.resolve({ error: null });
        // Reflect the write so the client's read-back can observe it.
        const row = { ...(payload as Record<string, unknown>) };
        state.pulls[table] = [
          ...(state.pulls[table] ?? []).filter((item) => item.id !== row.id),
          row,
        ];
        return Promise.resolve({ error: null });
      },
      insert(payload: Record<string, unknown>) {
        state.upserts.push({ table, payload });
        if (state.failWrites) return Promise.resolve({ error: { message: 'network down' } });
        if (state.dropWrites) return Promise.resolve({ error: null });
        const row = { ...(payload as Record<string, unknown>) };
        const exists = (state.pulls[table] ?? []).some((item) => item.id === row.id);
        if (exists) {
          return Promise.resolve({ error: { code: '23505', message: 'duplicate key' } });
        }
        state.pulls[table] = [...(state.pulls[table] ?? []), row];
        return Promise.resolve({ error: null });
      },
      then(
        onfulfilled?: ((value: unknown) => unknown) | null,
        onrejected?: ((reason: unknown) => unknown) | null,
      ) {
        let rows = [...(state.pulls[table] ?? [])];
        // Apply a column filter only when the rows define it; legacy fixtures
        // omit columns the client filters on.
        for (const [column, value] of Object.entries(filters)) {
          if (!rows.some((row) => row[column] !== undefined)) continue;
          rows = rows.filter((row) => row[column] === value);
        }
        if (updatePayload && !state.skipUpdates && rows.length > 0) {
          rows = rows.map((row) => ({ ...row, ...updatePayload }));
          state.pulls[table] = (state.pulls[table] ?? []).map((row) =>
            row.id === idFilter ? { ...row, ...updatePayload } : row,
          );
        }
        return Promise.resolve({ data: rows, error: null }).then(onfulfilled, onrejected);
      },
    };
    return query;
  }

  return {
    supabase: {
      auth: { getUser: jest.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
      from: jest.fn((table: string) => createQuery(table)),
      rpc: jest.fn(async (name: string) => {
        if (name === 'apply_revision_write') {
          if (state.revisionMode === 'absent') {
            return { data: null, error: { code: 'PGRST202', message: 'function not found' } };
          }
          if (state.revisionMode === 'conflict') {
            return { data: { status: 'conflict', revision: 9 }, error: null };
          }
          return { data: { status: state.revisionMode, revision: 5 }, error: null };
        }
        return { data: { status: 'applied', generation: 3 }, error: null };
      }),
      __state: state,
    },
  };
});

import { supabase } from './supabase';

const state = (supabase as unknown as { __state: MockState }).__state;

const SNAPSHOT = {
  id: 'snap-1',
  accountId: 'acct-1',
  date: '2026-01-31',
  actualBalance: 500,
  createdAt: 1,
  updatedAt: 1,
};

function appliedMarker() {
  return {
    userId: USER,
    generation: GENERATION,
    snapshotId: 'snapshot-1',
    status: 'applied' as const,
    snapshot: null,
    remoteGeneration: GENERATION,
    attempts: 0,
    lastError: null,
    updatedAt: Date.now(),
  };
}


function defaultRpcImplementation(name: string, params: Record<string, unknown>) {
  if (name === 'apply_revision_write') {
    if (state.revisionMode === 'absent') {
      return { data: null, error: { code: 'PGRST202', message: 'function not found' } };
    }
    if (state.revisionMode === 'conflict') {
      return { data: { status: 'conflict', revision: 9 }, error: null };
    }
    return { data: { status: state.revisionMode, revision: 5 }, error: null };
  }
  const record = params.p_record as Record<string, unknown> | null;
  return { data: { status: 'applied', generation: 3, record }, error: null };
}

beforeEach(async () => {
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  state.failWrites = false;
  state.revisionMode = 'absent';
  state.dropWrites = false;
  state.skipUpdates = false;
  state.pulls = {};
  state.upserts = [];
  localStorage.clear();
  localStorage.setItem('lastUserId', USER);
  const db = await getDB();
  await db.clear(STORES.SYNC_QUEUE);
  await db.clear(STORES.SYNC_DELETIONS);
  await db.clear(STORES.BALANCE_SNAPSHOTS);
  await db.clear(STORES.DATASET_MARKERS);
  await db.clear(STORES.SYNC_META);
  resetRevisionProtocolState();
  (supabase as unknown as { rpc: jest.Mock }).rpc.mockImplementation(defaultRpcImplementation);
  await putDatasetReplacementMarker(appliedMarker());
});

test('pauses failed work instead of deleting it', async () => {
  await enqueueSyncEntry(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id, 'create', SNAPSHOT);
  state.failWrites = true;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await processSyncQueue(GENERATION);
  }

  const db = await getDB();
  const [entry] = await db.getAll(STORES.SYNC_QUEUE);
  expect(await getSyncQueueCount()).toBe(1);
  expect(entry.state).toBe('paused');
  expect(entry.retryCount).toBe(5);
  expect(entry.payload).toEqual(SNAPSHOT);
  expect(entry.lastError).toContain('network down');
  expect(getFailedSyncCount()).toBe(1);
});

test('an automatic cycle does not retry paused work', async () => {
  await enqueueSyncEntry(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id, 'create', SNAPSHOT);
  state.failWrites = true;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await processSyncQueue(GENERATION);
  }

  state.failWrites = false;
  state.upserts = [];
  await processSyncQueue(GENERATION);

  expect(state.upserts).toHaveLength(0);
  const db = await getDB();
  const [entry] = await db.getAll(STORES.SYNC_QUEUE);
  expect(entry.state).toBe('paused');
});

test('retrying paused work re-arms the same payload and then clears it', async () => {
  await enqueueSyncEntry(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id, 'create', SNAPSHOT);
  state.failWrites = true;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await processSyncQueue(GENERATION);
  }

  expect(await retryPausedEntries()).toBe(1);
  const db = await getDB();
  const [rearmed] = await db.getAll(STORES.SYNC_QUEUE);
  expect(rearmed.state).toBe('pending');
  expect(rearmed.retryCount).toBe(0);
  expect(rearmed.payload).toEqual(SNAPSHOT);
  expect(getFailedSyncCount()).toBe(0);

  state.failWrites = false;
  state.upserts = [];
  await processSyncQueue(GENERATION);

  expect(state.upserts).toHaveLength(1);
  expect(await getSyncQueueCount()).toBe(0);
});

test('a remote tombstone archives the local record before removing it', async () => {
  const db = await getDB();
  await db.put(STORES.BALANCE_SNAPSHOTS, SNAPSHOT);
  state.pulls.balance_snapshots = [
    { ...SNAPSHOT, user_id: USER, deleted_at: '2026-02-01T00:00:00.000Z' },
  ];

  await pullStore(STORES.BALANCE_SNAPSHOTS, USER, GENERATION);

  expect(await db.get(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id)).toBeUndefined();
  const [snapshot] = await db.getAll(STORES.SYNC_DELETIONS);
  expect(snapshot.reason).toBe('remote-tombstone');
  expect(snapshot.recordId).toBe(SNAPSHOT.id);
  expect(snapshot.payload).toEqual(SNAPSHOT);
});

test('a pull keeps a queued row in a non-managed store', async () => {
  const db = await getDB();
  const local = { ...SNAPSHOT, actualBalance: 500, updatedAt: 5 };
  await db.put(STORES.BALANCE_SNAPSHOTS, local);
  await enqueueSyncEntry(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id, 'update', local);
  state.pulls.balance_snapshots = [
    { ...SNAPSHOT, actualBalance: 999, user_id: USER, updated_at: '2026-02-01T00:00:00.000Z' },
  ];

  await pullStore(STORES.BALANCE_SNAPSHOTS, USER, GENERATION);

  const stored = await db.get(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id);
  expect(stored?.actualBalance).toBe(500);
});


test('queued work records its owner at write time', async () => {
  await enqueueSyncEntry(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id, 'update', SNAPSHOT);

  const db = await getDB();
  const [entry] = await db.getAll(STORES.SYNC_QUEUE);
  expect(entry.ownerId).toBe(USER);
  expect(entry.state).toBe('pending');
});

test('work stamped for another account is blocked and never sent', async () => {
  const db = await getDB();
  await db.put(STORES.SYNC_QUEUE, {
    id: 'foreign-entry',
    storeName: STORES.BALANCE_SNAPSHOTS,
    recordId: SNAPSHOT.id,
    operation: 'update',
    payload: SNAPSHOT,
    timestamp: 1,
    retryCount: 0,
    ownerId: 'someone-else',
  });

  await processSyncQueue(GENERATION);

  expect(state.upserts).toHaveLength(0);
  const [entry] = await db.getAll(STORES.SYNC_QUEUE);
  expect(entry.state).toBe('blocked');
  expect(entry.payload).toEqual(SNAPSHOT);
  expect(entry.lastError).toBe('Queued work belongs to a different account');
});

test('unowned work is claimed only when the marker names the signed-in account', async () => {
  await DBLeaveUnownedEntry();
  await processSyncQueue(GENERATION);

  // Adoption claims the entry, the push acknowledges it, and the payload is sent.
  expect(state.upserts).toHaveLength(1);
  expect(await getSyncQueueCount()).toBe(0);
});

async function DBLeaveUnownedEntry(): Promise<void> {
  const db = await getDB();
  await db.put(STORES.SYNC_QUEUE, {
    id: 'legacy-entry',
    storeName: STORES.BALANCE_SNAPSHOTS,
    recordId: SNAPSHOT.id,
    operation: 'create',
    payload: SNAPSHOT,
    timestamp: 1,
    retryCount: 0,
  });
}

test('a write the server does not persist is not acknowledged', async () => {
  await enqueueSyncEntry(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id, 'create', SNAPSHOT);
  state.dropWrites = true;

  await processSyncQueue(GENERATION);

  expect(await getSyncQueueCount()).toBe(1);
  const [entry] = await getDB().then((db) => db.getAll(STORES.SYNC_QUEUE));
  expect(entry.lastError).toMatch(/did not confirm|did not persist/);
  expect(entry.state).not.toBe('blocked');
});

test('a successful write records the server revision as the next baseline', async () => {
  await enqueueSyncEntry(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id, 'create', SNAPSHOT);

  await processSyncQueue(GENERATION);

  const persisted = state.pulls.balance_snapshots.find((row) => row.id === SNAPSHOT.id);
  const baseline = await getSyncBaseline(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id);
  expect(baseline?.baselineRevision).toBe(persisted?.updated_at ?? persisted?.created_at);
  expect(await getSyncQueueCount()).toBe(0);
});

test('a changed remote revision blocks the edit instead of overwriting it', async () => {
  await putSyncBaseline(
    STORES.BALANCE_SNAPSHOTS,
    SNAPSHOT.id,
    USER,
    '2026-03-01T00:00:00.000Z',
  );
  await enqueueSyncEntry(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id, 'update', SNAPSHOT);
  state.pulls.balance_snapshots = [
    { id: SNAPSHOT.id, user_id: USER, updated_at: '2026-04-01T00:00:00.000Z' },
  ];

  await processSyncQueue(GENERATION);

  expect(await getSyncQueueCount()).toBe(1);
  const [entry] = await getDB().then((db) => db.getAll(STORES.SYNC_QUEUE));
  expect(entry.state).toBe('blocked');
  expect(entry.lastError).toContain('changed since the recorded baseline');
  expect(entry.payload).toEqual(SNAPSHOT);
});

test('a pull records the observed revision but leaves queued rows on the old baseline', async () => {
  const db = await getDB();
  await db.put(STORES.BALANCE_SNAPSHOTS, SNAPSHOT);
  state.pulls.balance_snapshots = [
    { id: SNAPSHOT.id, user_id: USER, actualBalance: 500, updated_at: '2026-05-01T00:00:00.000Z' },
  ];

  await pullStore(STORES.BALANCE_SNAPSHOTS, USER, GENERATION);
  const plain = await getSyncBaseline(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id);
  expect(plain?.baselineRevision).toBe('2026-05-01T00:00:00.000Z');

  const queued = { ...SNAPSHOT, actualBalance: 777, updatedAt: 9 };
  await db.put(STORES.BALANCE_SNAPSHOTS, queued);
  await enqueueSyncEntry(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id, 'update', queued);
  state.pulls.balance_snapshots = [
    { id: SNAPSHOT.id, user_id: USER, actualBalance: 999, updated_at: '2026-06-01T00:00:00.000Z' },
  ];

  await pullStore(STORES.BALANCE_SNAPSHOTS, USER, GENERATION);
  const kept = await getSyncBaseline(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id);
  expect(kept?.baselineRevision).toBe('2026-05-01T00:00:00.000Z');
});

test('resync re-enqueues missing work without discarding queued entries', async () => {
  const db = await getDB();
  const account = {
    id: 'acct-resync',
    name: 'Resync',
    startingBalance: 0,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  await db.put(STORES.ACCOUNTS, account);
  await db.put(STORES.SYNC_QUEUE, {
    id: 'paused-entry',
    storeName: STORES.BALANCE_SNAPSHOTS,
    recordId: 'gone',
    operation: 'delete',
    payload: { id: 'gone' },
    timestamp: 1,
    retryCount: 5,
    ownerId: USER,
    state: 'paused',
  });

  const result = await resyncAll();

  const entries = await db.getAll(STORES.SYNC_QUEUE);
  expect(result.enqueued).toBe(1);
  expect(entries).toHaveLength(2);
  const preserved = entries.find((entry) => entry.id === 'paused-entry');
  expect(preserved?.state).toBe('paused');
  expect(preserved?.payload).toEqual({ id: 'gone' });
  expect(entries.some((entry) => entry.storeName === STORES.ACCOUNTS)).toBe(true);
});


test('a real account create stamps the owning account on the queued entry', async () => {
  await addAccount({ name: 'Ownership fixture', startingBalance: 0, sortOrder: 0 });

  const entries = await getDB().then((db) => db.getAll(STORES.SYNC_QUEUE));
  const entry = entries.find((item) => item.storeName === STORES.ACCOUNTS);
  expect(entry?.ownerId).toBe(USER);
  expect(entry?.state).toBe('pending');
});

test('a cash deletion follows the managed RPC path', async () => {
  // Managed entries are fenced to the applied dataset generation.
  setActiveDatasetGeneration(GENERATION);
  await addCashDenomination({ date: '2026-01-02', denomination: 100, count: 1 });
  await deleteCashDenominationsByDate('2026-01-02');

  const rpcCalls: string[] = [];
  (supabase as unknown as { rpc: jest.Mock }).rpc.mockImplementation(
    async (name: string, params: Record<string, unknown>) => {
      rpcCalls.push(`${name}:${String(params.p_store)}:${String(params.p_operation)}`);
      const record = params.p_record as Record<string, unknown> | null;
      if (record) {
        state.pulls.cash_denominations = [
          ...(state.pulls.cash_denominations ?? []).filter((row) => row.id !== record.id),
          record,
        ];
      } else {
        state.pulls.cash_denominations = (state.pulls.cash_denominations ?? []).map((row) =>
          row.id === params.p_record_id
            ? { ...row, deleted_at: '2026-01-03T00:00:00.000Z' }
            : row,
        );
      }
      return { data: { status: 'applied', generation: 3 }, error: null };
    },
  );

  await processSyncQueue(GENERATION);

  expect(rpcCalls).toContain('apply_managed_write:cash_denominations:delete');
  expect(await getSyncQueueCount()).toBe(0);
  setActiveDatasetGeneration(0);
});

test('an update with no baseline blocks instead of overwriting the remote row', async () => {
  await enqueueSyncEntry(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id, 'update', SNAPSHOT);
  state.pulls.balance_snapshots = [
    { id: SNAPSHOT.id, user_id: USER, actualBalance: 999, updated_at: '2026-07-01T00:00:00.000Z' },
  ];

  await processSyncQueue(GENERATION);

  expect(state.upserts).toHaveLength(0);
  const [entry] = await getDB().then((db) => db.getAll(STORES.SYNC_QUEUE));
  expect(entry.state).toBe('blocked');
  expect(entry.blockReason).toBe('revision');
  expect(entry.lastError).toContain('No recorded baseline');
  expect(entry.payload).toEqual(SNAPSHOT);
});

test('a delete with no baseline blocks instead of deleting an arbitrary row', async () => {
  await enqueueSyncEntry(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id, 'delete', SNAPSHOT);
  state.pulls.balance_snapshots = [
    { id: SNAPSHOT.id, user_id: USER, updated_at: '2026-07-01T00:00:00.000Z' },
  ];

  await processSyncQueue(GENERATION);

  const [entry] = await getDB().then((db) => db.getAll(STORES.SYNC_QUEUE));
  expect(entry.state).toBe('blocked');
  expect(entry.lastError).toContain('No recorded baseline for this delete');
});

test('a skipped update is not acknowledged: the stored row differs from the intent', async () => {
  await putSyncBaseline(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id, USER, '2026-07-01T00:00:00.000Z');
  await enqueueSyncEntry(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id, 'update', SNAPSHOT);
  state.pulls.balance_snapshots = [
    { id: SNAPSHOT.id, user_id: USER, actualBalance: 4242, updated_at: '2026-07-01T00:00:00.000Z' },
  ];
  state.skipUpdates = true; // prevent_older_update() keeps the existing row

  await processSyncQueue(GENERATION);

  expect(await getSyncQueueCount()).toBe(1);
  const [entry] = await getDB().then((db) => db.getAll(STORES.SYNC_QUEUE));
  expect(entry.state).toBe('blocked');
  expect(entry.lastError).toContain('different row');
  expect(entry.payload).toEqual(SNAPSHOT);
});

test('the failure badge counts queue state and retry re-arms only pauses', async () => {
  const db = await getDB();
  await db.put(STORES.SYNC_QUEUE, {
    id: 'paused-1', storeName: STORES.BALANCE_SNAPSHOTS, recordId: 'p1', operation: 'create',
    payload: {}, timestamp: 1, retryCount: 5, ownerId: USER, state: 'paused',
  });
  await db.put(STORES.SYNC_QUEUE, {
    id: 'blocked-1', storeName: STORES.BALANCE_SNAPSHOTS, recordId: 'b1', operation: 'update',
    payload: {}, timestamp: 2, retryCount: 0, ownerId: USER, state: 'blocked', blockReason: 'revision',
  });

  expect(await getSyncFailureSummary()).toEqual({ paused: 1, blocked: 1 });
  expect(await retryPausedEntries()).toBe(1);

  const entries = await db.getAll(STORES.SYNC_QUEUE);
  expect(entries.find((entry) => entry.id === 'blocked-1')?.state).toBe('blocked');
  expect(await getSyncFailureSummary()).toEqual({ paused: 0, blocked: 1 });

  // Resolution re-applies the local payload against the current remote row.
  state.pulls.balance_snapshots = [
    { id: 'b1', user_id: USER, updated_at: '2026-08-01T00:00:00.000Z' },
  ];
  expect(await resolveRevisionBlockedUploads()).toBe(1);
  const resolved = await db.get(STORES.SYNC_QUEUE, 'blocked-1');
  expect(resolved?.state).toBe('pending');
  const baseline = await getSyncBaseline(STORES.BALANCE_SNAPSHOTS, 'b1');
  expect(baseline?.baselineRevision).toBe('2026-08-01T00:00:00.000Z');
});

test('server metadata never travels back as business data', () => {
  const outbound = preparePayloadForRemote({
    id: 'row-1',
    revision: 7,
    updatedAt: 1000,
    createdAt: 1000,
  });
  expect(outbound).not.toHaveProperty('revision');
});


test('the revision RPC is used when the server offers it', async () => {
  state.revisionMode = 'applied';
  await enqueueSyncEntry(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id, 'create', SNAPSHOT);

  await processSyncQueue(GENERATION);

  expect(state.upserts).toHaveLength(0); // no direct REST fallback
  expect(await getSyncQueueCount()).toBe(0);
  const baseline = await getSyncBaseline(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id);
  expect(baseline?.revision).toBe(5);
});

test('a replayed revision write is acknowledged once', async () => {
  state.revisionMode = 'replayed';
  await enqueueSyncEntry(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id, 'create', SNAPSHOT);

  await processSyncQueue(GENERATION);

  expect(await getSyncQueueCount()).toBe(0);
  expect((await getSyncBaseline(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id))?.revision).toBe(5);
});

test('a revision conflict blocks the edit and keeps its payload', async () => {
  state.revisionMode = 'conflict';
  await putSyncBaseline(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id, USER, null, 4);
  await enqueueSyncEntry(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id, 'update', SNAPSHOT);

  await processSyncQueue(GENERATION);

  const [entry] = await getDB().then((db) => db.getAll(STORES.SYNC_QUEUE));
  expect(entry.state).toBe('blocked');
  expect(entry.blockReason).toBe('revision');
  expect(entry.payload).toEqual(SNAPSHOT);
});

test('an absent RPC falls back to the proven write path', async () => {
  state.revisionMode = 'absent';
  await enqueueSyncEntry(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id, 'create', SNAPSHOT);

  await processSyncQueue(GENERATION);

  expect(state.upserts).toHaveLength(1);
  expect(await getSyncQueueCount()).toBe(0);
});
