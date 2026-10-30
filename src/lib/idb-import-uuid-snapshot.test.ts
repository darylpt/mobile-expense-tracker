import 'fake-indexeddb/auto';

if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (val: unknown) => JSON.parse(JSON.stringify(val));
}

import { STORES } from './constants';
import {
  clearAllLocalData,
  ensureUuids,
  getDB,
  getDatasetReplacementMarker,
  importFromCsv,
  putDatasetReplacementMarker,
} from './idb';
import {
  LOCAL_DATASET_OWNER,
  type DatasetReplacementMarker,
  type DatasetSnapshot,
} from './dataset-replacement';
import type { Account, Category, Transaction } from '@/types';

const HEADER = 'Date,Amount,Description,Type,Category,From Account,To Account';
const LEGACY_CASH_ID = 'cash-legacy-account';
const LEGACY_CATEGORY_ID = 'category-legacy-food';
const UUID_MIGRATION_DONE_KEY = 'uuid_migration_v2_done';
const LEGACY_UUID_MIGRATION_DONE_KEY = 'uuid_migration_done';

function account(overrides: Partial<Account> & Pick<Account, 'id' | 'name'>): Account {
  return {
    startingBalance: 0,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function category(overrides: Partial<Category> & Pick<Category, 'id' | 'name'>): Category {
  return {
    type: 'expense',
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function transaction(
  overrides: Partial<Transaction> & Pick<Transaction, 'id' | 'type' | 'amount'>
): Transaction {
  return {
    date: '2026-01-05',
    category: 'Food',
    fromAccount: null,
    toAccount: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function marker(overrides: Partial<DatasetReplacementMarker> = {}): DatasetReplacementMarker {
  return {
    userId: LOCAL_DATASET_OWNER,
    generation: 1,
    snapshotId: 'snapshot-1',
    status: 'pending',
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

beforeEach(async () => {
  await clearAllLocalData();
  localStorage.removeItem(LEGACY_UUID_MIGRATION_DONE_KEY);
  localStorage.removeItem(UUID_MIGRATION_DONE_KEY);
});

describe('UUID migration of an imported replacement snapshot', () => {
  it('rewrites snapshot account ids and transaction references to the migrated local account ids', async () => {
    const db = await getDB();
    await db.put(STORES.ACCOUNTS, account({ id: LEGACY_CASH_ID, name: 'Cash' }));
    await db.put(STORES.BALANCE_SNAPSHOTS, {
      id: LEGACY_CASH_ID,
      accountId: LEGACY_CASH_ID,
      value: 2500,
      updatedAt: 1,
      createdAt: 1,
    });
    await db.put(STORES.SYNC_QUEUE, {
      id: 'queue-balance',
      storeName: STORES.BALANCE_SNAPSHOTS,
      recordId: LEGACY_CASH_ID,
      operation: 'update',
      payload: {
        id: LEGACY_CASH_ID,
        accountId: LEGACY_CASH_ID,
        value: 2500,
        updatedAt: 1,
        createdAt: 1,
      },
      timestamp: 1,
      retryCount: 0,
    });

    const csv = [
      HEADER,
      '1/5/2026,₱100.00,Savings,Transfer,Savings Transfer,Cash,GoTyme',
    ].join('\n');
    await importFromCsv(csv);

    const imported = await getDatasetReplacementMarker(LOCAL_DATASET_OWNER);
    expect(imported?.snapshot?.accounts.find((item) => item.name === 'Cash')?.id).toBe(
      LEGACY_CASH_ID
    );
    expect(imported?.snapshot?.transactions[0]?.fromAccount).toBe(LEGACY_CASH_ID);

    await ensureUuids();

    const accounts = await db.getAll(STORES.ACCOUNTS);
    const categories = await db.getAll(STORES.CATEGORIES);
    const transactions = await db.getAll(STORES.TRANSACTIONS);
    const cashAccounts = accounts.filter((item) => item.name === 'Cash');
    expect(cashAccounts).toHaveLength(1);
    const migratedCash = cashAccounts[0];
    expect(migratedCash.id).not.toBe(LEGACY_CASH_ID);
    expect(accounts.map((item) => item.id)).not.toContain(LEGACY_CASH_ID);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].fromAccount).toBe(migratedCash.id);

    const snapshots = await db.getAll(STORES.BALANCE_SNAPSHOTS);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].id).toBe(migratedCash.id);
    expect(snapshots[0].accountId).toBe(migratedCash.id);

    const queue = await db.getAll(STORES.SYNC_QUEUE);
    const balanceEntry = queue.find((entry) => entry.storeName === STORES.BALANCE_SNAPSHOTS);
    const balancePayload = balanceEntry?.payload as { id?: string; accountId?: string } | undefined;
    expect(balanceEntry?.recordId).toBe(migratedCash.id);
    expect(balancePayload?.id).toBe(migratedCash.id);
    expect(balancePayload?.accountId).toBe(migratedCash.id);

    const saved = await getDatasetReplacementMarker(LOCAL_DATASET_OWNER);
    const snapshotAccounts = saved?.snapshot?.accounts.filter((item) => item.name === 'Cash') ?? [];
    expect(snapshotAccounts).toHaveLength(1);
    expect(snapshotAccounts[0].id).toBe(migratedCash.id);
    expect(saved?.snapshot?.accounts.map((item) => item.id)).not.toContain(LEGACY_CASH_ID);
    expect(saved?.snapshot?.transactions[0]?.fromAccount).toBe(migratedCash.id);
    expect(saved?.snapshot?.transactions[0]?.toAccount).toBe(transactions[0].toAccount);
    expect(saved?.snapshot?.transactions[0]?.id).toBe(transactions[0].id);
    expect(saved?.snapshot?.categories.map((item) => item.id)).toEqual(
      categories.map((item) => item.id)
    );
    expect(localStorage.getItem(UUID_MIGRATION_DONE_KEY)).toBe('1');
  });

  it('remaps legacy category ids and every persisted marker snapshot', async () => {
    const db = await getDB();
    await db.put(STORES.ACCOUNTS, account({ id: LEGACY_CASH_ID, name: 'Cash' }));
    await db.put(STORES.CATEGORIES, category({ id: LEGACY_CATEGORY_ID, name: 'Food' }));
    const legacyTransaction = transaction({
      id: '11111111-1111-4111-8111-111111111111',
      type: 'expense',
      amount: 20,
      category: 'Food',
      fromAccount: LEGACY_CASH_ID,
    });
    await db.put(STORES.TRANSACTIONS, legacyTransaction);

    const snapshot: DatasetSnapshot = {
      accounts: [account({ id: LEGACY_CASH_ID, name: 'Cash' })],
      categories: [category({ id: LEGACY_CATEGORY_ID, name: 'Food' })],
      transactions: [legacyTransaction],
      cashDenominations: [],
      payouts: [],
      budgetTargets: [],
    };
    await putDatasetReplacementMarker(
      marker({ userId: LOCAL_DATASET_OWNER, snapshot, snapshotId: 'local-snapshot' })
    );
    await putDatasetReplacementMarker(
      marker({
        userId: 'user-1',
        snapshot,
        snapshotId: 'cloud-snapshot',
        generation: 4,
        status: 'applied',
      })
    );

    await ensureUuids();

    const accounts = await db.getAll(STORES.ACCOUNTS);
    const categories = await db.getAll(STORES.CATEGORIES);
    const transactions = await db.getAll(STORES.TRANSACTIONS);
    expect(accounts).toHaveLength(1);
    expect(categories).toHaveLength(1);
    expect(accounts[0].id).not.toBe(LEGACY_CASH_ID);
    expect(categories[0].id).not.toBe(LEGACY_CATEGORY_ID);
    expect(transactions[0].fromAccount).toBe(accounts[0].id);
    expect(localStorage.getItem(UUID_MIGRATION_DONE_KEY)).toBe('1');

    for (const userId of [LOCAL_DATASET_OWNER, 'user-1']) {
      const saved = await getDatasetReplacementMarker(userId);
      expect(saved?.snapshot?.accounts.map((item) => item.id)).toEqual([accounts[0].id]);
      expect(saved?.snapshot?.categories.map((item) => item.id)).toEqual([categories[0].id]);
      expect(saved?.snapshot?.transactions[0]?.fromAccount).toBe(accounts[0].id);
      expect(saved?.snapshot?.transactions[0]?.id).toBe(transactions[0].id);
    }

    const cloudMarker = await getDatasetReplacementMarker('user-1');
    expect(cloudMarker?.generation).toBe(4);
    expect(cloudMarker?.snapshotId).toBe('cloud-snapshot');
    expect(cloudMarker?.status).toBe('applied');
  });

  it('reruns the corrected migration when only the legacy completion flag is set', async () => {
    const db = await getDB();
    await db.put(STORES.CATEGORIES, category({ id: LEGACY_CATEGORY_ID, name: 'Food' }));
    await putDatasetReplacementMarker(
      marker({
        snapshot: {
          accounts: [],
          categories: [category({ id: LEGACY_CATEGORY_ID, name: 'Food' })],
          transactions: [],
          cashDenominations: [],
          payouts: [],
          budgetTargets: [],
        },
        snapshotId: 'stale-flag-snapshot',
      })
    );
    localStorage.setItem(LEGACY_UUID_MIGRATION_DONE_KEY, '1');
    expect(localStorage.getItem(UUID_MIGRATION_DONE_KEY)).toBeNull();

    await ensureUuids();

    const categories = await db.getAll(STORES.CATEGORIES);
    expect(categories).toHaveLength(1);
    const migratedCategoryId = categories[0].id;
    expect(migratedCategoryId).not.toBe(LEGACY_CATEGORY_ID);

    const saved = await getDatasetReplacementMarker(LOCAL_DATASET_OWNER);
    expect(saved?.snapshot?.categories.map((item) => item.id)).toEqual([migratedCategoryId]);
    expect(localStorage.getItem(LEGACY_UUID_MIGRATION_DONE_KEY)).toBe('1');
    expect(localStorage.getItem(UUID_MIGRATION_DONE_KEY)).toBe('1');
  });

  it('does not write the completion flag when the migration fails', async () => {
    const db = await getDB();
    await db.put(STORES.CATEGORIES, category({ id: LEGACY_CATEGORY_ID, name: 'Food' }));
    localStorage.setItem(LEGACY_UUID_MIGRATION_DONE_KEY, '1');

    const randomUUIDDescriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
    Object.defineProperty(crypto, 'randomUUID', {
      configurable: true,
      value: () => {
        throw new Error('uuid generation failed');
      },
    });

    try {
      await expect(ensureUuids()).rejects.toThrow('uuid generation failed');
    } finally {
      if (randomUUIDDescriptor) {
        Object.defineProperty(crypto, 'randomUUID', randomUUIDDescriptor);
      } else {
        delete (crypto as unknown as Record<string, unknown>).randomUUID;
      }
    }

    const categories = await db.getAll(STORES.CATEGORIES);
    expect(categories).toHaveLength(1);
    expect(categories[0].id).toBe(LEGACY_CATEGORY_ID);
    expect(localStorage.getItem(UUID_MIGRATION_DONE_KEY)).toBeNull();
  });
});
