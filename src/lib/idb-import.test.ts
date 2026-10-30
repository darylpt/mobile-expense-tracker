import 'fake-indexeddb/auto';

if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (val: unknown) => JSON.parse(JSON.stringify(val));
}

import { STORES } from './constants';
import {
  clearAllLocalData,
  getDB,
  getDatasetReplacementMarker,
  getOrphanAccountGroups,
  getSyncQueueCount,
  importFromCsv,
  putDatasetReplacementMarker,
  relinkOrphanedAccountRefs,
} from './idb';
import { LOCAL_DATASET_OWNER, type DatasetReplacementMarker } from './dataset-replacement';
import type { Account, BalanceSnapshot, Transaction } from '@/types';

const HEADER = 'Date,Amount,Description,Type,Category,From Account,To Account';

function account(overrides: Partial<Account> & Pick<Account, 'id' | 'name'>): Account {
  return {
    startingBalance: 0,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function transaction(overrides: Partial<Transaction> & Pick<Transaction, 'id' | 'type' | 'amount'>): Transaction {
  return {
    date: '2026-01-01',
    category: 'Other',
    fromAccount: null,
    toAccount: null,
    description: '',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

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

beforeEach(async () => {
  await clearAllLocalData();
});

describe('importFromCsv replacement marker', () => {
  it('commits data, marker snapshot, and queue cleanup in one replacement', async () => {
    const db = await getDB();
    await db.put(
      STORES.ACCOUNTS,
      account({ id: 'acct-cash', name: 'Cash', sortOrder: 0 })
    );
    await db.put(STORES.BALANCE_SNAPSHOTS, {
      id: 'acct-cash',
      accountId: 'acct-cash',
      value: 75,
      updatedAt: 1,
      createdAt: 1,
    } satisfies BalanceSnapshot);
    await db.put(
      STORES.SYNC_QUEUE,
      {
        id: 'stale-queue',
        storeName: STORES.ACCOUNTS,
        recordId: 'old-account',
        operation: 'create',
        payload: account({ id: 'old-account', name: 'Old' }),
        timestamp: 1,
        retryCount: 0,
      }
    );

    const csv = [
      HEADER,
      '1/5/2026,₱100.00,Savings,Transfer,Savings Transfer,Cash,GoTyme',
    ].join('\n');

    const parsed = await importFromCsv(csv);

    const accounts = await db.getAll(STORES.ACCOUNTS);
    const transactions = await db.getAll(STORES.TRANSACTIONS);
    const saved = await getDatasetReplacementMarker(LOCAL_DATASET_OWNER);

    expect(accounts.find((item) => item.name === 'Cash')?.id).toBe('acct-cash');
    expect(transactions).toHaveLength(1);
    expect(transactions[0].fromAccount).toBe('acct-cash');
    expect(transactions[0].toAccount).not.toBe('acct-cash');
    expect(parsed.transactions).toHaveLength(1);

    expect(saved?.status).toBe('pending');
    expect(saved?.generation).toBe(1);
    expect(saved?.snapshot?.accounts.map((item) => item.id).sort()).toEqual(
      accounts.map((item) => item.id).sort()
    );
    expect(saved?.snapshot?.transactions).toEqual(transactions);
    expect(saved?.snapshot?.cashDenominations).toEqual([]);

    expect(await getSyncQueueCount()).toBe(0);
    expect(await db.get(STORES.BALANCE_SNAPSHOTS, 'acct-cash')).toBeDefined();
  });

  it('writes the replacement marker under the authenticated user id', async () => {
    const csv = [
      HEADER,
      '1/5/2026,₱100.00,Savings,Transfer,Savings Transfer,Cash,GoTyme',
    ].join('\n');

    await importFromCsv(csv, 'user-9');

    expect(await getDatasetReplacementMarker('user-9')).not.toBeNull();
    expect(await getDatasetReplacementMarker(LOCAL_DATASET_OWNER)).toBeNull();
  });

  it('removes an obsolete local-only marker when an authenticated user imports', async () => {
    await putDatasetReplacementMarker(
      marker({ status: 'pending', generation: 4, snapshotId: 'local-only' })
    );
    const csv = [
      HEADER,
      '1/5/2026,₱100.00,Savings,Transfer,Savings Transfer,Cash,GoTyme',
    ].join('\n');

    await importFromCsv(csv, 'user-9');

    expect(await getDatasetReplacementMarker(LOCAL_DATASET_OWNER)).toBeNull();
    const imported = await getDatasetReplacementMarker('user-9');
    expect(imported?.status).toBe('pending');
    expect(imported?.snapshotId).not.toBe('local-only');
  });

  it('keeps only the latest snapshot and generation after re-importing twice', async () => {
    const csv = [
      HEADER,
      '1/5/2026,₱100.00,Savings,Transfer,Savings Transfer,Cash,GoTyme',
    ].join('\n');

    await importFromCsv(csv);
    const first = await getDatasetReplacementMarker(LOCAL_DATASET_OWNER);

    await importFromCsv(csv);
    const second = await getDatasetReplacementMarker(LOCAL_DATASET_OWNER);

    expect(first?.generation).toBe(1);
    expect(second?.generation).toBe(2);
    expect(second?.snapshotId).not.toBe(first?.snapshotId);
    expect(second?.snapshot?.transactions).toHaveLength(1);
    const db = await getDB();
    expect(await db.getAll(STORES.TRANSACTIONS)).toHaveLength(1);
    expect(await getSyncQueueCount()).toBe(0);
  });

  it('leaves previous data and marker intact when the replacement write fails', async () => {
    const db = await getDB();
    const existingAccount = account({ id: 'existing-1', name: 'Existing' });
    const existingTransaction = transaction({
      id: 'existing-tx',
      type: 'expense',
      amount: 25,
      fromAccount: 'existing-1',
    });
    await db.put(STORES.ACCOUNTS, existingAccount);
    await db.put(STORES.TRANSACTIONS, existingTransaction);
    await putDatasetReplacementMarker(marker());

    const originalRandomUUID = globalThis.crypto.randomUUID;
    const fixedUuid = '00000000-0000-4000-8000-000000000000';
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      value: () => fixedUuid,
      configurable: true,
    });

    try {
      const csv = [
        HEADER,
        '1/5/2026,₱10.00,First,Expense,Food,Alpha,',
        '1/6/2026,₱20.00,Second,Expense,Food,Beta,',
      ].join('\n');
      await expect(importFromCsv(csv)).rejects.toThrow();
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        value: originalRandomUUID,
        configurable: true,
      });
    }

    expect(await db.getAll(STORES.ACCOUNTS)).toEqual([existingAccount]);
    expect(await db.getAll(STORES.TRANSACTIONS)).toEqual([existingTransaction]);
    expect(await getDatasetReplacementMarker(LOCAL_DATASET_OWNER)).toEqual(marker());
  });
});

