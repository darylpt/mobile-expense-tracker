// ============================================================
// reconciliation.ts — Pure function for Available Balance screen
//
// Computes the expected balance per account as of a given date,
// based on transaction history. No side effects.
// ============================================================

import type { Transaction, Account } from '@/types';

/** One row in the Available Balance reconciliation table. */
export interface ExpectedBalanceRow {
  accountId: string;
  accountName: string;
  expected: number; // running balance as of the date
}

/**
 * Compute the expected balance for each account as of `asOfDate`.
 *
 * - Each account starts at `account.startingBalance`.
 * - All transactions with `date <= asOfDate` affect the balance:
 *   - Income:   `toAccount` gets +amount
 *   - Expense:  `fromAccount` gets −amount; if `toAccount` exists it gets +amount
 *   - Transfer: `fromAccount` gets −amount, `toAccount` gets +amount
 *
 * Every account is included (even zero-balance) so the user can reconcile.
 * Results sorted by account name.
 */
export function calculateExpectedBalances(
  allTransactions: Transaction[],
  accounts: Account[],
  asOfDate: string
): ExpectedBalanceRow[] {
  const netFlow = new Map<string, number>();

  for (const tx of allTransactions) {
    if (tx.date > asOfDate) continue;

    switch (tx.type) {
      case 'income':
        if (tx.toAccount) {
          netFlow.set(tx.toAccount, (netFlow.get(tx.toAccount) ?? 0) + tx.amount);
        }
        break;
      case 'expense':
        if (tx.fromAccount) {
          netFlow.set(tx.fromAccount, (netFlow.get(tx.fromAccount) ?? 0) - tx.amount);
        }
        if (tx.toAccount) {
          netFlow.set(tx.toAccount, (netFlow.get(tx.toAccount) ?? 0) + tx.amount);
        }
        break;
      case 'transaction':
        if (tx.fromAccount) {
          netFlow.set(tx.fromAccount, (netFlow.get(tx.fromAccount) ?? 0) - tx.amount);
        }
        if (tx.toAccount) {
          netFlow.set(tx.toAccount, (netFlow.get(tx.toAccount) ?? 0) + tx.amount);
        }
        break;
    }
  }

  const rows: ExpectedBalanceRow[] = accounts.map((acct) => ({
    accountId: acct.id,
    accountName: acct.name,
    expected: acct.startingBalance + (netFlow.get(acct.id) ?? 0),
  }));

  rows.sort((a, b) => a.accountName.localeCompare(b.accountName));
  return rows;
}
