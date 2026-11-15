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
  processSyncQueue,
  pullStore,
  retryPausedEntries,
} from './sync';
import {
  enqueueSyncEntry,
  getDB,
  getSyncQueueCount,
  putDatasetReplacementMarker,
} from './idb';

const USER = 'user-1';
const GENERATION = 3;

interface MockState {
  failWrites: boolean;
  pulls: Record<string, Record<string, unknown>[]>;
  upserts: Array<{ table: string; payload: Record<string, unknown> }>;
}

jest.mock('./supabase', () => {
  const state: MockState = { failWrites: false, pulls: {}, upserts: [] };

  function createQuery(table: string) {
    const query = {
      select() { return query; },
      eq() { return query; },
      order() { return query; },
      range() { return query; },
      maybeSingle() { return Promise.resolve({ data: { generation: 3 }, error: null }); },
      update() { return query; },
      upsert(payload: Record<string, unknown>) {
        state.upserts.push({ table, payload });
        return Promise.resolve(
          state.failWrites ? { error: { message: 'network down' } } : { error: null },
        );
      },
      then(
        onfulfilled?: ((value: unknown) => unknown) | null,
        onrejected?: ((reason: unknown) => unknown) | null,
      ) {
        return Promise.resolve({ data: state.pulls[table] ?? [], error: null })
          .then(onfulfilled, onrejected);
      },
    };
    return query;
  }

  return {
    supabase: {
      auth: { getUser: jest.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
      from: jest.fn((table: string) => createQuery(table)),
      rpc: jest.fn(async () => ({ data: { status: 'applied', generation: 3 }, error: null })),
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

beforeEach(async () => {
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  state.failWrites = false;
  state.pulls = {};
  state.upserts = [];
  localStorage.clear();
  localStorage.setItem('lastUserId', USER);
  const db = await getDB();
  await db.clear(STORES.SYNC_QUEUE);
  await db.clear(STORES.SYNC_DELETIONS);
  await db.clear(STORES.BALANCE_SNAPSHOTS);
  await db.clear(STORES.DATASET_MARKERS);
  await putDatasetReplacementMarker(appliedMarker());
});

test('pauses failed work instead of deleting it', async () => {
  await enqueueSyncEntry(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id, 'update', SNAPSHOT);
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
  await enqueueSyncEntry(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id, 'update', SNAPSHOT);
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
  await enqueueSyncEntry(STORES.BALANCE_SNAPSHOTS, SNAPSHOT.id, 'update', SNAPSHOT);
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
