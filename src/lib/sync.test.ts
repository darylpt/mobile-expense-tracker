import 'fake-indexeddb/auto';

if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (val: unknown) => JSON.parse(JSON.stringify(val));
}

import { STORES } from './constants';
import {
  applyDatasetReplacement,
  backgroundSync,
  pullStore,
  processSyncQueue,
  resolveReplacementConflict,
} from './sync';
import {
  clearAllLocalData,
  enqueueSyncEntry,
  getDB,
  getDatasetReplacementMarker,
  getSyncQueueCount,
  importFromCsv,
  putDatasetReplacementMarker,
  setActiveDatasetGeneration,
} from './idb';
import type { Account } from '@/types';
import {
  LOCAL_DATASET_OWNER,
  type DatasetReplacementMarker,
  type DatasetSnapshot,
} from './dataset-replacement';

const USER = 'user-1';

const IMPORT_CSV = [
  'Date,Amount,Description,Type,Category,From Account,To Account',
  '1/5/2026,₱100.00,Imported,Transfer,Savings Transfer,Imported Cash,Imported Bank',
].join('\n');

async function importOffline(userId: string): Promise<void> {
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
  try {
    await importFromCsv(IMPORT_CSV, userId);
  } finally {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  }
}

interface MockState {
  remoteGeneration: number;
  pulls: Record<string, Record<string, unknown>[]>;
  selects: string[];
  upserts: Array<{ table: string; payload: Record<string, unknown>; options: unknown }>;
  updates: Array<{ table: string; payload: Record<string, unknown>; id: unknown }>;
  rpcCalls: Array<{ name: string; params: Record<string, unknown> }>;
  rpc: ((params: Record<string, unknown>) => { data: unknown; error: unknown } | Promise<{ data: unknown; error: unknown }>) | null;
  onSelect: ((table: string) => Promise<void> | void) | null;
}

interface MockQuery {
  select(columns: string): MockQuery;
  eq(column: string, value: unknown): MockQuery;
  order(column: string): MockQuery;
  range(from: number, to: number): MockQuery;
  maybeSingle(): Promise<{ data: { generation: number }; error: null }>;
  update(payload: Record<string, unknown>): MockQuery;
  upsert(payload: Record<string, unknown>, options: unknown): Promise<{ error: null }>;
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2>;
}

