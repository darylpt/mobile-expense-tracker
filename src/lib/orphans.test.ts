import type { Account, Transaction } from '@/types';
import {
  DELETED_ACCOUNT_LABEL,
  accountLabel,
  affectedTransactionIds,
  findSelfTransferConflicts,
  groupTransactionsByMissingAccount,
  relinkTransactionReferences,
} from './orphans';
import { tx } from './test-utils';

const ACCOUNTS: Account[] = [
  { id: 'acct-cash', name: 'Cash', startingBalance: 0, createdAt: 0, updatedAt: 0 },
  { id: 'acct-bank', name: 'Bank', startingBalance: 0, createdAt: 0, updatedAt: 0 },
];

describe('accountLabel', () => {
  it('falls back to a safe label instead of leaking the id', () => {
    expect(accountLabel('missing-uuid-123', ACCOUNTS)).toBe(DELETED_ACCOUNT_LABEL);
    expect(accountLabel(null, ACCOUNTS)).toBe('');
    expect(accountLabel('acct-cash', ACCOUNTS)).toBe('Cash');
  });
});

describe('groupTransactionsByMissingAccount', () => {
  it('groups by the exact missing account id and keeps transaction details', () => {
    const orphanId = 'missing-account-uuid';
    const income = tx({
      id: 'income-1',
      date: '2026-06-15',
      type: 'income',
      amount: 1000,
      category: 'Salary',
      toAccount: orphanId,
      description: 'June salary',
    });
    const expense = tx({
      id: 'expense-1',
      date: '2026-06-20',
      type: 'expense',
      amount: 300,
      category: 'Food',
      fromAccount: orphanId,
      description: 'Groceries',
    });

    const groups = groupTransactionsByMissingAccount([income, expense], ACCOUNTS);

    expect(groups).toHaveLength(1);
    expect(groups[0].accountId).toBe(orphanId);
    expect(groups[0].inflow).toBe(1000);
    expect(groups[0].outflow).toBe(300);
    expect(groups[0].transactions).toEqual([income, expense]);
  });

  it('lists a transaction in every missing account group it references', () => {
    const transfer = tx({
      id: 'transfer-1',
      date: '2026-06-21',
      type: 'transaction',
      amount: 500,
      fromAccount: 'missing-from',
      toAccount: 'missing-to',
    });

    const groups = groupTransactionsByMissingAccount([transfer], ACCOUNTS);

    expect(groups.map((group) => group.accountId)).toEqual(['missing-from', 'missing-to']);
    expect(groups[0].transactions).toEqual([transfer]);
    expect(groups[1].transactions).toEqual([transfer]);
  });

  it('ignores known accounts and returns groups sorted by id', () => {
    const groups = groupTransactionsByMissingAccount(
      [
        tx({ date: '2026-06-10', type: 'expense', amount: 10, fromAccount: 'missing-b' }),
        tx({ date: '2026-06-11', type: 'expense', amount: 10, fromAccount: 'acct-cash' }),
        tx({ date: '2026-06-12', type: 'expense', amount: 10, fromAccount: 'missing-a' }),
      ],
      ACCOUNTS
    );

    expect(groups.map((group) => group.accountId)).toEqual(['missing-a', 'missing-b']);
  });
});

describe('affectedTransactionIds', () => {
  it('returns only ids that reference the missing account', () => {
    const affected = tx({
      id: 'affected',
      date: '2026-06-13',
      type: 'expense',
      amount: 1,
      fromAccount: 'missing-a',
    });
    const other = tx({
      id: 'other',
      date: '2026-06-14',
      type: 'expense',
      amount: 1,
      fromAccount: 'acct-cash',
    });
    expect(affectedTransactionIds([affected, other], 'missing-a')).toEqual(['affected']);
  });
});

describe('findSelfTransferConflicts', () => {
  it('flags transfers that would land on the same account', () => {
    const toTarget = tx({
      id: 'to-target',
      date: '2026-06-22',
      type: 'transaction',
      amount: 10,
      fromAccount: 'missing-a',
      toAccount: 'acct-bank',
    });
    const bothOrphan = tx({
      id: 'both-orphan',
      date: '2026-06-23',
      type: 'transaction',
      amount: 20,
      fromAccount: 'missing-a',
      toAccount: 'missing-a',
    });
    const safe = tx({
      id: 'safe',
      date: '2026-06-24',
      type: 'transaction',
      amount: 30,
      fromAccount: 'missing-a',
      toAccount: 'acct-cash',
    });
    expect(
      findSelfTransferConflicts([toTarget, bothOrphan, safe], 'missing-a', 'acct-bank')
    ).toEqual(['to-target', 'both-orphan']);
  });
});

describe('relinkTransactionReferences', () => {
  const updatedAt = 123456;
  const sourceId = 'missing-account';

  it('changes only references to the selected source account', () => {
    const fromOrphan = tx({
      id: 'from-orphan',
      date: '2026-06-01',
      type: 'expense',
      amount: 42.5,
      category: 'Food',
      fromAccount: sourceId,
      toAccount: null,
      description: 'Lunch',
    });
    const toOrphan = tx({
      id: 'to-orphan',
      date: '2026-06-02',
      type: 'income',
      amount: 900,
      category: 'Salary',
      fromAccount: null,
      toAccount: sourceId,
      description: 'Pay',
    });
    const untouched = tx({
      id: 'untouched',
      date: '2026-06-03',
      type: 'expense',
      amount: 5,
      fromAccount: 'acct-cash',
    });

    const result = relinkTransactionReferences(
      [fromOrphan, toOrphan, untouched],
      sourceId,
      'acct-bank',
      updatedAt
    );

    expect(result.count).toBe(2);
    expect(result.updated.map((item) => item.id).sort()).toEqual(['from-orphan', 'to-orphan']);
    expect(result.updated[0]).toEqual({
      ...fromOrphan,
      fromAccount: 'acct-bank',
      updatedAt,
    });
    expect(result.updated[1]).toEqual({
      ...toOrphan,
      toAccount: 'acct-bank',
      updatedAt,
    });
    expect(result.updated[0].amount).toBe(42.5);
    expect(result.updated[0].category).toBe('Food');
    expect(result.updated[0].date).toBe('2026-06-01');
    expect(result.updated[0].description).toBe('Lunch');
    expect(result.updated[0].id).toBe('from-orphan');
  });

  it('is a no-op when source and target are the same account', () => {
    const result = relinkTransactionReferences(
      [tx({ date: '2026-06-25', type: 'expense', amount: 1, fromAccount: sourceId })],
      sourceId,
      sourceId,
      updatedAt
    );

    expect(result).toEqual({ updated: [], count: 0 });
  });

  it('never returns an update for transactions without the source reference', () => {
    const transactions: Transaction[] = [
      tx({ date: '2026-06-26', type: 'expense', amount: 1, fromAccount: 'acct-cash' }),
      tx({ date: '2026-06-27', type: 'income', amount: 2, toAccount: 'acct-bank' }),
    ];

    expect(relinkTransactionReferences(transactions, sourceId, 'acct-bank', updatedAt)).toEqual({
      updated: [],
      count: 0,
    });
  });
});
