# Available Balance / Cash Reconciliation

**Status:** ✅ Implemented

A reconciliation screen that shows expected vs. actual current balance for each account.

---

## Route

`/available-balance`

## Purpose

Provide a daily reconciliation check: "Do my actual bank/cash balances match what the ledger says I should have?" This is a **read-only** reconciliation tool — no adjusting transactions are created.

## How It Works

### Expected Balance

For each account, the expected balance is computed by `src/lib/reconciliation.ts`:

```
expected = account.startingBalance + sum(net flow of all transactions up to today)
```

Transaction flow rules:
- **Income:** `toAccount` gets `+amount`
- **Expense:** `fromAccount` gets `−amount`; if `toAccount` exists it gets `+amount`
- **Transfer:** `fromAccount` gets `−amount`, `toAccount` gets `+amount`

Every account is included (even zero-balance) so all accounts can be reconciled. Results are sorted by the account's `sortOrder` (same order as Settings).

### Current Balance

User enters the actual current balance per account manually. Stored in IndexedDB (`balanceSnapshots` store) and synced across devices via Supabase.

### Difference

```
difference = expected − current
```

Positive (green) = have more than expected (surplus). Negative (red) = have less than expected (shortfall).

### Cash Account Special Handling

The Cash account (`id = 'cash'`) has an additional **denomination grid** mode that lets users enter physical bill/coin counts (₱1000, ₱500, ₱200, ₱100, ₱50, ₱20, ₱10, ₱5, ₱1) instead of typing a total. Toggle between denomination mode and plain-number mode with "Use denominations" / "Enter total instead".

## Data Model

**Store:** `balanceSnapshots` — IndexedDB, synced via Supabase

```typescript
interface BalanceSnapshot {
  id: string;           // = accountId (one snapshot per account)
  accountId: string;
  value: number;
  updatedAt: number;
  useSubSplit?: boolean;
  subSplits?: { id: string; label: string; amount: number }[];
  userId?: string;
  createdAt: number;
}
```

## Migration History

- **v8→v9:** Added `balanceSnapshots` store + `createdAt`/`updatedAt` on Account & Category
- **v13:** Added `useSubSplit` and `subSplits` fields to `BalanceSnapshot`

## UI

### Desktop (`lg:`)

Table layout: Account | Expected | Current (input) | Difference

### Mobile (`<768px`)

Card layout — each account is a separate card with the same fields stacked vertically.

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **No adjusting entries** | Reconciliation is observation-only. User adjusts via regular transactions if needed. |
| **Per-account snapshots** | One `BalanceSnapshot` per account, keyed by `accountId`. Simpler than per-date history. |
| **localStorage migration** | Initial version stored current balances in `localStorage`. Migrated to IDB (v8→v9) for cross-device sync. Legacy migration code preserved in page component. |
| **Cash denomination grid** | Physical cash has a natural denomination breakdown. Entering counts is more accurate than typing a number. |

## Files

| File | Role |
|------|------|
| `src/app/available-balance/page.tsx` | Route page, state management, sub-split UI, cash denomination toggle |
| `src/lib/reconciliation.ts` | Pure function: `calculateExpectedBalances()` |
| `src/components/available-balance/CashDenominationInput.tsx` | Denomination grid for Cash account |
| `src/types/index.d.ts` | `BalanceSnapshot` interface |
| `src/lib/idb.ts` | `getBalanceSnapshots()`, `upsertBalanceSnapshot()` |
| `src/lib/reconciliation.test.ts` | Unit tests for expected balance computation |
