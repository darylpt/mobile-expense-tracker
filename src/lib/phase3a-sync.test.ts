// ============================================================
// phase3a-sync.test.ts — Outbox / pull conflict regressions (Phase 3A)
//
// Uses fake-indexeddb with a mocked Supabase client. No live data is touched.
// ============================================================

import 'fake-indexeddb/auto';

if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (val: unknown) => JSON.parse(JSON.stringify(val));
}

import { DATA_STORES, DB_NAME, LAST_USER_STORAGE_KEY, STORES } from './constants';
import type { SyncQueueEntry, SyncMetaEntry, SyncDeletionSnapshot } from './idb';

interface QueryResult {
  data: unknown[] | null;
  error: unknown;
}

interface MockQuery {
  select: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
  eq: jest.Mock;
  is: jest.Mock;
  limit: jest.Mock;
  then: jest.Mock;
}

const mockSupabase = {
  auth: { getUser: jest.fn() },
  from: jest.fn(),
};

jest.mock('./supabase', () => ({ supabase: mockSupabase }));

function makeQuery(result: QueryResult): MockQuery {
  const query: MockQuery = {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    eq: jest.fn(),
    is: jest.fn(),
    limit: jest.fn(),
    then: jest.fn(),
  };
  query.select.mockReturnValue(query);
  query.insert.mockReturnValue(query);
  query.update.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.is.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.then.mockImplementation(
    (
      onFulfilled?: (value: QueryResult) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) => Promise.resolve(result).then(onFulfilled, onRejected)
  );
  return query;
}

/**
 * A query whose response stays pending until the caller resolves `result`.
 * `started` fires when the implementation awaits the request, which is the
 * point the request is genuinely in flight.
 */
function makeDeferredQuery(
  result: Promise<QueryResult>,
  started: () => void
): MockQuery {
  const query = makeQuery({ data: null, error: null });
  query.then.mockImplementation(
    (
      onFulfilled?: (value: QueryResult) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) => {
      started();
      return result.then(onFulfilled, onRejected);
    }
  );
  return query;
}

function deleteDatabase(): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const request = indexedDB.deleteDatabase(DB_NAME);
  request.onsuccess = () => resolve();
  request.onerror = () => reject(request.error);
  request.onblocked = () => resolve();
  return promise;
}

function makeQueueEntry(overrides: Partial<SyncQueueEntry> = {}): SyncQueueEntry {
  return {
    id: 'queue-1',
    storeName: STORES.TRANSACTIONS,
    recordId: 'tx-1',
    operation: 'update',
    payload: {
      id: 'tx-1',
      amount: 20,
      date: '2026-01-05',
      type: 'expense',
      category: 'Food',
      fromAccount: null,
      toAccount: 'acct-1',
      description: 'local',
      createdAt: 500,
      updatedAt: 1000,
    },
    timestamp: 1,
    retryCount: 0,
    ownerId: 'user-1',
    state: 'pending',
    baseline: { id: 'tx-1', updated_at: '2026-01-01T00:00:00.000Z' },
    baselineRevision: '2026-01-01T00:00:00.000Z',
    deletionSnapshotId: null,
    lastError: null,
    lastAttemptAt: null,
    quarantinedAt: null,
    ...overrides,
  };
}

function makeMeta(overrides: Partial<SyncMetaEntry> = {}): SyncMetaEntry {
  return {
    id: `${STORES.TRANSACTIONS}:tx-1`,
    storeName: STORES.TRANSACTIONS,
    recordId: 'tx-1',
    ownerId: 'user-1',
    baseline: { id: 'tx-1', updated_at: '2026-01-01T00:00:00.000Z' },
    baselineRevision: '2026-01-01T00:00:00.000Z',
    localUpdatedAt: 1000,
    state: 'clean',
    conflict: null,
    lastError: null,
    lastAttemptAt: null,
    updatedAt: 1,
    ...overrides,
  };
}

function makeLocalTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    amount: 20,
    date: '2026-01-05',
    type: 'expense',
    category: 'Food',
    fromAccount: null,
    toAccount: 'acct-1',
    description: 'local',
    createdAt: 500,
    updatedAt: 1000,
    ...overrides,
  };
}

let responses: QueryResult[] = [];

beforeEach(async () => {
  jest.resetModules();
  localStorage.clear();
  localStorage.setItem(LAST_USER_STORAGE_KEY, 'user-1');
  // Must load after resetModules so sync shares this auth-scope instance.
  const authScope = await import('./auth-scope');
  authScope.publishAuthIdentity({
    state: 'authenticated',
    userId: 'user-1',
  });
  await deleteDatabase();
  responses = [];
  mockSupabase.auth.getUser.mockReset();
  mockSupabase.auth.getUser.mockResolvedValue({
    data: { user: { id: 'user-1' } },
  });
  mockSupabase.from.mockReset();
  mockSupabase.from.mockImplementation(() =>
    makeQuery(responses.shift() ?? { data: [], error: null })
  );
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value: true,
  });
});

afterEach(async () => {
  restoreTransactionInterceptor?.();
  for (const connection of secondConnections.splice(0)) {
    try { connection.close(); } catch { /* already closed */ }
  }
  await deleteDatabase();
});

async function setup() {
  const idb = await import('./idb');
  const sync = await import('./sync');
  const db = await idb.getDB();
  return { idb, sync, db };
}

function makeRemoteTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    amount: 20,
    date: '2026-01-05',
    type: 'expense',
    category: 'Food',
    from_account: null,
    to_account: 'acct-1',
    description: 'local',
    created_at: new Date(500).toISOString(),
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    user_id: 'user-1',
    ...overrides,
  };
}

function metaKey(recordId: string): string {
  return `${STORES.TRANSACTIONS}:${recordId}`;
}

function openSecondConnection(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(DB_NAME);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  return promise;
}

/**
 * Queue requests on a second connection synchronously, then resolve once that
 * transaction commits. Callers use this from a transaction interceptor so the
 * write is created before (or after) the pull merge transaction and IndexedDB
 * itself enforces the ordering.
 */
function runRawTransaction(
  db: IDBDatabase,
  storeNames: string[],
  mutate: (tx: IDBTransaction) => void
): Promise<void> {
  const tx = db.transaction(storeNames, 'readwrite');
  mutate(tx);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  return promise;
}

/** True only for pullStore's four-store merge transaction. */
function isPullMergeTransaction(
  storeNames: string[],
  mode: IDBTransactionMode | undefined
): boolean {
  return (
    mode === 'readwrite' &&
    storeNames.includes(STORES.TRANSACTIONS) &&
    storeNames.includes(STORES.SYNC_QUEUE) &&
    storeNames.includes(STORES.SYNC_META) &&
    storeNames.includes(STORES.SYNC_DELETIONS)
  );
}

let restoreTransactionInterceptor: (() => void) | null = null;

/**
 * One-shot interception of IDBDatabase.prototype.transaction. `beforeCreate`
 * runs synchronously before the matching transaction is created (so writes it
 * queues are ordered ahead of the merge); `afterCreate` runs after the
 * matching transaction exists (so writes it queues are ordered behind it).
 */
