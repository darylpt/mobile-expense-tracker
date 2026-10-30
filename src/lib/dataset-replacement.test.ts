import type { Account } from '@/types';
import {
  LOCAL_DATASET_OWNER,
  MANAGED_STORES,
  isManagedStore,
  nextDatasetGeneration,
  normalizeAccountName,
  retainExistingAccountIds,
  type DatasetReplacementMarker,
} from './dataset-replacement';
import type { ParsedCsv } from './csv-import';

function account(overrides: Partial<Account> & Pick<Account, 'id' | 'name'>): Account {
  return {
    startingBalance: 0,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function parsed(overrides: Partial<ParsedCsv> = {}): ParsedCsv {
  return {
    accounts: [
      {
        id: 'parsed-cash',
        name: 'Cash',
        startingBalance: 0,
        sortOrder: 0,
        createdAt: 10,
        updatedAt: 10,
      },
      {
        id: 'parsed-bank',
        name: 'Bank',
        startingBalance: 0,
        sortOrder: 1000,
        createdAt: 10,
        updatedAt: 10,
      },
    ],
    categories: [],
    transactions: [
      {
        id: 'tx-1',
        amount: 100,
        date: '2026-01-05',
        type: 'transaction',
        category: 'Transfer',
        fromAccount: 'parsed-cash',
        toAccount: 'parsed-bank',
        description: 'Move money',
        createdAt: 10,
        updatedAt: 10,
      },
    ],
    errors: [],
    summary: {
      totalRows: 1,
      validRows: 1,
      errorRows: 0,
      accountCount: 2,
      categoryCount: 0,
      incomeCount: 0,
      expenseCount: 0,
      transferCount: 1,
      carryOverCount: 0,
      totalAmount: 100,
      truncated: false,
    },
    ...overrides,
  };
}

function marker(
  overrides: Partial<DatasetReplacementMarker> = {}
): DatasetReplacementMarker {
  return {
    userId: LOCAL_DATASET_OWNER,
    generation: 1,
    snapshotId: 'snapshot-1',
    status: 'applied',
    snapshot: null,
    remoteGeneration: null,
    attempts: 0,
    lastError: null,
    updatedAt: 1,
    ...overrides,
  };
}

describe('normalizeAccountName', () => {
  it('normalizes unicode, trims, collapses whitespace, and lowercases', () => {
    expect(normalizeAccountName('  ＧｏＴｙｍｅ   Sona  ')).toBe('gotyme sona');
  });
});

describe('retainExistingAccountIds', () => {
  it('keeps the id of the single existing account with the same normalized name', () => {
    const result = retainExistingAccountIds(parsed(), [
      account({ id: 'existing-cash', name: ' cash ' }),
    ]);

    expect(result.accounts.find((a) => a.name === 'Cash')?.id).toBe('existing-cash');
    expect(result.accounts.find((a) => a.name === 'Cash')?.createdAt).toBe(1);
  });

  it('remaps transaction references to retained account ids', () => {
    const result = retainExistingAccountIds(parsed(), [
      account({ id: 'existing-cash', name: 'Cash' }),
    ]);

    expect(result.transactions[0].fromAccount).toBe('existing-cash');
    expect(result.transactions[0].toAccount).toBe('parsed-bank');
  });

  it('does not match when two existing accounts share a normalized name', () => {
    const result = retainExistingAccountIds(parsed(), [
      account({ id: 'cash-a', name: 'Cash' }),
      account({ id: 'cash-b', name: 'cash ' }),
    ]);

    expect(result.accounts.find((a) => a.name === 'Cash')?.id).toBe('parsed-cash');
    expect(result.transactions[0].fromAccount).toBe('parsed-cash');
  });

  it('leaves unmatched accounts with their parser-generated ids', () => {
    const result = retainExistingAccountIds(parsed(), []);
    expect(result.accounts.map((a) => a.id)).toEqual(['parsed-cash', 'parsed-bank']);
  });
});

describe('nextDatasetGeneration', () => {
  it('starts at 1 with no prior marker', () => {
    expect(nextDatasetGeneration(null)).toBe(1);
  });

  it('increments the prior local generation', () => {
    expect(nextDatasetGeneration(marker({ generation: 4 }))).toBe(5);
  });

  it('supersedes the remote generation after a conflict', () => {
    expect(
      nextDatasetGeneration(
        marker({ status: 'conflict', generation: 3, remoteGeneration: 9 })
      )
    ).toBe(10);
  });
});

describe('managed stores', () => {
  it('names the six replaced stores and no others', () => {
    expect([...MANAGED_STORES]).toEqual([
      'accounts',
      'categories',
      'transactions',
      'cashDenominations',
      'payouts',
      'budgetTargets',
    ]);
    expect(isManagedStore('accounts')).toBe(true);
    expect(isManagedStore('balanceSnapshots')).toBe(false);
    expect(isManagedStore('stocks')).toBe(false);
  });
});