jest.mock('./supabase', () => {
  const state: MockState = {
    remoteGeneration: 0,
    pulls: {},
    selects: [],
    upserts: [],
    updates: [],
    rpcCalls: [],
    rpc: null,
    onSelect: null,
  };

  function createQuery(table: string): MockQuery {
    let updatePayload: Record<string, unknown> | null = null;
    let idFilter: unknown = null;
    let rangeFrom = 0;
    let rangeTo = Number.MAX_SAFE_INTEGER;

    const query: MockQuery = {
      select(_columns: string) {
        state.selects.push(table);
        return query;
      },
      eq(column: string, value: unknown) {
        if (column === 'id') idFilter = value;
        return query;
      },
      order(_column: string) {
        return query;
      },
      range(from: number, to: number) {
        rangeFrom = from;
        rangeTo = to;
        return query;
      },
      maybeSingle() {
        return Promise.resolve({
          data: { generation: state.remoteGeneration },
          error: null,
        });
      },
      update(payload: Record<string, unknown>) {
        updatePayload = payload;
        return query;
      },
      upsert(payload: Record<string, unknown>, options: unknown) {
        state.upserts.push({ table, payload, options });
        return Promise.resolve({ error: null });
      },
      then<TResult1 = unknown, TResult2 = never>(
        onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
      ) {
        if (updatePayload) {
          state.updates.push({ table, payload: updatePayload, id: idFilter });
        }
        const finish = async () => {
          if (state.onSelect) await state.onSelect(table);
          const rows = state.pulls[table] ?? [];
          return { data: rows.slice(rangeFrom, rangeTo + 1), error: null };
        };
        return finish().then(onfulfilled, onrejected);
      },
    };

    return query;
  }

  const client = {
    auth: {
      getUser: jest.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
    from: jest.fn((table: string) => createQuery(table)),
    rpc: jest.fn(async (name: string, params: Record<string, unknown>) => {
      state.rpcCalls.push({ name, params });
      if (state.rpc) return await state.rpc(params);
      if (name === 'apply_managed_write') {
        const table = params.p_store as string;
        const row = params.p_record as Record<string, unknown> | null;
        if (row) state.pulls[table] = [...(state.pulls[table] ?? []).filter((item) => item.id !== row.id), row];
        return {
          data: { status: 'applied', generation: params.p_generation },
          error: null,
        };
      }
      return { data: null, error: { message: 'RPC not configured' } };
    }),
    __state: state,
  };

  return { supabase: client };
});

import { supabase } from './supabase';

const mockedSupabase = supabase as unknown as {
  __state: MockState;
  rpc: jest.Mock;
};

const state = mockedSupabase.__state;

const ACCOUNT: Account = {
  id: 'acct-cash',
  name: 'Cash',
  startingBalance: 0,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

function snapshot(overrides: Partial<DatasetSnapshot> = {}): DatasetSnapshot {
  return {
    accounts: [ACCOUNT],
    categories: [],
    transactions: [],
    cashDenominations: [],
    payouts: [],
    budgetTargets: [],
    ...overrides,
  };
}

function marker(overrides: Partial<DatasetReplacementMarker> = {}): DatasetReplacementMarker {
  return {
    userId: USER,
    generation: 1,
    snapshotId: 'snapshot-1',
    status: 'pending',
    snapshot: snapshot(),
    remoteGeneration: null,
    attempts: 0,
    lastError: null,
    updatedAt: 1,
    ...overrides,
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

beforeAll(() => {
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

beforeEach(async () => {
  await clearAllLocalData();
  localStorage.clear();
  state.remoteGeneration = 0;
  state.pulls = {};
  state.selects = [];
  state.upserts = [];
  state.updates = [];
  state.rpcCalls = [];
  state.rpc = null;
  state.onSelect = null;
});

describe('applyDatasetReplacement', () => {
  it('retries with the same snapshot id until the cloud applies it, then stops', async () => {
    await putDatasetReplacementMarker(marker());
    state.rpc = () => ({ data: null, error: { message: 'Network down' } });

    const failed = await applyDatasetReplacement(USER);

    expect(failed?.status).toBe('failed');
    expect(failed?.attempts).toBe(1);
    expect(failed?.snapshot).not.toBeNull();
    expect(failed?.lastError).toBe('Network down');

    state.rpc = () => ({ data: { status: 'applied', generation: 1 }, error: null });
    const applied = await applyDatasetReplacement(USER);

    expect(applied?.status).toBe('applied');
    expect(applied?.generation).toBe(1);
    expect(applied?.snapshot).toBeNull();
    expect(state.rpcCalls).toHaveLength(2);
    expect(state.rpcCalls[0].name).toBe('replace_user_dataset');
    expect(state.rpcCalls[0].params.p_snapshot_id).toBe('snapshot-1');
    expect(state.rpcCalls[1].params.p_snapshot_id).toBe('snapshot-1');
    expect(state.rpcCalls[0].params.p_accounts).toEqual([
      expect.objectContaining({
        id: 'acct-cash',
        user_id: USER,
        dataset_generation: 1,
      }),
    ]);

    await applyDatasetReplacement(USER);
    expect(state.rpcCalls).toHaveLength(2);
    expect(state.upserts).toHaveLength(0);
  });

  it('keeps an import committed while the replace RPC is in flight', async () => {
    await putDatasetReplacementMarker(
      marker({ status: 'pending', generation: 1, snapshotId: 'old-snapshot' })
    );

    const observed: { imported: DatasetReplacementMarker | null } = { imported: null };
    state.rpc = async (params) => {
      if (params.p_snapshot_id === 'old-snapshot') {
        await importOffline(USER);
        observed.imported = await getDatasetReplacementMarker(USER);
      }
      return { data: { status: 'applied', generation: params.p_generation }, error: null };
    };

    const result = await applyDatasetReplacement(USER);

    expect(observed.imported?.status).toBe('pending');
    expect(result).toEqual(observed.imported);
    expect(await getDatasetReplacementMarker(USER)).toEqual(observed.imported);

    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await enqueueSyncEntry(STORES.STOCKS, 'stock-1', 'create', { id: 'stock-1' });
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });

    const queued = await (await getDB()).getAll(STORES.SYNC_QUEUE);
    expect(queued.find((entry) => entry.recordId === 'stock-1')?.datasetGeneration).toBe(
      observed.imported!.generation
    );

    const accounts = await (await getDB()).getAll(STORES.ACCOUNTS);
    expect(accounts.map((account) => account.name).sort()).toEqual([
      'Imported Bank',
      'Imported Cash',
    ]);
  });

  it('keeps a conflicted marker and resolves it with a newer generation on explicit action', async () => {
    await putDatasetReplacementMarker(marker({ generation: 3 }));
    state.rpc = () => ({ data: { status: 'conflict', generation: 9 }, error: null });

    const conflicted = await applyDatasetReplacement(USER);

    expect(conflicted?.status).toBe('conflict');
    expect(conflicted?.remoteGeneration).toBe(9);
    expect(conflicted?.snapshot).not.toBeNull();

    state.rpc = () => ({ data: { status: 'applied', generation: 10 }, error: null });
    const resolved = await resolveReplacementConflict(USER);

    expect(resolved?.status).toBe('applied');
    expect(resolved?.generation).toBe(10);
    expect(resolved?.snapshot).toBeNull();
    expect(state.rpcCalls[state.rpcCalls.length - 1].params.p_generation).toBe(10);
  });
});

describe('backgroundSync replacement gate', () => {
  it('does not push or pull while a pending replacement cannot be applied', async () => {
    await putDatasetReplacementMarker(marker());
    const db = await getDB();
    await db.put(STORES.SYNC_QUEUE, {
      id: 'queued-account',
      storeName: STORES.ACCOUNTS,
      recordId: ACCOUNT.id,
      operation: 'create',
      payload: ACCOUNT,
      timestamp: 1,
      retryCount: 0,
      datasetGeneration: 1,
    });
    state.rpc = () => ({ data: null, error: { message: 'offline' } });

    await backgroundSync();

    expect(state.upserts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
    expect(state.selects).not.toContain(STORES.ACCOUNTS);
    expect(await getSyncQueueCount()).toBe(1);
    expect((await getDatasetReplacementMarker(USER))?.status).toBe('failed');
  });

  it('leaves a conflicted marker for explicit resolution', async () => {
    await putDatasetReplacementMarker(
      marker({ status: 'conflict', generation: 1, remoteGeneration: 3, snapshot: snapshot() })
    );
    state.remoteGeneration = 3;
    state.rpc = () => ({ data: { status: 'applied', generation: 4 }, error: null });

    await backgroundSync();

    expect(state.rpcCalls.filter((call) => call.name === 'replace_user_dataset')).toHaveLength(0);
    expect((await getDatasetReplacementMarker(USER))?.status).toBe('conflict');
    expect(state.selects).not.toContain(STORES.ACCOUNTS);
  });

  it('turns a stale-generation managed queue entry into a conflict instead of dropping it', async () => {
    await putDatasetReplacementMarker(
      marker({ status: 'applied', generation: 3, snapshot: null })
    );
    state.remoteGeneration = 3;
    const db = await getDB();
    const staleEdit = {
      ...ACCOUNT,
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Stale Tab Edit',
      updatedAt: 2,
    };
    await db.put(STORES.ACCOUNTS, staleEdit);
    await db.put(STORES.SYNC_QUEUE, {
      id: 'stale-tab-entry',
      storeName: STORES.ACCOUNTS,
      recordId: staleEdit.id,
      operation: 'update',
      payload: staleEdit,
      timestamp: 1,
      retryCount: 0,
      datasetGeneration: 2,
    });

    await backgroundSync();

    const saved = await getDatasetReplacementMarker(USER);
    expect(saved?.status).toBe('conflict');
    expect(saved?.remoteGeneration).toBe(3);
    expect(saved?.snapshot?.accounts.map((account) => account.id)).toContain(staleEdit.id);
    expect(await getSyncQueueCount()).toBe(1);
    expect((await db.get(STORES.ACCOUNTS, staleEdit.id))?.name).toBe('Stale Tab Edit');
    expect(state.rpcCalls.filter((call) => call.name === 'apply_managed_write')).toHaveLength(0);
    expect(state.selects).not.toContain(STORES.ACCOUNTS);
  });

  it('applies the replacement before pulling managed stores', async () => {
    await putDatasetReplacementMarker(marker());
    state.rpc = () => ({ data: { status: 'applied', generation: 2 }, error: null });

    await backgroundSync();

    expect((await getDatasetReplacementMarker(USER))?.status).toBe('applied');
    expect(state.selects).toContain(STORES.ACCOUNTS);
    expect(state.selects).toContain(STORES.TRANSACTIONS);
  });

  it('stamps the applied dataset generation on queued managed writes', async () => {
    await putDatasetReplacementMarker(
      marker({ status: 'applied', generation: 3, snapshot: null })
    );
    state.remoteGeneration = 3;
    const db = await getDB();
    await db.put(STORES.SYNC_QUEUE, {
      id: 'queued-account',
      storeName: STORES.ACCOUNTS,
      recordId: ACCOUNT.id,
      operation: 'create',
      payload: ACCOUNT,
      timestamp: 1,
      retryCount: 0,
      datasetGeneration: 3,
    });

    await backgroundSync();

    const managedWrite = state.rpcCalls.find((call) => call.name === 'apply_managed_write');
    expect(managedWrite?.params).toMatchObject({
      p_generation: 3,
      p_store: 'accounts',
      p_operation: 'create',
    });
    expect(managedWrite?.params.p_record).toMatchObject({
      dataset_generation: 3,
      user_id: USER,
      updated_at: iso(ACCOUNT.updatedAt),
    });
    expect(state.upserts).toHaveLength(0);
    expect((await getDatasetReplacementMarker(USER))?.generation).toBe(3);
  });

  it('preserves a conflicted managed write at retryCount 4 and records a conflict marker', async () => {
    await putDatasetReplacementMarker(
      marker({ status: 'applied', generation: 1, snapshot: null })
    );
    state.remoteGeneration = 1;
    state.rpc = () => ({ data: { status: 'conflict', generation: 2 }, error: null });

    const db = await getDB();
    const accountId = '22222222-2222-4222-8222-222222222222';
    await db.put(STORES.ACCOUNTS, {
      ...ACCOUNT,
      id: accountId,
      name: 'Kept Edit',
      updatedAt: 2,
    });
    await db.put(STORES.SYNC_QUEUE, {
      id: 'retried-write',
      storeName: STORES.ACCOUNTS,
      recordId: accountId,
      operation: 'update',
      payload: { ...ACCOUNT, id: accountId, name: 'Kept Edit', updatedAt: 2 },
      timestamp: 1,
      retryCount: 4,
      datasetGeneration: 1,
    });
    await db.put(STORES.SYNC_QUEUE, {
      id: 'later-write',
      storeName: STORES.CATEGORIES,
      recordId: 'cat-1',
      operation: 'create',
      payload: {
        id: 'cat-1',
        name: 'Later',
        type: 'expense',
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      timestamp: 2,
      retryCount: 0,
      datasetGeneration: 1,
    });

    await backgroundSync();

    const queued = await db.getAll(STORES.SYNC_QUEUE);
    expect(queued).toHaveLength(2);
    expect(queued.find((entry) => entry.id === 'retried-write')?.retryCount).toBe(4);
    expect(queued.find((entry) => entry.id === 'later-write')?.retryCount).toBe(0);
    expect(state.rpcCalls.filter((call) => call.name === 'apply_managed_write')).toHaveLength(1);

    const saved = await getDatasetReplacementMarker(USER);
    expect(saved?.status).toBe('conflict');
    expect(saved?.remoteGeneration).toBe(2);
    expect(saved?.snapshot?.accounts.map((account) => account.name)).toContain('Kept Edit');
    expect(await db.get(STORES.ACCOUNTS, accountId)).toMatchObject({ name: 'Kept Edit' });
    expect(state.selects).not.toContain(STORES.ACCOUNTS);
  });

  it('keeps non-managed stores on direct upserts', async () => {
    state.remoteGeneration = 1;
    const stockId = '11111111-1111-4111-8111-111111111111';
    const db = await getDB();
    await db.put(STORES.SYNC_QUEUE, {
      id: 'queued-stock',
      storeName: STORES.STOCKS,
      recordId: stockId,
      operation: 'create',
      payload: { id: stockId, ticker: 'BDO', createdAt: 1, updatedAt: 1 },
      timestamp: 1,
      retryCount: 0,
      datasetGeneration: 1,
    });

    await backgroundSync();

    expect(state.upserts.find((entry) => entry.table === 'stocks')?.payload.id).toBe(stockId);
    expect(state.rpcCalls.some((call) => call.name === 'apply_managed_write')).toBe(false);
  });

  it('routes managed soft deletes through the generation RPC', async () => {
    await putDatasetReplacementMarker(
      marker({ status: 'applied', generation: 1, snapshot: null })
    );
    state.remoteGeneration = 1;
    const db = await getDB();
    await db.put(STORES.SYNC_QUEUE, {
      id: 'queued-delete',
      storeName: STORES.ACCOUNTS,
      recordId: ACCOUNT.id,
      operation: 'delete',
      payload: null,
      timestamp: 1,
      retryCount: 0,
      datasetGeneration: 1,
    });

    await backgroundSync();

    const managedWrite = state.rpcCalls.find((call) => call.name === 'apply_managed_write');
    expect(managedWrite?.params).toMatchObject({
      p_generation: 1,
      p_store: 'accounts',
      p_operation: 'delete',
    });
    expect(state.updates).toHaveLength(0);
    expect(await getSyncQueueCount()).toBe(0);
  });

  it('routes entries stamped by a superseded generation to conflict instead of dropping them', async () => {
    state.remoteGeneration = 4;
    const db = await getDB();
    await db.put(STORES.SYNC_QUEUE, {
      id: 'stale-account',
      storeName: STORES.ACCOUNTS,
      recordId: ACCOUNT.id,
      operation: 'create',
      payload: ACCOUNT,
      timestamp: 1,
      retryCount: 0,
      datasetGeneration: 2,
    });

    await backgroundSync();

    expect(state.upserts).toHaveLength(0);
    expect(state.rpcCalls.filter((call) => call.name === 'apply_managed_write')).toHaveLength(0);
    expect(await getSyncQueueCount()).toBe(1);
    const saved = await getDatasetReplacementMarker(USER);
    expect(saved?.status).toBe('conflict');
    expect(saved?.remoteGeneration).toBe(4);
  });
});

  function remoteAccount(id: string, generation: number, updatedAt: number) {
    return {
      id,
      name: id,
      starting_balance: 0,
      sort_order: 0,
      user_id: USER,
      created_at: iso(1),
      updated_at: iso(updatedAt),
      deleted_at: null,
      dataset_generation: generation,
    };
  }

describe('remote generation refresh', () => {
  it('keeps an import marker committed while the initial marker is created', async () => {
    await importOffline(USER);
    const imported = await getDatasetReplacementMarker(USER);
    if (!imported) throw new Error('import did not write a replacement marker');
    expect(imported.status).toBe('pending');
    setActiveDatasetGeneration(0);

    state.remoteGeneration = 7;

    // The marker read observes absence while the import marker is committed,
    // which is the window a separate read and default-marker write would hit.
    const idbModule = jest.requireActual('./idb') as {
      getDatasetReplacementMarker: (
        userId: string
      ) => Promise<DatasetReplacementMarker | null>;
    };
    const staleRead = jest
      .spyOn(idbModule, 'getDatasetReplacementMarker')
      .mockResolvedValueOnce(null);

    try {
      await backgroundSync();
    } finally {
      staleRead.mockRestore();
    }

    expect(state.selects).toContain('dataset_generations');
    expect(await getDatasetReplacementMarker(USER)).toEqual(imported);

    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    try {
      await enqueueSyncEntry(STORES.ACCOUNTS, 'acct-after-race', 'update', {
        id: 'acct-after-race',
      });
    } finally {
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    }
    const queued = await (await getDB()).getAll(STORES.SYNC_QUEUE);
    expect(queued[0]?.datasetGeneration).toBe(imported.generation);
  });

  it('replaces local managed stores with the newer remote snapshot', async () => {
    await putDatasetReplacementMarker(
      marker({ status: 'applied', generation: 1, snapshot: null })
    );
    state.remoteGeneration = 3;
    state.pulls[STORES.ACCOUNTS] = [remoteAccount('remote-1', 3, 3)];
    const db = await getDB();
    await db.put(STORES.ACCOUNTS, {
      id: 'e5555555-5555-4555-8555-555555555555',
      name: 'Stale Local',
      startingBalance: 0,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    });

    await backgroundSync();

    const accounts = await db.getAll(STORES.ACCOUNTS);
    expect(accounts.map((account) => account.id)).toEqual(['remote-1']);
    expect((await getDatasetReplacementMarker(USER))?.generation).toBe(3);
  });

  it('reconciles the remote snapshot for a client with no local marker', async () => {
    // Fresh client: no dataset marker exists locally, but the cloud dataset
    // has already been replaced. The initial marker must be created at
    // generation 0 so the remote generation triggers a full reconcile rather
    // than a later pull preserving stale local-only managed rows.
    state.remoteGeneration = 3;
    state.pulls[STORES.ACCOUNTS] = [remoteAccount('remote-1', 3, 3)];
    const db = await getDB();
    await db.put(STORES.ACCOUNTS, {
      id: 'f6666666-6666-4666-8666-666666666666',
      name: 'Stale Local',
      startingBalance: 0,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    await db.put(STORES.TRANSACTIONS, {
      id: 'stale-local-tx',
      amount: 1,
      date: '2026-01-01',
      type: 'expense',
      category: 'Other',
      description: 'Stale Local',
      createdAt: 1,
      updatedAt: 1,
    });

    await backgroundSync();

    const marker = await getDatasetReplacementMarker(USER);
    expect(marker?.status).toBe('applied');
    expect(marker?.generation).toBe(3);
    expect((await db.getAll(STORES.ACCOUNTS)).map((account) => account.id)).toEqual([
      'remote-1',
    ]);
    expect(await db.getAll(STORES.TRANSACTIONS)).toHaveLength(0);
  });

  it('paginates remote managed rows beyond one page', async () => {
    await putDatasetReplacementMarker(
      marker({ status: 'applied', generation: 1, snapshot: null })
    );
    state.remoteGeneration = 3;
    state.pulls[STORES.ACCOUNTS] = Array.from({ length: 1001 }, (_, index) =>
      remoteAccount(`remote-${String(index).padStart(4, '0')}`, 3, 3)
    );

    await backgroundSync();

    const db = await getDB();
    expect(await db.count(STORES.ACCOUNTS)).toBe(1001);
  });

  it('surfaces a conflict and keeps local edits when managed writes are queued', async () => {
    const localId = 'a7777777-7777-4777-8777-777777777777';
    await putDatasetReplacementMarker(
      marker({ status: 'applied', generation: 1, snapshot: null })
    );
    state.remoteGeneration = 3;
    state.rpc = () => ({ data: { status: 'conflict', generation: 3 }, error: null });
    const db = await getDB();
    await db.put(STORES.ACCOUNTS, {
      id: localId,
      name: 'Pending Local',
      startingBalance: 0,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    await db.put(STORES.SYNC_QUEUE, {
      id: 'pending-write',
      storeName: STORES.ACCOUNTS,
      recordId: localId,
      operation: 'create',
      payload: {
        id: localId,
        name: 'Pending Local',
        startingBalance: 0,
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      timestamp: 1,
      retryCount: 0,
      datasetGeneration: 1,
    });

    await backgroundSync();

    const saved = await getDatasetReplacementMarker(USER);
    expect(saved?.status).toBe('conflict');
    expect(saved?.remoteGeneration).toBe(3);
    expect(saved?.snapshot?.accounts.map((account) => account.id)).toContain(localId);
    expect(await getSyncQueueCount()).toBe(1);
    expect((await db.getAll(STORES.ACCOUNTS)).map((account) => account.id)).toContain(localId);
  });

  it('saves a conflict when a managed write arrives during remote fetch', async () => {
    const localId = 'c3333333-3333-4333-8333-333333333333';
    await putDatasetReplacementMarker(
      marker({ status: 'applied', generation: 1, snapshot: null })
    );
    state.remoteGeneration = 3;
    state.rpc = () => ({ data: { status: 'conflict', generation: 3 }, error: null });
    state.pulls[STORES.ACCOUNTS] = [remoteAccount('remote-1', 3, 3)];
    const db = await getDB();
    await db.put(STORES.ACCOUNTS, {
      id: localId,
      name: 'Local',
      startingBalance: 0,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    });

    let injected = false;
    state.onSelect = async (table) => {
      if (table !== STORES.ACCOUNTS || injected) return;
      injected = true;
      await db.put(STORES.SYNC_QUEUE, {
        id: 'arrived-during-fetch',
        storeName: STORES.ACCOUNTS,
        recordId: localId,
        operation: 'create',
        payload: { id: localId, name: 'Local' },
        timestamp: 1,
        retryCount: 0,
        datasetGeneration: 1,
      });
    };

    await backgroundSync();

    const saved = await getDatasetReplacementMarker(USER);
    expect(saved?.status).toBe('conflict');
    expect(saved?.snapshot?.accounts.map((account) => account.id)).toContain(localId);
    expect(await getSyncQueueCount()).toBe(1);
    expect((await db.getAll(STORES.ACCOUNTS)).map((account) => account.id)).toContain(localId);
  });

  it('keeps an import committed while remote managed pages are fetched', async () => {
    await putDatasetReplacementMarker(
      marker({ status: 'applied', generation: 1, snapshot: null })
    );
    state.remoteGeneration = 3;
    state.pulls[STORES.ACCOUNTS] = [remoteAccount('stale-remote', 3, 3)];

    const db = await getDB();
    await db.put(STORES.ACCOUNTS, {
      id: 'd4444444-4444-4444-8444-444444444444',
      name: 'Before',
      startingBalance: 0,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    });

    const observed: {
      imported: DatasetReplacementMarker | null;
      pendingDuringReplace: DatasetReplacementMarker | null;
      accountsDuringReplace: Account[];
    } = { imported: null, pendingDuringReplace: null, accountsDuringReplace: [] };
    let injected = false;
    state.onSelect = async (table) => {
      if (table !== STORES.ACCOUNTS || injected) return;
      injected = true;
      await importOffline(USER);
      observed.imported = await getDatasetReplacementMarker(USER);
    };
    state.rpc = async () => {
      observed.pendingDuringReplace = await getDatasetReplacementMarker(USER);
      observed.accountsDuringReplace = await db.getAll(STORES.ACCOUNTS);
      return {
        data: { status: 'conflict', generation: 3 },
        error: null,
      };
    };

    await backgroundSync();

    expect(observed.pendingDuringReplace?.status).toBe('pending');
    expect(observed.pendingDuringReplace?.snapshotId).toBe(observed.imported!.snapshotId);
    expect(observed.pendingDuringReplace?.generation).toBe(observed.imported!.generation);
    expect(observed.accountsDuringReplace.map((account) => account.name).sort()).toEqual([
      'Imported Bank',
      'Imported Cash',
    ]);
    expect(observed.accountsDuringReplace.map((account) => account.id)).not.toContain(
      'stale-remote'
    );

    const accounts = await db.getAll(STORES.ACCOUNTS);
    expect(accounts.map((account) => account.name).sort()).toEqual([
      'Imported Bank',
      'Imported Cash',
    ]);
    expect(accounts.map((account) => account.id)).not.toContain('stale-remote');

    const saved = await getDatasetReplacementMarker(USER);
    expect(saved?.status).toBe('conflict');
    expect(saved?.remoteGeneration).toBe(3);
    expect(saved?.snapshotId).toBe(observed.imported!.snapshotId);
    expect(saved?.snapshot?.accounts.map((account) => account.name).sort()).toEqual([
      'Imported Bank',
      'Imported Cash',
    ]);
    const replaceCall = state.rpcCalls.find((call) => call.name === 'replace_user_dataset');
    expect(replaceCall?.params.p_snapshot_id).toBe(observed.imported!.snapshotId);
    expect(replaceCall?.params.p_generation).toBe(observed.imported!.generation);
  });

  it('adopts a local-only replacement marker for the authenticated user', async () => {
    await putDatasetReplacementMarker(
      marker({ userId: LOCAL_DATASET_OWNER, status: 'pending', generation: 1 })
    );
    state.remoteGeneration = 0;
    state.rpc = () => ({ data: { status: 'applied', generation: 1 }, error: null });

    await backgroundSync();

    const adopted = await getDatasetReplacementMarker(USER);
    expect(adopted?.status).toBe('applied');
    expect(adopted?.generation).toBe(1);
    expect(await getDatasetReplacementMarker(LOCAL_DATASET_OWNER)).toBeNull();
  });

  it('does not overwrite an existing user marker with a local-only marker', async () => {
    const existing = marker({ status: 'applied', generation: 5, snapshot: null });
    await putDatasetReplacementMarker(existing);
    await putDatasetReplacementMarker(
      marker({ userId: LOCAL_DATASET_OWNER, status: 'pending', generation: 2 })
    );
    state.remoteGeneration = 5;

    await backgroundSync();

    expect(await getDatasetReplacementMarker(USER)).toEqual(existing);
    expect((await getDatasetReplacementMarker(LOCAL_DATASET_OWNER))?.status).toBe('pending');
  });

  it('adopts the local marker and deletes the local key in one transaction', async () => {
    await putDatasetReplacementMarker(
      marker({
        userId: LOCAL_DATASET_OWNER,
        status: 'pending',
        generation: 2,
        snapshotId: 'local-snapshot',
      })
    );
    state.remoteGeneration = 0;
    state.rpc = () => ({ data: { status: 'applied', generation: 2 }, error: null });

    await backgroundSync();

    const adopted = await getDatasetReplacementMarker(USER);
    expect(adopted?.status).toBe('applied');
    expect(adopted?.generation).toBe(2);
    expect(adopted?.snapshotId).toBe('local-snapshot');
    expect(await getDatasetReplacementMarker(LOCAL_DATASET_OWNER)).toBeNull();
  });
});

describe('conflict resolution', () => {
  it('rebuilds the snapshot from current rows and keeps edits queued during the RPC', async () => {
    await putDatasetReplacementMarker(
      marker({
        status: 'conflict',
        generation: 1,
        remoteGeneration: 3,
        snapshot: snapshot({ accounts: [ACCOUNT] }),
      })
    );
    const db = await getDB();
    await db.put(STORES.ACCOUNTS, { ...ACCOUNT, name: 'Later' });
    await db.put(STORES.SYNC_QUEUE, {
      id: 'older-edit',
      storeName: STORES.ACCOUNTS,
      recordId: ACCOUNT.id,
      operation: 'update',
      payload: { ...ACCOUNT, name: 'Later' },
      timestamp: 1,
      retryCount: 0,
      datasetGeneration: 1,
    });

    let queuedDuring = false;
    state.rpc = async () => {
      if (!queuedDuring) {
        queuedDuring = true;
        await db.put(STORES.SYNC_QUEUE, {
          id: 'during-rpc',
          storeName: STORES.ACCOUNTS,
          recordId: ACCOUNT.id,
          operation: 'update',
          payload: { ...ACCOUNT, name: 'Latest' },
          timestamp: 2,
          retryCount: 0,
          datasetGeneration: 4,
        });
      }
      return { data: { status: 'applied', generation: 4 }, error: null };
    };

    const result = await resolveReplacementConflict(USER);

    expect(result?.status).toBe('applied');
    const call = state.rpcCalls.find((entry) => entry.name === 'replace_user_dataset');
    expect(call?.params.p_generation).toBe(4);
    expect(
      (call?.params.p_accounts as { name: string }[]).find((row) => row.name === 'Later')
    ).toBeDefined();
    const queued = await db.getAll(STORES.SYNC_QUEUE);
    expect(queued.map((entry) => entry.id)).toEqual(['during-rpc']);
  });

  it('keeps the marker and queued edits when the RPC fails', async () => {
    await putDatasetReplacementMarker(
      marker({
        status: 'conflict',
        generation: 1,
        remoteGeneration: 3,
        snapshot: snapshot(),
      })
    );
    const db = await getDB();
    state.rpc = async () => {
      await db.put(STORES.SYNC_QUEUE, {
        id: 'during-failure',
        storeName: STORES.ACCOUNTS,
        recordId: ACCOUNT.id,
        operation: 'update',
        payload: ACCOUNT,
        timestamp: 2,
        retryCount: 0,
        datasetGeneration: 4,
      });
      return { data: null, error: { message: 'offline' } };
    };

    const result = await resolveReplacementConflict(USER);

    expect(result?.status).toBe('failed');
    expect(result?.snapshot).not.toBeNull();
    expect(await getSyncQueueCount()).toBe(1);
  });

  it('leaves a marker that changed before resolution untouched and applies nothing', async () => {
    await putDatasetReplacementMarker(
      marker({
        status: 'conflict',
        generation: 1,
        remoteGeneration: 3,
        snapshot: snapshot({ accounts: [ACCOUNT] }),
      })
    );
    const imported = marker({
      status: 'pending',
      generation: 5,
      snapshotId: 'imported-snapshot',
      snapshot: snapshot({ accounts: [{ ...ACCOUNT, name: 'Imported' }] }),
    });
    await putDatasetReplacementMarker(imported);

    const result = await resolveReplacementConflict(USER);

    expect(result).toEqual(imported);
    expect(await getDatasetReplacementMarker(USER)).toEqual(imported);
    expect(state.rpcCalls.filter((call) => call.name === 'replace_user_dataset')).toHaveLength(0);
  });
});

describe('pullStore generation fence', () => {
  it('drops rows from superseded generations instead of resurrecting them', async () => {
    await putDatasetReplacementMarker(marker({ status: 'applied', generation: 3, snapshot: null }));
    const db = await getDB();
    await db.put(STORES.ACCOUNTS, {
      id: 'stale-local',
      name: 'Stale Local',
      startingBalance: 0,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    state.pulls[STORES.ACCOUNTS] = [
      {
        id: 'stale-local',
        name: 'Stale Local',
        starting_balance: 0,
        sort_order: 0,
        user_id: USER,
        created_at: iso(1),
        updated_at: iso(2),
        deleted_at: null,
        dataset_generation: 1,
      },
      {
        id: 'stale-remote-only',
        name: 'Stale Remote',
        starting_balance: 0,
        sort_order: 0,
        user_id: USER,
        created_at: iso(1),
        updated_at: iso(2),
        deleted_at: null,
        dataset_generation: 1,
      },
      {
        id: 'current',
        name: 'Current',
        starting_balance: 0,
        sort_order: 0,
        user_id: USER,
        created_at: iso(1),
        updated_at: iso(3),
        deleted_at: null,
        dataset_generation: 3,
      },
    ];

    await pullStore(STORES.ACCOUNTS, USER, 3);

    const accounts = await db.getAll(STORES.ACCOUNTS);
    expect(accounts.map((account) => account.id)).toEqual(['current']);
  });
});


describe('import sync interleavings', () => {
  it('rejects an old pull after an import commits during SELECT', async () => {
    await putDatasetReplacementMarker(marker({ status: 'applied', generation: 1, snapshot: null }));
    state.pulls.accounts = [remoteAccount('obsolete', 1, 10)];
    state.onSelect = async () => {
      state.onSelect = null;
      await importOffline(USER);
    };
    await expect(pullStore(STORES.ACCOUNTS, USER, 1)).rejects.toThrow('Local dataset changed');
    const db = await getDB();
    expect(await db.get(STORES.ACCOUNTS, 'obsolete')).toBeUndefined();
    expect(await db.count(STORES.ACCOUNTS)).toBe(2);
  });

  it('does not consume a newer generation queue from an old cycle', async () => {
    await putDatasetReplacementMarker(marker({ status: 'applied', generation: 1, snapshot: null }));
    const db = await getDB();
    await db.put(STORES.SYNC_QUEUE, { id: 'newer', recordId: ACCOUNT.id, storeName: STORES.ACCOUNTS,
      operation: 'update', payload: ACCOUNT, timestamp: 1, retryCount: 0, datasetGeneration: 2 });
    await expect(processSyncQueue(1)).rejects.toThrow();
    expect(state.rpcCalls).toHaveLength(0);
    expect(await getSyncQueueCount()).toBe(1);
  });

  it('rebases and persists a post-snapshot edit after replacement server timestamps', async () => {
    await putDatasetReplacementMarker(marker());
    const db = await getDB();
    await db.put(STORES.ACCOUNTS, { ...ACCOUNT, name: 'Edited', updatedAt: 2 });
    await db.put(STORES.SYNC_QUEUE, { id: 'edit', recordId: ACCOUNT.id, storeName: STORES.ACCOUNTS,
      operation: 'update', payload: { ...ACCOUNT, name: 'Edited', updatedAt: 2 }, timestamp: 2,
      retryCount: 0, datasetGeneration: 2 });
    state.rpc = (params) => {
      if ('p_snapshot_id' in params) {
        state.pulls.accounts = [{ ...remoteAccount(ACCOUNT.id, 2, 10000), name: 'Original' }];
      } else {
        const incoming = params.p_record as Record<string, unknown>;
        const existing = state.pulls.accounts[0];
        if (new Date(incoming.updated_at as string).getTime() > new Date(existing.updated_at as string).getTime()) {
          state.pulls.accounts = [incoming];
        }
      }
      return { data: { status: 'applied', generation: 2 }, error: null };
    };
    await applyDatasetReplacement(USER);
    await processSyncQueue(2);
    await pullStore(STORES.ACCOUNTS, USER, 2);
    expect(await getSyncQueueCount()).toBe(0);
    expect((await db.get(STORES.ACCOUNTS, ACCOUNT.id))?.name).toBe('Edited');
  });

  it('acknowledges cash writes without requiring an absent updated_at column', async () => {
    await putDatasetReplacementMarker(marker({ status: 'applied', generation: 2, snapshot: null }));
    const db = await getDB();
    const payload = { id: 'cash-row', date: '2026-01-01', denomination: 100, count: 2, createdAt: 1 };
    await db.put(STORES.SYNC_QUEUE, { id: 'cash-edit', recordId: payload.id,
      storeName: STORES.CASH_DENOMINATIONS, operation: 'create', payload, timestamp: 2,
      retryCount: 0, datasetGeneration: 2 });
    await processSyncQueue(2);
    expect(await getSyncQueueCount()).toBe(0);
    expect(state.pulls.cash_denominations[0].count).toBe(2);
  });

  it.each([STORES.PAYOUTS, STORES.BUDGET_TARGETS, STORES.CATEGORIES])(
    'verifies %s writes with omitted local timestamps and client-only fields', async (store) => {
      await putDatasetReplacementMarker(marker({ status: 'applied', generation: 2, snapshot: null }));
      const db = await getDB();
      await db.put(STORES.SYNC_QUEUE, { id: 'edit', recordId: 'record', storeName: store,
        operation: 'update', payload: { id: 'record', name: 'Edited', hasDestinationAccount: true },
        timestamp: 1, retryCount: 0, datasetGeneration: 2 });
      state.rpc = (params) => {
        const row = { ...(params.p_record as Record<string, unknown>) };
        delete row.hasDestinationAccount;
        state.pulls[params.p_store as string] = [row];
        return { data: { status: 'applied', generation: 2 }, error: null };
      };
      await processSyncQueue(2);
      expect(await getSyncQueueCount()).toBe(0);
      expect((state.rpcCalls[0].params.p_record as Record<string, unknown>).updated_at).toBeDefined();
    }
  );

  it('acknowledges earlier persisted entries when a later managed write fails', async () => {
    await putDatasetReplacementMarker(marker({ status: 'applied', generation: 2, snapshot: null }));
    const db = await getDB();
    for (const [index, name] of ['First', 'Second'].entries()) {
      await db.put(STORES.SYNC_QUEUE, { id: name, recordId: ACCOUNT.id, storeName: STORES.ACCOUNTS,
        operation: 'update', payload: { ...ACCOUNT, name, updatedAt: index + 2 }, timestamp: index,
        retryCount: 0, datasetGeneration: 2 });
    }
    state.rpc = (params) => {
      const incoming = params.p_record as Record<string, unknown>;
      if (incoming.name === 'First') state.pulls.accounts = [incoming];
      return { data: { status: 'applied', generation: 2 }, error: null };
    };
    await expect(processSyncQueue(2)).rejects.toThrow('not persisted');
    expect((await db.getAll(STORES.SYNC_QUEUE)).map((entry) => entry.id)).toEqual(['Second']);
  });

  it('retains an LWW-rejected edit without exhausting retries or overwriting it on pull', async () => {
    await putDatasetReplacementMarker(marker({ status: 'applied', generation: 2, snapshot: null }));
    const db = await getDB();
    await db.put(STORES.ACCOUNTS, { ...ACCOUNT, name: 'Edited', updatedAt: 2 });
    await db.put(STORES.SYNC_QUEUE, { id: 'edit', recordId: ACCOUNT.id, storeName: STORES.ACCOUNTS,
      operation: 'update', payload: { ...ACCOUNT, name: 'Edited', updatedAt: 2 }, timestamp: 2,
      retryCount: 4, datasetGeneration: 2 });
    state.pulls.accounts = [remoteAccount(ACCOUNT.id, 2, 10000)];
    state.rpc = () => ({ data: { status: 'applied', generation: 2 }, error: null });
    await expect(processSyncQueue(2)).rejects.toThrow('not persisted');
    await pullStore(STORES.ACCOUNTS, USER, 2);
    expect((await db.get(STORES.SYNC_QUEUE, 'edit'))?.retryCount).toBe(4);
    expect((await db.get(STORES.ACCOUNTS, ACCOUNT.id))?.name).toBe('Edited');
  });
});


describe('same-generation managed write conflicts', () => {
  it.each([
    [STORES.ACCOUNTS, { ...ACCOUNT, name: 'Local edit' }],
    [STORES.CATEGORIES, { id: ACCOUNT.id, name: 'Local edit', type: 'expense', createdAt: 1 }],
    [STORES.TRANSACTIONS, { id: ACCOUNT.id, amount: 25, date: '2026-01-01', type: 'expense',
      category: 'Food', fromAccount: null, toAccount: null, createdAt: 1 }],
    [STORES.PAYOUTS, { id: ACCOUNT.id, date: '2026-01-01', totalAmount: 25, splitMode: 'amount', splits: [] }],
    [STORES.BUDGET_TARGETS, { id: ACCOUNT.id, category: 'Food', month: '2026-01', amount: 25 }],
  ] as const)('exposes resolution and recovers a rejected %s edit', async (store, value) => {
    await putDatasetReplacementMarker(marker({ status: 'applied', generation: 2, snapshot: null }));
    state.remoteGeneration = 2;
    const db = await getDB();
    const local = { ...value, id: 'a1111111-1111-4111-8111-111111111111', updatedAt: 2 };
    await db.put(store, local as never);
    await db.put(STORES.SYNC_QUEUE, { id: 'rejected', recordId: local.id, storeName: store,
      operation: 'update', payload: local, timestamp: 1, retryCount: 4, datasetGeneration: 2 });
    await db.put(STORES.SYNC_QUEUE, { id: 'later', recordId: 'later', storeName: STORES.STOCKS,
      operation: 'create', payload: { id: 'later' }, timestamp: 2, retryCount: 0 });
    const table = store === STORES.BUDGET_TARGETS ? 'budget_targets' : store;
    state.pulls[table] = [{ id: local.id, updated_at: iso(10000), dataset_generation: 2 }];
    state.rpc = () => ({ data: { status: 'applied', generation: 2 }, error: null });
    let completions = 0;
    const onComplete = () => { completions++; };
    window.addEventListener('sync-complete', onComplete);
    try {
      await backgroundSync();
      const conflicted = await getDatasetReplacementMarker(USER);
      expect(conflicted?.status).toBe('conflict');
      expect(conflicted?.remoteGeneration).toBe(2);
      expect(conflicted?.lastError).toContain('explicit resolution');
      expect(conflicted?.snapshot?.[store]).toContainEqual(local);
      expect(await db.get(store, local.id)).toEqual(local);
      expect((await db.get(STORES.SYNC_QUEUE, 'rejected'))?.retryCount).toBe(4);
      expect(await db.get(STORES.SYNC_QUEUE, 'later')).toBeDefined();
      expect(completions).toBe(1);
      expect(state.selects).toEqual(['dataset_generations', table]);
      const calls = state.rpcCalls.length;
      await backgroundSync();
      expect(state.rpcCalls).toHaveLength(calls);
      state.rpc = (params) => {
        state.remoteGeneration = Number(params.p_generation);
        state.pulls[table] = params[`p_${table}`] as Record<string, unknown>[];
        return { data: { status: 'applied', generation: params.p_generation }, error: null };
      };
      const resolved = await resolveReplacementConflict(USER);
      expect(resolved?.status).toBe('applied');
      expect(resolved?.generation).toBe(3);
      expect(await db.get(store, local.id)).toEqual(local);
      await backgroundSync();
      expect(await getSyncQueueCount()).toBe(0);
      expect(state.upserts.some((write) => write.table === 'stocks')).toBe(true);
      expect(localStorage.getItem('last_sync_time')).not.toBeNull();
    } finally {
      window.removeEventListener('sync-complete', onComplete);
    }
  });
});
