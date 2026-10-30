import type { Account, Transaction } from '@/types';

export const DELETED_ACCOUNT_LABEL = 'Deleted account';
export const DELETED_ACCOUNTS_LABEL = 'Deleted accounts';

/**
 * Resolve an account reference to its display name. A missing reference is
 * blank, and an unknown ID becomes the deleted-account label so a raw ID never
 * reaches the UI.
 */
export function accountLabel(accountId: string | null, accounts: Account[]): string {
  if (!accountId) return '';
  return accounts.find((account) => account.id === accountId)?.name ?? DELETED_ACCOUNT_LABEL;
}

export interface MissingAccountGroup {
  accountId: string;
  transactions: Transaction[];
  inflow: number;
  outflow: number;
}

export interface RelinkResult {
  updated: Transaction[];
  count: number;
}

/**
 * Group every transaction that references an unknown account ID, keyed by the
 * exact missing ID. A transaction that references two missing IDs appears in
 * both groups.
 */
export function groupTransactionsByMissingAccount(
  transactions: Transaction[],
  accounts: Account[]
): MissingAccountGroup[] {
  const knownIds = new Set(accounts.map((account) => account.id));
  const groups = new Map<
    string,
    { transactions: Map<string, Transaction>; inflow: number; outflow: number }
  >();

  const addReference = (id: string | null, tx: Transaction, direction: 'in' | 'out') => {
    if (!id || knownIds.has(id)) return;
    const group = groups.get(id) ?? { transactions: new Map(), inflow: 0, outflow: 0 };
    group.transactions.set(tx.id, tx);
    if (direction === 'in') group.inflow += tx.amount;
    else group.outflow += tx.amount;
    groups.set(id, group);
  };

  for (const tx of transactions) {
    addReference(tx.fromAccount, tx, 'out');
    addReference(tx.toAccount, tx, 'in');
  }

  return [...groups.entries()]
    .map(([accountId, group]) => ({
      accountId,
      transactions: [...group.transactions.values()],
      inflow: group.inflow,
      outflow: group.outflow,
    }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId));
}

/**
 * Return the transaction IDs that currently reference `sourceAccountId`.
 */
export function affectedTransactionIds(
  transactions: Transaction[],
  sourceAccountId: string
): string[] {
  return transactions
    .filter((tx) => tx.fromAccount === sourceAccountId || tx.toAccount === sourceAccountId)
    .map((tx) => tx.id);
}

/**
 * Return transfer IDs that would have equal from/to accounts after relinking.
 */
export function findSelfTransferConflicts(
  transactions: Transaction[],
  sourceAccountId: string,
  targetAccountId: string
): string[] {
  return transactions
    .filter(
      (tx) =>
        tx.type === 'transaction' &&
        (tx.fromAccount === sourceAccountId || tx.toAccount === sourceAccountId)
    )
    .filter((tx) => {
      const fromAccount =
        tx.fromAccount === sourceAccountId ? targetAccountId : tx.fromAccount;
      const toAccount = tx.toAccount === sourceAccountId ? targetAccountId : tx.toAccount;
      return fromAccount !== null && fromAccount === toAccount;
    })
    .map((tx) => tx.id);
}

/**
 * Return only the transactions that reference `sourceAccountId`, with those
 * references replaced by `targetAccountId`. Every other field is preserved.
 */
export function relinkTransactionReferences(
  transactions: Transaction[],
  sourceAccountId: string,
  targetAccountId: string,
  updatedAt: number
): RelinkResult {
  if (sourceAccountId === targetAccountId) return { updated: [], count: 0 };

  const updated: Transaction[] = [];
  for (const tx of transactions) {
    const fromMatches = tx.fromAccount === sourceAccountId;
    const toMatches = tx.toAccount === sourceAccountId;
    if (!fromMatches && !toMatches) continue;
    updated.push({
      ...tx,
      fromAccount: fromMatches ? targetAccountId : tx.fromAccount,
      toAccount: toMatches ? targetAccountId : tx.toAccount,
      updatedAt,
    });
  }

  return { updated, count: updated.length };
}
