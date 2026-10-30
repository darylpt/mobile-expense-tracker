import 'fake-indexeddb/auto';

if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (val: unknown) => JSON.parse(JSON.stringify(val));
}

import { STORES } from './constants';
import { getDB } from './idb';
import { LOCAL_DATASET_OWNER, type DatasetReplacementMarker } from './dataset-replacement';

function marker(overrides: Partial<DatasetReplacementMarker> = {}): DatasetReplacementMarker {
  return {
    userId: LOCAL_DATASET_OWNER,
    generation: 7,
    snapshotId: 'prior-snapshot',
    status: 'applied',
    snapshot: null,
    remoteGeneration: null,
    attempts: 0,
    lastError: null,
    updatedAt: 1,
    ...overrides,
  };
}

beforeAll(() => {
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
});

describe('getDB first open', () => {
  it('stamps a queued write started during initialization with the persisted generation', async () => {
    const seeded = await getDB();
    await seeded.put(STORES.DATASET_MARKERS, marker());
    seeded.close();

    // A fresh module registry clears dbPromise and the generation cache while
    // fake-indexeddb keeps the stores, reproducing the first open after a reload.
    // The import must be dynamic: a static import above keeps the initialized instance.
    jest.resetModules();
    const fresh = await import('./idb');

    const firstOpen = fresh.getDB();
    const queued = fresh.enqueueSyncEntry(STORES.ACCOUNTS, 'acct-first-open', 'create', {
      id: 'acct-first-open',
      name: 'First Open',
    });

    await Promise.all([firstOpen, queued]);

    const db = await fresh.getDB();
    const entries = await db.getAll(STORES.SYNC_QUEUE);

    expect((await fresh.getDatasetReplacementMarker(LOCAL_DATASET_OWNER))?.generation).toBe(7);
    expect(entries.find((entry) => entry.recordId === 'acct-first-open')?.datasetGeneration).toBe(7);
  });
});
