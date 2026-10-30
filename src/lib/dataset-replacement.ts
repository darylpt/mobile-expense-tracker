import type { Account, BudgetTarget, CashDenomination, Category, Payout, Transaction } from '@/types';
import type { ParsedCsv } from './csv-import';

/** The six stores a CSV import replaces. */
export const MANAGED_STORES = [
  'accounts',
  'categories',
  'transactions',
  'cashDenominations',
  'payouts',
  'budgetTargets',
] as const;

export type ManagedStore = (typeof MANAGED_STORES)[number];

/** Marker key used when Supabase auth is disabled and the app is local-only. */
export const LOCAL_DATASET_OWNER = 'local';

export type DatasetReplacementStatus = 'pending' | 'applied' | 'failed' | 'conflict';

export interface DatasetSnapshot {
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  cashDenominations: CashDenomination[];
  payouts: Payout[];
  budgetTargets: BudgetTarget[];
}

export interface DatasetReplacementMarker {
  userId: string;
  generation: number;
  snapshotId: string;
  status: DatasetReplacementStatus;
  snapshot: DatasetSnapshot | null;
  remoteGeneration: number | null;
  attempts: number;
  lastError: string | null;
  updatedAt: number;
}

export function isManagedStore(storeName: string): storeName is ManagedStore {
  return (MANAGED_STORES as readonly string[]).includes(storeName);
}

/**
 * Deterministic account-name identity rule: Unicode NFKC, trim, collapse
 * internal whitespace to one space, lowercase.
 *
 * Matching only happens when exactly one imported account and exactly one
 * existing account share the normalized name. Duplicate normalized names on
 * either side are ambiguous and never matched.
 */
export function normalizeAccountName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Reuse existing local account IDs for imported accounts whose normalized
 * names are unambiguous on both sides, then remap transaction account
 * references to those retained IDs. Unmatched accounts keep the
 * parser-generated ID.
 */
export function retainExistingAccountIds(parsed: ParsedCsv, existingAccounts: Account[]): ParsedCsv {
  const accountsByNormalized = new Map<string, Account[]>();
  for (const account of existingAccounts) {
    const key = normalizeAccountName(account.name);
    const matches = accountsByNormalized.get(key) ?? [];
    matches.push(account);
    accountsByNormalized.set(key, matches);
  }

  const parsedKeyCounts = new Map<string, number>();
  for (const account of parsed.accounts) {
    const key = normalizeAccountName(account.name);
    parsedKeyCounts.set(key, (parsedKeyCounts.get(key) ?? 0) + 1);
  }

  const oldToNewId = new Map<string, string>();
  const accounts = parsed.accounts.map((account) => {
    const key = normalizeAccountName(account.name);
    const matches = accountsByNormalized.get(key) ?? [];
    const retained = parsedKeyCounts.get(key) === 1 && matches.length === 1 ? matches[0] : null;
    const id = retained?.id ?? account.id;
    oldToNewId.set(account.id, id);
    return retained ? { ...account, id, createdAt: retained.createdAt } : account;
  });

  const remap = (id: string | null): string | null => {
    if (!id) return null;
    return oldToNewId.get(id) ?? id;
  };

  const transactions = parsed.transactions.map((tx) => ({
    ...tx,
    fromAccount: remap(tx.fromAccount),
    toAccount: remap(tx.toAccount),
  }));

  return { ...parsed, accounts, transactions };
}

/**
 * Next local generation for an import. A conflicted marker adopts the remote
 * generation plus one, so the user's explicit retry supersedes the other device.
 */
export function nextDatasetGeneration(previous: DatasetReplacementMarker | null): number {
  if (!previous) return 1;
  if (previous.status === 'conflict' && previous.remoteGeneration !== null) {
    return Math.max(previous.generation, previous.remoteGeneration) + 1;
  }
  return previous.generation + 1;
}