function interceptTransactions(options: {
  match: (storeNames: string[], mode?: IDBTransactionMode) => boolean;
  beforeCreate?: () => void;
  afterCreate?: (tx: IDBTransaction) => void;
}): void {
  restoreTransactionInterceptor?.();
  const proto = IDBDatabase.prototype;
  const original = proto.transaction;
  let fired = false;
  proto.transaction = function (
    this: IDBDatabase,
    storeNames: string | string[],
    mode?: IDBTransactionMode,
    txOptions?: IDBTransactionOptions
  ): IDBTransaction {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const matched = !fired && options.match(names, mode);
    if (matched) {
      fired = true;
      options.beforeCreate?.();
    }
    const tx = original.call(this, storeNames, mode, txOptions);
    if (matched) options.afterCreate?.(tx);
    return tx;
  };
  restoreTransactionInterceptor = () => {
    proto.transaction = original;
    restoreTransactionInterceptor = null;
  };
}

const secondConnections: IDBDatabase[] = [];

async function setupSecondConnection(): Promise<IDBDatabase> {
  const connection = await openSecondConnection();
  secondConnections.push(connection);
  return connection;
}

// ---------------------------------------------------------------------------
// Push: retry preservation
// ---------------------------------------------------------------------------

describe('outbox retry preservation', () => {
  it('keeps failed entries and pauses after the retry threshold without deleting them', async () => {
    const { sync, db } = await setup();
    await db.put(STORES.SYNC_QUEUE, makeQueueEntry({ operation: 'create' }));

    mockSupabase.from.mockImplementation(() =>
      makeQuery({ data: null, error: { message: 'network down' } })
    );

    for (let attempt = 0; attempt < 5; attempt++) {
      await sync.processSyncQueue('user-1');
    }

    const queue = await db.getAll(STORES.SYNC_QUEUE);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      state: 'blocked',
      retryCount: 5,
      lastError: 'network down',
    });
    expect(queue[0].payload).toMatchObject({ id: 'tx-1' });
    db.close();
  });

  it('does not send or adopt legacy entries with unknown ownership', async () => {
    const { sync, db } = await setup();
    await db.put(
      STORES.SYNC_QUEUE,
      makeQueueEntry({ ownerId: null, state: 'pending' })
    );

    await sync.processSyncQueue('user-1');

    expect(mockSupabase.from).not.toHaveBeenCalled();
    const queue = await db.getAll(STORES.SYNC_QUEUE);
    expect(queue[0]).toMatchObject({ ownerId: null, state: 'quarantined' });
    db.close();
  });

  it('blocks entries owned by a different account instead of stamping the current user', async () => {
    const { sync, db } = await setup();
    await db.put(STORES.SYNC_QUEUE, makeQueueEntry({ ownerId: 'user-2' }));

    await sync.processSyncQueue('user-1');

    expect(mockSupabase.from).not.toHaveBeenCalled();
    const queue = await db.getAll(STORES.SYNC_QUEUE);
    expect(queue[0]).toMatchObject({
      ownerId: 'user-2',
      state: 'blocked',
    });
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Push: auth invalidation while a request is in flight
// ---------------------------------------------------------------------------

describe('push across auth invalidation', () => {
  it('does not acknowledge a create whose success response arrives after sign-out', async () => {
    const { sync, db } = await setup();
    try {
      // Imported after jest.resetModules so this is the same auth-scope instance
      // the sync module will share; a static import would predate the reset.
      const authScope = await import('./auth-scope');

      localStorage.setItem(LAST_USER_STORAGE_KEY, 'user-1');
      authScope.publishAuthIdentity({
        state: 'authenticated',
        userId: 'user-1',
      });

      const entry = makeQueueEntry({ operation: 'create' });
      await db.put(STORES.SYNC_QUEUE, entry);

      const insert = Promise.withResolvers<QueryResult>();
      const requestStarted = Promise.withResolvers<void>();
      mockSupabase.from.mockImplementation(() =>
        makeDeferredQuery(insert.promise, () => requestStarted.resolve())
      );

      const run = sync.processSyncQueue('user-1');
      await requestStarted.promise;

      // Sign-out lands while the create is still awaiting its response.
      authScope.publishAuthIdentity({ state: 'unauthenticated' });

      insert.resolve({
        data: [
          makeRemoteTransaction({ updated_at: new Date(1000).toISOString() }),
        ],
        error: null,
      });
      await run;

      // The stale success must not settle the outbox or record an acknowledgment.
      const queue = await db.getAll(STORES.SYNC_QUEUE);
      expect(queue).toHaveLength(1);
      expect(queue[0]).toEqual(entry);
      expect(queue[0].retryCount).toBe(entry.retryCount);
      expect(await db.get(STORES.SYNC_META, metaKey('tx-1'))).toBeUndefined();

      // No readback and no retry: exactly the one insert that was in flight.
      const query = mockSupabase.from.mock.results[0]?.value as MockQuery;
      expect(mockSupabase.from).toHaveBeenCalledTimes(1);
      expect(query.insert).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it('does not turn a network error arriving after sign-out into retry or blocked work', async () => {
    const { sync, db } = await setup();
    try {
      const authScope = await import('./auth-scope');
      localStorage.setItem(LAST_USER_STORAGE_KEY, 'user-1');
      authScope.publishAuthIdentity({
        state: 'authenticated',
        userId: 'user-1',
      });

      const entry = makeQueueEntry({ operation: 'create' });
      await db.put(STORES.SYNC_QUEUE, entry);

      const insert = Promise.withResolvers<QueryResult>();
      const requestStarted = Promise.withResolvers<void>();
      mockSupabase.from.mockImplementation(() =>
        makeDeferredQuery(insert.promise, () => requestStarted.resolve())
      );

      const run = sync.processSyncQueue('user-1');
      await requestStarted.promise;

      authScope.publishAuthIdentity({ state: 'unauthenticated' });
      insert.resolve({ data: null, error: { message: 'network down' } });
      await run;

      const queue = await db.getAll(STORES.SYNC_QUEUE);
      expect(queue).toHaveLength(1);
      expect(queue[0]).toEqual(entry);
      expect(queue[0].retryCount).toBe(0);
      expect(queue[0].state).toBe('pending');
      expect(await db.get(STORES.SYNC_META, metaKey('tx-1'))).toBeUndefined();
      expect(mockSupabase.from).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it('refuses direct push when the owner marker is missing or mismatched', async () => {
    const { sync, db } = await setup();
    try {
      const entry = makeQueueEntry({ operation: 'create' });
      await db.put(STORES.SYNC_QUEUE, entry);

      localStorage.removeItem(LAST_USER_STORAGE_KEY);
      await sync.processSyncQueue('user-1');
      expect(mockSupabase.from).not.toHaveBeenCalled();

      localStorage.setItem(LAST_USER_STORAGE_KEY, 'user-2');
      await sync.processSyncQueue('user-1');
      expect(mockSupabase.from).not.toHaveBeenCalled();

      // A supplied user ID cannot widen the captured scope either.
      localStorage.setItem(LAST_USER_STORAGE_KEY, 'user-1');
      await sync.processSyncQueue('user-2');
      expect(mockSupabase.from).not.toHaveBeenCalled();

      const queue = await db.getAll(STORES.SYNC_QUEUE);
      expect(queue).toHaveLength(1);
      expect(queue[0]).toEqual(entry);
    } finally {
      db.close();
    }
  });

  it('stops a background cycle before pull, status, and events when push is invalidated', async () => {
    const { sync, db } = await setup();
    try {
      localStorage.setItem('uuid_migration_done', '1');
      const authScope = await import('./auth-scope');

      const entry = makeQueueEntry({ operation: 'create' });
      await db.put(STORES.SYNC_QUEUE, entry);

      const insert = Promise.withResolvers<QueryResult>();
      const requestStarted = Promise.withResolvers<void>();
      mockSupabase.from.mockImplementation(() =>
        makeDeferredQuery(insert.promise, () => requestStarted.resolve())
      );

      const completed = jest.fn();
      const statusChanged = jest.fn();
      window.addEventListener('sync-complete', completed);
      window.addEventListener('sync-status-changed', statusChanged);
      try {
        const run = sync.backgroundSync();
        await requestStarted.promise;

        authScope.publishAuthIdentity({ state: 'unauthenticated' });
        insert.resolve({
          data: [makeRemoteTransaction({ updated_at: new Date(1000).toISOString() })],
          error: null,
        });
        await expect(run).resolves.toBe(false);
      } finally {
        window.removeEventListener('sync-complete', completed);
        window.removeEventListener('sync-status-changed', statusChanged);
      }

      // Only the in-flight push request ran; the stale cycle never reached pull.
      expect(mockSupabase.from).toHaveBeenCalledTimes(1);
      expect(completed).not.toHaveBeenCalled();
      expect(statusChanged).not.toHaveBeenCalled();
      expect(localStorage.getItem('last_sync_time')).toBeNull();
      expect(localStorage.getItem('sync_last_attempt_failed')).toBeNull();

      const queue = await db.getAll(STORES.SYNC_QUEUE);
      expect(queue).toHaveLength(1);
      expect(queue[0]).toEqual(entry);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Push: CAS / readback verification
// ---------------------------------------------------------------------------

describe('push compare-and-set verification', () => {
  it('sends the stored raw updated_at token for updates and acknowledges only the returned row', async () => {
    const { sync, db } = await setup();
    const entry = makeQueueEntry();
    await db.put(STORES.SYNC_QUEUE, entry);
    await db.put(STORES.SYNC_META, makeMeta());

    const nextIso = new Date(
      Date.parse(entry.baselineRevision ?? '') + 1
    ).toISOString();
    const remoteRow = {
      id: 'tx-1',
      amount: 20,
      date: '2026-01-05',
      type: 'expense',
      category: 'Food',
      from_account: null,
      to_account: 'acct-1',
      description: 'local',
      created_at: new Date(500).toISOString(),
      updated_at: nextIso,
      deleted_at: null,
      user_id: 'user-1',
    };
    responses = [{ data: [remoteRow], error: null }];

    await sync.processSyncQueue('user-1');

    const query = mockSupabase.from.mock.results[0]?.value as MockQuery;
    expect(query.update).toHaveBeenCalledTimes(1);
    const updatePayload = query.update.mock.calls[0][0] as Record<string, unknown>;
    expect(updatePayload.updated_at).toBe(nextIso);
    expect(query.eq.mock.calls).toEqual(
      expect.arrayContaining([
        ['id', 'tx-1'],
        ['updated_at', '2026-01-01T00:00:00.000Z'],
        ['user_id', 'user-1'],
      ])
    );
    expect(query.select).toHaveBeenCalledWith('*');

    expect(await db.count(STORES.SYNC_QUEUE)).toBe(0);
    const meta = await db.get(STORES.SYNC_META, `${STORES.TRANSACTIONS}:tx-1`);
    expect(meta).toMatchObject({
      state: 'clean',
      baselineRevision: nextIso,
      ownerId: 'user-1',
    });
    db.close();
  });

  it('never acknowledges a zero-row update even when readback content matches', async () => {
    const { sync, db } = await setup();
    const entry = makeQueueEntry();
    await db.put(STORES.SYNC_QUEUE, entry);
    await db.put(STORES.SYNC_META, makeMeta());

    const nextIso = new Date(
      Date.parse(entry.baselineRevision ?? '') + 1
    ).toISOString();
    responses = [
      { data: [], error: null },
      {
        data: [
          {
            id: 'tx-1',
            amount: 20,
            date: '2026-01-05',
            type: 'expense',
            category: 'Food',
            from_account: null,
            to_account: 'acct-1',
            description: 'local',
            created_at: new Date(500).toISOString(),
            updated_at: nextIso,
            deleted_at: null,
            user_id: 'user-1',
          },
        ],
        error: null,
      },
    ];

    await sync.processSyncQueue('user-1');

    const queue = await db.getAll(STORES.SYNC_QUEUE);
    expect(queue).toHaveLength(1);
    expect(queue[0].state).toBe('conflict');
    db.close();
  });

  it('marks a CAS miss as a conflict when the remote row no longer matches', async () => {
    const { sync, db } = await setup();
    await db.put(STORES.SYNC_QUEUE, makeQueueEntry());
    await db.put(STORES.SYNC_META, makeMeta());
    responses = [
      { data: [], error: null },
      {
        data: [
          {
            id: 'tx-1',
            amount: 999,
            date: '2026-01-05',
            type: 'expense',
            category: 'Food',
            from_account: null,
            to_account: 'acct-1',
            description: 'remote',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-02-01T00:00:00.000Z',
            deleted_at: null,
            user_id: 'user-1',
          },
        ],
        error: null,
      },
    ];

    await sync.processSyncQueue('user-1');

    const queue = await db.getAll(STORES.SYNC_QUEUE);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ state: 'conflict' });
    const meta = await db.get(STORES.SYNC_META, `${STORES.TRANSACTIONS}:tx-1`);
    expect(meta?.state).toBe('conflict');
    expect(meta?.conflict?.local).toMatchObject({ amount: 20 });
    expect(meta?.conflict?.remote).toMatchObject({ amount: 999 });
    db.close();
  });

  it('does not acknowledge a trigger-suppressed delete with zero returned rows', async () => {
    const { sync, db } = await setup();
    const deletion: SyncDeletionSnapshot = {
      id: 'del-1',
      storeName: STORES.TRANSACTIONS,
      recordId: 'tx-1',
      payload: makeLocalTransaction(),
      deletedAt: 1,
      ownerId: 'user-1',
      state: 'pending',
      reason: 'local-delete',
      baselineRevision: null,
      updatedAt: 1,
    };
    await db.put(STORES.SYNC_DELETIONS, deletion);
    await db.put(
      STORES.SYNC_QUEUE,
      makeQueueEntry({ operation: 'delete', deletionSnapshotId: 'del-1' })
    );
    await db.put(STORES.SYNC_META, makeMeta());
    responses = [
      { data: [], error: null },
      {
        data: [
          {
            id: 'tx-1',
            amount: 20,
            deleted_at: null,
            updated_at: '2026-02-01T00:00:00.000Z',
            user_id: 'user-1',
          },
        ],
        error: null,
      },
    ];

    await sync.processSyncQueue('user-1');

    const queue = await db.getAll(STORES.SYNC_QUEUE);
    expect(queue).toHaveLength(1);
    expect(queue[0].state).toBe('conflict');
    const storedDeletion = await db.get(STORES.SYNC_DELETIONS, 'del-1');
    expect(storedDeletion?.state).toBe('conflict');
    db.close();
  });

  it('uses created_at and never sends updated_at when deleting cash denominations', async () => {
    const { sync, db } = await setup();
    const cash = {
      id: 'cash-1',
      date: '2026-01-05',
      denomination: 100,
      count: 2,
    };
    await db.put(
      STORES.SYNC_QUEUE,
      makeQueueEntry({
        storeName: STORES.CASH_DENOMINATIONS,
        recordId: 'cash-1',
        operation: 'delete',
        payload: cash,
        baselineRevision: '2026-01-01T00:00:00.000Z',
        baseline: { id: 'cash-1', created_at: '2026-01-01T00:00:00.000Z' },
      })
    );
    responses = [
      {
        data: [{ ...cash, deleted_at: '2026-03-01T00:00:00.000Z', user_id: 'user-1' }],
        error: null,
      },
    ];

    await sync.processSyncQueue('user-1');

    const query = mockSupabase.from.mock.results[0]?.value as MockQuery;
    expect(query.update).toHaveBeenCalledWith({
      deleted_at: expect.any(String),
    });
    expect(query.update.mock.calls[0][0]).not.toHaveProperty('updated_at');
    expect(query.eq.mock.calls).toEqual(
      expect.arrayContaining([
        ['id', 'cash-1'],
        ['created_at', '2026-01-01T00:00:00.000Z'],
        ['user_id', 'user-1'],
      ])
    );
    expect(await db.count(STORES.SYNC_QUEUE)).toBe(0);
    db.close();
  });

  it('reads back duplicate creates and marks a content mismatch as conflict', async () => {
    const { sync, db } = await setup();
    await db.put(STORES.SYNC_QUEUE, makeQueueEntry({ operation: 'create' }));
    responses = [
      { data: null, error: { code: '23505', message: 'duplicate key' } },
      {
        data: [
          {
            id: 'tx-1',
            amount: 77,
            date: '2026-01-05',
            type: 'expense',
            category: 'Food',
            from_account: null,
            to_account: 'acct-1',
            description: 'different',
            created_at: new Date(500).toISOString(),
            updated_at: new Date(1000).toISOString(),
            deleted_at: null,
            user_id: 'user-1',
          },
        ],
        error: null,
      },
    ];

    await sync.processSyncQueue('user-1');

    const queue = await db.getAll(STORES.SYNC_QUEUE);
    expect(queue[0].state).toBe('conflict');
    const meta = await db.get(STORES.SYNC_META, `${STORES.TRANSACTIONS}:tx-1`);
    expect(meta?.conflict?.remote).toMatchObject({ amount: 77 });
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Pull: pending work and tombstones
// ---------------------------------------------------------------------------

describe('pull protects pending local work', () => {
  it('preserves a local record without a baseline instead of overwriting it with remote', async () => {
    const { sync, db } = await setup();
    await db.put(STORES.TRANSACTIONS, makeLocalTransaction());
    responses = [
      {
        data: [
          {
            id: 'tx-1',
            amount: 999,
            date: '2026-01-05',
            type: 'expense',
            category: 'Food',
            from_account: null,
            to_account: 'acct-1',
            description: 'remote',
            created_at: new Date(500).toISOString(),
            updated_at: '2026-02-01T00:00:00.000Z',
            deleted_at: null,
            user_id: 'user-1',
          },
        ],
        error: null,
      },
    ];

    await sync.pullStore(STORES.TRANSACTIONS, 'user-1');

    const local = await db.get(STORES.TRANSACTIONS, 'tx-1');
    expect(local).toMatchObject({ amount: 20, description: 'local' });
    const meta = await db.get(STORES.SYNC_META, `${STORES.TRANSACTIONS}:tx-1`);
    expect(meta?.state).toBe('conflict');
    expect(meta?.conflict?.remote).toMatchObject({ amount: 999 });
    db.close();
  });

  it('keeps the local record and records both versions when remote changed while a mutation is pending', async () => {
    const { sync, db } = await setup();
    await db.put(STORES.TRANSACTIONS, makeLocalTransaction());
    await db.put(STORES.SYNC_QUEUE, makeQueueEntry());
    await db.put(STORES.SYNC_META, makeMeta());
    responses = [
      {
        data: [
          {
            id: 'tx-1',
            amount: 999,
            date: '2026-01-05',
            type: 'expense',
            category: 'Food',
            from_account: null,
            to_account: 'acct-1',
            description: 'remote',
            created_at: new Date(500).toISOString(),
            updated_at: '2026-02-01T00:00:00.000Z',
            deleted_at: null,
            user_id: 'user-1',
          },
        ],
        error: null,
      },
    ];

    const ok = await sync.pullStore(STORES.TRANSACTIONS, 'user-1');
    expect(ok).toBe(true);

    const local = await db.get(STORES.TRANSACTIONS, 'tx-1');
    expect(local).toMatchObject({ amount: 20, description: 'local' });

    const queue = await db.getAll(STORES.SYNC_QUEUE);
    expect(queue[0].state).toBe('conflict');

    const meta = await db.get(STORES.SYNC_META, `${STORES.TRANSACTIONS}:tx-1`);
    expect(meta?.state).toBe('conflict');
    expect(meta?.conflict?.local).toMatchObject({ amount: 20 });
    expect(meta?.conflict?.remote).toMatchObject({ amount: 999 });
    db.close();
  });

  it('never deletes a locally edited record because of a remote tombstone', async () => {
    const { sync, db } = await setup();
    await db.put(STORES.TRANSACTIONS, makeLocalTransaction());
    await db.put(STORES.SYNC_QUEUE, makeQueueEntry());
    await db.put(STORES.SYNC_META, makeMeta());
    responses = [
      {
        data: [
          {
            id: 'tx-1',
            amount: 20,
            deleted_at: '2026-02-01T00:00:00.000Z',
            updated_at: '2026-02-01T00:00:00.000Z',
            user_id: 'user-1',
          },
        ],
        error: null,
      },
    ];

    await sync.pullStore(STORES.TRANSACTIONS, 'user-1');

    expect(await db.get(STORES.TRANSACTIONS, 'tx-1')).toMatchObject({ id: 'tx-1' });
    const meta = await db.get(STORES.SYNC_META, `${STORES.TRANSACTIONS}:tx-1`);
    expect(meta?.state).toBe('conflict');
    expect(meta?.conflict?.remote).toMatchObject({
      deleted_at: '2026-02-01T00:00:00.000Z',
    });
    db.close();
  });

  it('does not resurrect a record that has a pending local delete', async () => {
    const { sync, db } = await setup();
    await db.put(
      STORES.SYNC_QUEUE,
      makeQueueEntry({ operation: 'delete', payload: makeLocalTransaction() })
    );
    await db.put(STORES.SYNC_META, makeMeta());
    responses = [
      {
        data: [
          {
            id: 'tx-1',
            amount: 20,
            date: '2026-01-05',
            type: 'expense',
            category: 'Food',
            from_account: null,
            to_account: 'acct-1',
            description: 'local',
            created_at: new Date(500).toISOString(),
            updated_at: '2026-01-01T00:00:00.000Z',
            deleted_at: null,
            user_id: 'user-1',
          },
        ],
        error: null,
      },
    ];

    await sync.pullStore(STORES.TRANSACTIONS, 'user-1');

    expect(await db.get(STORES.TRANSACTIONS, 'tx-1')).toBeUndefined();
    const queue = await db.getAll(STORES.SYNC_QUEUE);
    expect(queue).toHaveLength(1);
    expect(queue[0].operation).toBe('delete');
    expect(queue[0].state).toBe('pending');
    db.close();
  });

  it('archives a recoverable deletion for an untouched local record with a remote tombstone', async () => {
    const { sync, db } = await setup();
    await db.put(STORES.TRANSACTIONS, makeLocalTransaction());
    await db.put(
      STORES.SYNC_META,
      makeMeta({
        state: 'clean',
        localUpdatedAt: 1000,
        baselineRevision: '2026-01-01T00:00:00.000Z',
        baseline: {
          id: 'tx-1',
          amount: 20,
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      })
    );
    responses = [
      {
        data: [
          {
            id: 'tx-1',
            amount: 20,
            deleted_at: '2026-02-01T00:00:00.000Z',
            updated_at: '2026-02-01T00:00:00.000Z',
            user_id: 'user-1',
          },
        ],
        error: null,
      },
    ];

    await sync.pullStore(STORES.TRANSACTIONS, 'user-1');

    expect(await db.get(STORES.TRANSACTIONS, 'tx-1')).toBeUndefined();
    const deletions = await db.getAll(STORES.SYNC_DELETIONS);
    expect(deletions).toHaveLength(1);
    expect(deletions[0]).toMatchObject({
      recordId: 'tx-1',
      reason: 'remote-tombstone',
    });
    expect(deletions[0].payload).toMatchObject({ amount: 20 });
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Truthful status
// ---------------------------------------------------------------------------

describe('sync status truthfulness', () => {
  it('does not claim a full sync when only conflicts remain', async () => {
    const { sync, db } = await setup();
    localStorage.setItem('last_sync_time', String(Date.now()));
    await db.put(
      STORES.SYNC_META,
      makeMeta({
        state: 'conflict',
        conflict: {
          local: makeLocalTransaction(),
          remote: null,
          reason: 'remote disappeared',
          detectedAt: 1,
        },
      })
    );

    const status = await sync.getSyncStatus();

    expect(status.queue).toBe(0);
    expect(status.conflict).toBe(1);
    expect(status.unresolved).toBe(1);
    expect(status.canClaimSynced).toBe(false);
    db.close();
  });

  it('reports pending, blocked, conflicting, and quarantined counts', async () => {
    const { sync, db } = await setup();
    await db.put(STORES.SYNC_QUEUE, makeQueueEntry({ id: 'q1', state: 'pending' }));
    await db.put(
      STORES.SYNC_QUEUE,
      makeQueueEntry({ id: 'q2', state: 'blocked', retryCount: 5 })
    );
    await db.put(
      STORES.SYNC_QUEUE,
      makeQueueEntry({ id: 'q3', state: 'conflict', recordId: 'tx-3' })
    );
    await db.put(
      STORES.SYNC_QUEUE,
      makeQueueEntry({ id: 'q4', state: 'quarantined', ownerId: null, recordId: 'tx-4' })
    );

    const status = await sync.getSyncStatus();

    expect(status).toMatchObject({
      queue: 4,
      pending: 1,
      blocked: 1,
      conflict: 1,
      quarantined: 1,
      unresolved: 3,
      failed: expect.any(Number),
    });
    expect(status.canClaimSynced).toBe(false);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Pull: transaction-consistent merge decisions
//
// Each test interleaves a second IDB connection with pullStore at the exact
// point the four-store merge transaction is created. No sleeps are involved:
// IndexedDB transaction ordering makes the interleaving deterministic.
// ---------------------------------------------------------------------------

describe('pull merge transaction consistency', () => {
  it('does not resurrect a record deleted between the remote fetch and the merge', async () => {
    const { sync, db } = await setup();
    await db.put(STORES.TRANSACTIONS, makeLocalTransaction());
    await db.put(STORES.SYNC_META, makeMeta());
    responses = [{ data: [makeRemoteTransaction()], error: null }];

    const db2 = await setupSecondConnection();
    let raceWrite: Promise<void> = Promise.resolve();
    interceptTransactions({
      match: isPullMergeTransaction,
      beforeCreate: () => {
        // The user deletes the record after pullStore has fetched the remote
        // snapshot but before its merge transaction can run.
        raceWrite = runRawTransaction(
          db2,
          [STORES.TRANSACTIONS, STORES.SYNC_QUEUE, STORES.SYNC_DELETIONS],
          (tx) => {
            tx.objectStore(STORES.TRANSACTIONS).delete('tx-1');
            tx.objectStore(STORES.SYNC_QUEUE).add(
              makeQueueEntry({
                id: 'q-race-delete',
                operation: 'delete',
                payload: makeLocalTransaction(),
                deletionSnapshotId: 'del-race',
                timestamp: 10,
              })
            );
            tx.objectStore(STORES.SYNC_DELETIONS).add({
              id: 'del-race',
              storeName: STORES.TRANSACTIONS,
              recordId: 'tx-1',
              payload: makeLocalTransaction(),
              deletedAt: 123,
              ownerId: 'user-1',
              state: 'pending',
              reason: 'local-delete',
              baselineRevision: null,
              lastError: null,
              updatedAt: 123,
            } satisfies SyncDeletionSnapshot);
          }
        );
      },
    });

    await expect(sync.pullStore(STORES.TRANSACTIONS, 'user-1')).resolves.toBe(true);
    await raceWrite;

    expect(await db.get(STORES.TRANSACTIONS, 'tx-1')).toBeUndefined();
    const queue = await db.getAll(STORES.SYNC_QUEUE);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      id: 'q-race-delete',
      operation: 'delete',
      state: 'pending',
    });
    const deletions = await db.getAll(STORES.SYNC_DELETIONS);
    expect(deletions).toHaveLength(1);
    expect(deletions[0]).toMatchObject({
      id: 'del-race',
      reason: 'local-delete',
      state: 'pending',
    });
    db2.close();
    db.close();
  });

  it('keeps an equal-timestamp local update against a newer remote row and a tombstone as conflicts', async () => {
    const { sync, db } = await setup();
    const localActive = makeLocalTransaction({
      id: 'tx-active',
      amount: 20,
      description: 'local-active',
      updatedAt: 1000,
    });
    const localTombstone = makeLocalTransaction({
      id: 'tx-tomb',
      amount: 30,
      description: 'local-tomb',
      updatedAt: 1000,
    });
    await db.put(STORES.TRANSACTIONS, localActive);
    await db.put(STORES.TRANSACTIONS, localTombstone);
    await db.put(
      STORES.SYNC_META,
      makeMeta({ id: metaKey('tx-active'), recordId: 'tx-active', localUpdatedAt: 1000 })
    );
    await db.put(
      STORES.SYNC_META,
      makeMeta({ id: metaKey('tx-tomb'), recordId: 'tx-tomb', localUpdatedAt: 1000 })
    );
    responses = [
      {
        data: [
          makeRemoteTransaction({
            id: 'tx-active',
            amount: 999,
            description: 'remote-active',
            updated_at: '2026-02-01T00:00:00.000Z',
          }),
          makeRemoteTransaction({
            id: 'tx-tomb',
            amount: 30,
            description: 'local-tomb',
            updated_at: '2026-02-01T00:00:00.000Z',
            deleted_at: '2026-02-01T00:00:00.000Z',
          }),
        ],
        error: null,
      },
    ];

    const db2 = await setupSecondConnection();
    let raceWrite: Promise<void> = Promise.resolve();
    interceptTransactions({
      match: isPullMergeTransaction,
      beforeCreate: () => {
        // Both local updates land after pullStore fetched the remote rows, so
        // stale pre-transaction queue maps would see no pending work. The
        // local timestamps equal the stored metadata timestamps.
        raceWrite = runRawTransaction(
          db2,
          [STORES.TRANSACTIONS, STORES.SYNC_QUEUE],
          (tx) => {
            tx.objectStore(STORES.TRANSACTIONS).put(localActive);
            tx.objectStore(STORES.TRANSACTIONS).put(localTombstone);
            tx.objectStore(STORES.SYNC_QUEUE).add(
              makeQueueEntry({
                id: 'q-active',
                recordId: 'tx-active',
                operation: 'update',
                payload: localActive,
                timestamp: 10,
              })
            );
            tx.objectStore(STORES.SYNC_QUEUE).add(
              makeQueueEntry({
                id: 'q-tomb',
                recordId: 'tx-tomb',
                operation: 'update',
                payload: localTombstone,
                timestamp: 11,
              })
            );
          }
        );
      },
    });

    await expect(sync.pullStore(STORES.TRANSACTIONS, 'user-1')).resolves.toBe(true);
    await raceWrite;

    expect(await db.get(STORES.TRANSACTIONS, 'tx-active')).toMatchObject({
      amount: 20,
      description: 'local-active',
    });
    expect(await db.get(STORES.TRANSACTIONS, 'tx-tomb')).toMatchObject({
      amount: 30,
      description: 'local-tomb',
    });

    const queue = await db.getAll(STORES.SYNC_QUEUE);
    expect(queue).toHaveLength(2);
    expect(queue.map((entry) => entry.state)).toEqual(['conflict', 'conflict']);

    const activeMeta = await db.get(STORES.SYNC_META, metaKey('tx-active'));
    expect(activeMeta?.state).toBe('conflict');
    expect(activeMeta?.conflict?.local).toMatchObject({ amount: 20 });
    expect(activeMeta?.conflict?.remote).toMatchObject({ amount: 999 });

    const tombstoneMeta = await db.get(STORES.SYNC_META, metaKey('tx-tomb'));
    expect(tombstoneMeta?.state).toBe('conflict');
    expect(tombstoneMeta?.conflict?.local).toMatchObject({ amount: 30 });
    expect(tombstoneMeta?.conflict?.remote).toMatchObject({
      deleted_at: '2026-02-01T00:00:00.000Z',
    });
    db2.close();
    db.close();
  });

  it('observes metadata committed between the remote fetch and the merge', async () => {
    const { sync, db } = await setup();
    await db.put(STORES.TRANSACTIONS, makeLocalTransaction());
    responses = [
      {
        data: [
          makeRemoteTransaction({
            updated_at: new Date(1000).toISOString(),
          }),
        ],
        error: null,
      },
    ];

    const db2 = await setupSecondConnection();
    let raceWrite: Promise<void> = Promise.resolve();
    interceptTransactions({
      match: isPullMergeTransaction,
      beforeCreate: () => {
        raceWrite = runRawTransaction(db2, [STORES.SYNC_META], (tx) => {
          tx.objectStore(STORES.SYNC_META).put(
            makeMeta({
              state: 'blocked',
              baseline: null,
              baselineRevision: null,
              localUpdatedAt: 1000,
              lastError: 'awaiting resolution',
            })
          );
        });
      },
    });

    await expect(sync.pullStore(STORES.TRANSACTIONS, 'user-1')).resolves.toBe(true);
    await raceWrite;

    // The merge must not overwrite an unresolved record with the remote row,
    // even though the stale pre-merge snapshot had no metadata for it.
    expect(await db.get(STORES.TRANSACTIONS, 'tx-1')).toMatchObject({
      amount: 20,
      description: 'local',
    });
    const meta = await db.get(STORES.SYNC_META, metaKey('tx-1'));
    expect(meta).toMatchObject({
      state: 'blocked',
      baselineRevision: null,
      localUpdatedAt: 1000,
      lastError: 'awaiting resolution',
    });
    db2.close();
    db.close();
  });

  it('applies a writer created after the merge transaction without corrupting its work', async () => {
    const { sync, db } = await setup();
    await db.put(STORES.TRANSACTIONS, makeLocalTransaction());
    await db.put(STORES.SYNC_META, makeMeta());
    responses = [{ data: [makeRemoteTransaction()], error: null }];

    const db2 = await setupSecondConnection();
    let raceWrite: Promise<void> = Promise.resolve();
    interceptTransactions({
      match: isPullMergeTransaction,
      afterCreate: () => {
        // This mutation is created after the merge transaction, so IndexedDB
        // runs it second. The merge must not clobber it.
        raceWrite = runRawTransaction(
          db2,
          [STORES.TRANSACTIONS, STORES.SYNC_QUEUE],
          (tx) => {
            const updated = makeLocalTransaction({ amount: 77, updatedAt: 2000 });
            tx.objectStore(STORES.TRANSACTIONS).put(updated);
            tx.objectStore(STORES.SYNC_QUEUE).add(
              makeQueueEntry({
                id: 'q-writer',
                operation: 'update',
                payload: updated,
                timestamp: 10,
              })
            );
          }
        );
      },
    });

    await expect(sync.pullStore(STORES.TRANSACTIONS, 'user-1')).resolves.toBe(true);
    await raceWrite;

    expect(await db.get(STORES.TRANSACTIONS, 'tx-1')).toMatchObject({
      amount: 77,
      updatedAt: 2000,
    });
    const queue = await db.getAll(STORES.SYNC_QUEUE);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ id: 'q-writer', state: 'pending' });
    // The writer's queue entry survives and was not converted to a conflict
    // by a merge that ran with stale pre-writer state.
    const meta = await db.get(STORES.SYNC_META, metaKey('tx-1'));
    expect(meta?.state).toBe('clean');
    db2.close();
    db.close();
  });

  it('propagates a merge transaction abort and keeps a prior committed local delete', async () => {
    const { sync, db } = await setup();
    await db.put(
      STORES.SYNC_QUEUE,
      makeQueueEntry({
        id: 'q-prior-delete',
        operation: 'delete',
        payload: makeLocalTransaction(),
        deletionSnapshotId: 'del-prior',
        timestamp: 10,
      })
    );
    await db.put(STORES.SYNC_DELETIONS, {
      id: 'del-prior',
      storeName: STORES.TRANSACTIONS,
      recordId: 'tx-1',
      payload: makeLocalTransaction(),
      deletedAt: 123,
      ownerId: 'user-1',
      state: 'pending',
      reason: 'local-delete',
      baselineRevision: null,
      lastError: null,
      updatedAt: 123,
    } satisfies SyncDeletionSnapshot);
    await db.put(STORES.SYNC_META, makeMeta());
    responses = [
      {
        data: [
          makeRemoteTransaction({
            deleted_at: '2026-02-01T00:00:00.000Z',
            updated_at: '2026-02-01T00:00:00.000Z',
          }),
        ],
        error: null,
      },
    ];

    interceptTransactions({
      match: isPullMergeTransaction,
      afterCreate: (tx) => tx.abort(),
    });

    await expect(sync.pullStore(STORES.TRANSACTIONS, 'user-1')).rejects.toBeDefined();

    expect(await db.get(STORES.TRANSACTIONS, 'tx-1')).toBeUndefined();
    const queue = await db.getAll(STORES.SYNC_QUEUE);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ id: 'q-prior-delete', state: 'pending' });
    const deletions = await db.getAll(STORES.SYNC_DELETIONS);
    expect(deletions).toHaveLength(1);
    expect(deletions[0]).toMatchObject({ id: 'del-prior', state: 'pending' });
    // The aborted merge must not have recorded its conflict decision.
    const meta = await db.get(STORES.SYNC_META, metaKey('tx-1'));
    expect(meta?.state).toBe('clean');
    expect(meta?.conflict).toBeNull();
    db.close();
  });

  it('does not advance last_sync_time or claim success when the merge transaction fails', async () => {
    const { sync, db } = await setup();
    localStorage.setItem('uuid_migration_done', '1');
    localStorage.setItem('last_sync_time', '111');
    localStorage.setItem('sync_last_attempt_failed', '0');
    responses = [
      ...DATA_STORES.slice(0, -1).map(() => ({ data: [], error: null })),
      { data: [makeRemoteTransaction()], error: null },
    ];

    interceptTransactions({
      match: isPullMergeTransaction,
      afterCreate: (tx) => tx.abort(),
    });

    const completed = jest.fn();
    window.addEventListener('sync-complete', completed);
    try {
      await expect(sync.backgroundSync()).resolves.toBe(false);
    } finally {
      window.removeEventListener('sync-complete', completed);
    }

    expect(localStorage.getItem('last_sync_time')).toBe('111');
    expect(localStorage.getItem('sync_last_attempt_failed')).toBe('1');
    expect(completed).not.toHaveBeenCalled();
    // The aborted merge must not have adopted the remote row.
    expect(await db.get(STORES.TRANSACTIONS, 'tx-1')).toBeUndefined();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Pull: auth-generation fencing
//
// A pull is authorized by the exact identity generation captured when the
// cycle started. A response or merge that outlives that generation is a
// cancellation, never a success: it must not touch local rows, metadata,
// deletion archives, or status/events.
// ---------------------------------------------------------------------------

describe('pull across auth invalidation', () => {
  it('does not merge, delete, or report success for a response arriving after sign-out', async () => {
    const { sync, db } = await setup();
    try {
      const authScope = await import('./auth-scope');
      localStorage.setItem(LAST_USER_STORAGE_KEY, 'user-1');
      authScope.publishAuthIdentity({ state: 'authenticated', userId: 'user-1' });

      await db.put(STORES.TRANSACTIONS, makeLocalTransaction());
      await db.put(STORES.SYNC_META, makeMeta());

      const response = Promise.withResolvers<QueryResult>();
      const requestStarted = Promise.withResolvers<void>();
      mockSupabase.from.mockImplementation(() =>
        makeDeferredQuery(response.promise, () => requestStarted.resolve())
      );

      const run = sync.pullStore(STORES.TRANSACTIONS, 'user-1');
      await requestStarted.promise;

      authScope.publishAuthIdentity({ state: 'unauthenticated' });
      response.resolve({
        data: [
          makeRemoteTransaction({
            description: 'remote-after-signout',
            updated_at: '2026-02-01T00:00:00.000Z',
          }),
        ],
        error: null,
      });

      await expect(run).resolves.toBe(false);

      // The stale response must not overwrite the local record or its baseline.
      expect(await db.get(STORES.TRANSACTIONS, 'tx-1')).toMatchObject({
        description: 'local',
      });
      expect(await db.get(STORES.SYNC_META, metaKey('tx-1'))).toMatchObject({
        baselineRevision: '2026-01-01T00:00:00.000Z',
        state: 'clean',
      });
      expect(await db.getAll(STORES.SYNC_DELETIONS)).toHaveLength(0);
      expect(mockSupabase.from).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it('does not revive an old pull after signing out and back in as the same user', async () => {
    const { sync, db } = await setup();
    try {
      const authScope = await import('./auth-scope');
      localStorage.setItem(LAST_USER_STORAGE_KEY, 'user-1');
      authScope.publishAuthIdentity({ state: 'authenticated', userId: 'user-1' });

      await db.put(STORES.TRANSACTIONS, makeLocalTransaction());
      await db.put(STORES.SYNC_META, makeMeta());

      const response = Promise.withResolvers<QueryResult>();
      const requestStarted = Promise.withResolvers<void>();
      mockSupabase.from.mockImplementation(() =>
        makeDeferredQuery(response.promise, () => requestStarted.resolve())
      );

      const run = sync.pullStore(STORES.TRANSACTIONS, 'user-1');
      await requestStarted.promise;

      // A → signed out → A. The owner marker still names user-1, so a naive
      // user-ID check would consider this response authorized; the generation
      // captured before sign-out must not come back to life.
      authScope.publishAuthIdentity({ state: 'unauthenticated' });
      authScope.publishAuthIdentity({ state: 'authenticated', userId: 'user-1' });
      expect(authScope.captureAuthScope()).not.toBeNull();

      response.resolve({
        data: [
          makeRemoteTransaction({
            deleted_at: '2026-02-01T00:00:00.000Z',
            updated_at: '2026-02-01T00:00:00.000Z',
          }),
        ],
        error: null,
      });

      await expect(run).resolves.toBe(false);

      // The tombstone from the previous generation must not archive or delete.
      expect(await db.get(STORES.TRANSACTIONS, 'tx-1')).toMatchObject({
        description: 'local',
      });
      expect(await db.getAll(STORES.SYNC_DELETIONS)).toHaveLength(0);
      expect(await db.get(STORES.SYNC_META, metaKey('tx-1'))).toMatchObject({
        baselineRevision: '2026-01-01T00:00:00.000Z',
        state: 'clean',
      });
    } finally {
      db.close();
    }
  });

  it('does not report an empty remote response as success after invalidation', async () => {
    const { sync, db } = await setup();
    try {
      const authScope = await import('./auth-scope');
      localStorage.setItem(LAST_USER_STORAGE_KEY, 'user-1');
      authScope.publishAuthIdentity({ state: 'authenticated', userId: 'user-1' });

      await db.put(STORES.TRANSACTIONS, makeLocalTransaction());

      const response = Promise.withResolvers<QueryResult>();
      const requestStarted = Promise.withResolvers<void>();
      mockSupabase.from.mockImplementation(() =>
        makeDeferredQuery(response.promise, () => requestStarted.resolve())
      );

      const run = sync.pullStore(STORES.TRANSACTIONS, 'user-1');
      await requestStarted.promise;

      authScope.publishAuthIdentity({ state: 'unauthenticated' });
      response.resolve({ data: [], error: null });

      await expect(run).resolves.toBe(false);

      // An empty snapshot would normally quarantine the local record; a stale
      // pull must not write that metadata either.
      expect(await db.get(STORES.SYNC_META, metaKey('tx-1'))).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('aborts an active merge transaction when the identity is invalidated mid-merge', async () => {
    const { sync, db } = await setup();
    try {
      const authScope = await import('./auth-scope');
      localStorage.setItem(LAST_USER_STORAGE_KEY, 'user-1');
      authScope.publishAuthIdentity({ state: 'authenticated', userId: 'user-1' });

      await db.put(STORES.TRANSACTIONS, makeLocalTransaction());
      await db.put(STORES.SYNC_META, makeMeta());
      responses = [
        {
          data: [
            makeRemoteTransaction({
              description: 'remote-mid-merge',
              updated_at: '2026-02-01T00:00:00.000Z',
            }),
          ],
          error: null,
        },
      ];

      const aborted = Promise.withResolvers<void>();
      interceptTransactions({
        match: isPullMergeTransaction,
        afterCreate: (tx) => {
          tx.addEventListener('abort', () => aborted.resolve());
          // Invalidate while the merge transaction is awaiting its reads.
          queueMicrotask(() => {
            authScope.publishAuthIdentity({ state: 'unauthenticated' });
          });
        },
      });

      await expect(sync.pullStore(STORES.TRANSACTIONS, 'user-1')).resolves.toBe(false);

      // The aborted merge must have applied none of its decisions.
      expect(await db.get(STORES.TRANSACTIONS, 'tx-1')).toMatchObject({
        description: 'local',
      });
      expect(await db.get(STORES.SYNC_META, metaKey('tx-1'))).toMatchObject({
        baselineRevision: '2026-01-01T00:00:00.000Z',
        state: 'clean',
      });
      await aborted.promise;
    } finally {
      db.close();
    }
  });

  it('refuses a direct pull when the owner marker or supplied user is not the captured scope', async () => {
    const { sync, db } = await setup();
    try {
      const authScope = await import('./auth-scope');
      localStorage.setItem(LAST_USER_STORAGE_KEY, 'user-1');
      authScope.publishAuthIdentity({ state: 'authenticated', userId: 'user-1' });

      await sync.pullStore(STORES.TRANSACTIONS, 'user-2');
      expect(mockSupabase.from).not.toHaveBeenCalled();

      localStorage.removeItem(LAST_USER_STORAGE_KEY);
      await sync.pullStore(STORES.TRANSACTIONS, 'user-1');
      expect(mockSupabase.from).not.toHaveBeenCalled();

      localStorage.setItem(LAST_USER_STORAGE_KEY, 'user-2');
      await sync.pullStore(STORES.TRANSACTIONS, 'user-1');
      expect(mockSupabase.from).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('stops a background cycle when a pull response arrives after same-user re-login', async () => {
    const { sync, db } = await setup();
    try {
      localStorage.setItem('uuid_migration_done', '1');
      const authScope = await import('./auth-scope');
      localStorage.setItem(LAST_USER_STORAGE_KEY, 'user-1');
      authScope.publishAuthIdentity({ state: 'authenticated', userId: 'user-1' });

      await db.put(STORES.TRANSACTIONS, makeLocalTransaction());
      await db.put(STORES.SYNC_META, makeMeta());

      const response = Promise.withResolvers<QueryResult>();
      const requestStarted = Promise.withResolvers<void>();
      let fromCount = 0;
      mockSupabase.from.mockImplementation(() => {
        fromCount += 1;
        if (fromCount === 1) {
          return makeDeferredQuery(response.promise, () => requestStarted.resolve());
        }
        return makeQuery({ data: [], error: null });
      });

      const completed = jest.fn();
      const statusChanged = jest.fn();
      window.addEventListener('sync-complete', completed);
      window.addEventListener('sync-status-changed', statusChanged);
      try {
        const run = sync.backgroundSync();
        await requestStarted.promise;

        authScope.publishAuthIdentity({ state: 'unauthenticated' });
        authScope.publishAuthIdentity({ state: 'authenticated', userId: 'user-1' });
        response.resolve({
          data: [
            makeRemoteTransaction({
              description: 'remote-after-relogin',
              updated_at: '2026-02-01T00:00:00.000Z',
            }),
          ],
          error: null,
        });
        await expect(run).resolves.toBe(false);
      } finally {
        window.removeEventListener('sync-complete', completed);
        window.removeEventListener('sync-status-changed', statusChanged);
      }

      // The stale cycle stops at the first stale pull: no further stores, no
      // status write, no events.
      expect(mockSupabase.from).toHaveBeenCalledTimes(1);
      expect(completed).not.toHaveBeenCalled();
      expect(statusChanged).not.toHaveBeenCalled();
      expect(localStorage.getItem('last_sync_time')).toBeNull();
      expect(localStorage.getItem('sync_last_attempt_failed')).toBeNull();

      expect(await db.get(STORES.TRANSACTIONS, 'tx-1')).toMatchObject({
        description: 'local',
      });
      expect(await db.get(STORES.SYNC_META, metaKey('tx-1'))).toMatchObject({
        baselineRevision: '2026-01-01T00:00:00.000Z',
        state: 'clean',
      });
    } finally {
      db.close();
    }
  });
});