describe('relinkOrphanedAccountRefs', () => {
  it('updates only the selected missing account references and deletes nothing', async () => {
    const db = await getDB();
    await db.put(STORES.ACCOUNTS, account({ id: 'acct-bank', name: 'Bank' }));

    const fromOrphan = transaction({
      id: 'from-orphan',
      type: 'expense',
      amount: 42.5,
      date: '2026-06-01',
      category: 'Food',
      description: 'Lunch',
      fromAccount: 'missing-a',
    });
    const toOrphan = transaction({
      id: 'to-orphan',
      type: 'income',
      amount: 900,
      date: '2026-06-02',
      category: 'Salary',
      toAccount: 'missing-a',
    });
    const other = transaction({
      id: 'other',
      type: 'expense',
      amount: 5,
      fromAccount: 'missing-b',
    });
    for (const record of [fromOrphan, toOrphan, other]) {
      await db.put(STORES.TRANSACTIONS, record);
    }

    const count = await relinkOrphanedAccountRefs(
      'missing-a',
      'acct-bank',
      ['from-orphan', 'to-orphan']
    );

    const saved = await db.getAll(STORES.TRANSACTIONS);
    const byId = new Map(saved.map((record) => [record.id, record]));
    expect(count).toBe(2);
    expect(saved).toHaveLength(3);
    expect(byId.get('from-orphan')).toEqual({
      ...fromOrphan,
      fromAccount: 'acct-bank',
      updatedAt: expect.any(Number),
    });
    expect(byId.get('to-orphan')).toEqual({
      ...toOrphan,
      toAccount: 'acct-bank',
      updatedAt: expect.any(Number),
    });
    expect(byId.get('other')).toEqual(other);
    expect(await getSyncQueueCount()).toBe(2);

    const groups = await getOrphanAccountGroups();
    expect(groups.map((group) => group.accountId)).toEqual(['missing-b']);
  });

  it('rejects a target that is not an existing account', async () => {
    await expect(
      relinkOrphanedAccountRefs('missing-a', 'not-an-account', [])
    ).rejects.toThrow('Target account not found.');
  });

  it('rejects a stale reviewed transaction set without writing', async () => {
    const db = await getDB();
    await db.put(STORES.ACCOUNTS, account({ id: 'acct-bank', name: 'Bank' }));
    const record = transaction({
      id: 'arrived-later',
      type: 'expense',
      amount: 10,
      fromAccount: 'missing-a',
    });
    await db.put(STORES.TRANSACTIONS, record);

    await expect(
      relinkOrphanedAccountRefs('missing-a', 'acct-bank', [])
    ).rejects.toThrow('transactions changed');

    expect(await db.getAll(STORES.TRANSACTIONS)).toEqual([record]);
    expect(await getSyncQueueCount()).toBe(0);
  });

  it('rejects transfers that would use the same account on both sides', async () => {
    const db = await getDB();
    await db.put(STORES.ACCOUNTS, account({ id: 'acct-bank', name: 'Bank' }));
    const toTarget = transaction({
      id: 'orphan-to-target',
      type: 'transaction',
      amount: 10,
      fromAccount: 'missing-a',
      toAccount: 'acct-bank',
    });
    const bothOrphan = transaction({
      id: 'orphan-to-orphan',
      type: 'transaction',
      amount: 20,
      fromAccount: 'missing-a',
      toAccount: 'missing-a',
    });
    for (const record of [toTarget, bothOrphan]) {
      await db.put(STORES.TRANSACTIONS, record);
    }

    await expect(
      relinkOrphanedAccountRefs('missing-a', 'acct-bank', [
        'orphan-to-target',
        'orphan-to-orphan',
      ])
    ).rejects.toThrow('same account on both sides');

    const saved = await db.getAll(STORES.TRANSACTIONS);
    expect(saved).toHaveLength(2);
    expect(saved).toEqual(expect.arrayContaining([toTarget, bothOrphan]));
    expect(await getSyncQueueCount()).toBe(0);
  });
});
