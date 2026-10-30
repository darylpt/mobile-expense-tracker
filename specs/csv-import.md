# Spec: CSV Import (from Google Sheets)

**Status:** ✅ Done (committed)
**Expected output:** [`specs/data/import-output.md`](data/import-output.md)

---

## Why

The user's real transaction data lives in a Google Sheets budget tracker. The app currently has hardcoded demo seed data. CSV import replaces that — the CSV file becomes the **single source of truth** for accounts, categories, and transactions.

---

## What changes

### Remove (no longer needed with import)

| Item | Reason |
|---|---|
| `DEFAULT_ACCOUNTS` in `constants.ts` | Created from CSV rows |
| `DEFAULT_CATEGORIES` in `constants.ts` | Created from CSV rows |
| `SEED_TRANSACTIONS` in `constants.ts` | Replaced by imported data |
| `DEFAULT_BUDGET_TARGETS` in `constants.ts` | Set manually or imported later |
| `seedTransactionsIfEmpty()` in `idb.ts` | No auto-seeding — user imports instead |

### Add

| Item | File |
|---|---|
| CSV parser module | `src/lib/csv-import.ts` |
| Bulk import function | `src/lib/idb.ts` — `importFromCsv(data)` |
| Import UI section | `src/app/settings/page.tsx` |
| Import preview component | `src/components/forms/CsvImportPreview.tsx` |
| Empty-state handling | All pages show "Import your data" when no transactions exist |

---

## Input Format

CSV with the following columns (matching Google Sheets export):

```
Date,Amount,Description,Type,Category,From Account,To Account
```

| Column | Format | Example | Notes |
|---|---|---|---|
| `Date` | `M/D/YYYY` | `1/5/2026` | US date format |
| `Amount` | `₱1,234.56` | `₱1,489.00` | Philippine Peso with commas |
| `Description` | Text | `Monthly salary` | Can be empty |
| `Type` | Subtype | `Carry Over`, `Savings Transfer`, `Cash In`, `Cash Out` | Only for `transaction`-type rows |
| `Category` | Name | `Food`, `Paycheck`, `Savings Transfer` | |
| `From Account` | Name | `Seabank`, `Cash` | Empty for pure income |
| `To Account` | Name | `GoTyme`, `DragonFi` | Empty for pure expense |

---

## Mapping Logic

### Carry Over rows → account starting balances (one-time only)

In Google Sheets, carry-over rows appear every month because a spreadsheet is static. In the app, account balances **accumulate automatically** as transactions are entered. So starting balance is a **one-time setup** per account.

Rows where `Category = "Carry Over"` are **not** transactions. They set the `startingBalance` on the referenced account.

```
1/1/2026,₱34.00,Cash Carry Over,Transaction,Carry Over,Cash,
```
→ Sets `Account("Cash").startingBalance = 34.00`
→ No transaction created

**Only carry-overs from the first month that has any carry-over rows are applied.** For example, if January has the first batch of carry-overs (Cash, Landbank, etc.), only January carry-overs set starting balances. Accounts that first appear in later months' carry-overs (e.g., a new account opened mid-year) default to `startingBalance: 0` — those later carry-overs represent accumulated running balances, not opening balances.

Only the first occurrence of Carry Over per account within that first month is applied. Subsequent Carry Over rows for the same account (e.g., Feb, Mar, etc.) are silently skipped — the app's running balance replaces the need for monthly carry-overs.

**Account detection:** Carry Over row uses whichever account field is populated — `To Account` wins if both are set (seen with GoTyme/GoTyme(Sona) in the sheet), falls back to `From Account`.

### Regular rows → transactions

| Condition | App `type` |
|---|---|
| `Type` column = `Income` | `income` |
| `Type` column = `Expense` | `expense` |
| `Type` column = `Transfer` | `transaction` |
| Both `From Account` and `To Account` empty | Skip with validation error |

The per-row transaction type comes from the CSV's `Type` column directly, not from account patterns. Account patterns (`toAccount` only / `fromAccount` only / both) are only used as fallback in `inferCategoryType` when a category has mixed `Type` values (e.g., Adjustments has both Income and Expense rows).

### Amount parsing

1. Strip `₱` prefix and `,` thousands separator
2. Parse as float
3. If `NaN` or ≤ 0 → validation error on that row

### Date parsing

1. Input: `M/D/YYYY` → split on `/`, zero-pad month and day
2. Output: `YYYY-MM-DD`
3. If invalid → validation error

### Account creation

1. Collect all unique account names from `From Account` and `To Account` columns (excluding Carry Over — those only reference one account)
2. Match each name to an existing local account using the deterministic normalized-name rule: Unicode NFKC, trim, collapse internal whitespace to one space, lowercase
3. If exactly one existing account matches, the imported account **keeps that account's ID**. Duplicate normalized names are ambiguous and never match
4. Otherwise generate a new UUID for the account
5. For Carry Over accounts: set `startingBalance` from the Carry Over row amount
6. For all other accounts: set `startingBalance: 0`
7. Remap every transaction `fromAccount` / `toAccount` to the retained or new account ID
8. Write all accounts to IndexedDB

### Category creation

1. Collect all unique category names (excluding `Carry Over`)
2. For each category, determine its `type` by examining all its rows:
   - **Primary:** If all rows have the same CSV `Type` value (`Income` / `Expense` / `Transfer`), use that directly
   - **Fallback:** If rows have mixed `Type` values (e.g., Adjustments), use the account-pattern heuristic:
     - All rows have both accounts → `transaction`
     - Any row has `To Account` but no `From Account` → `income`
     - Otherwise → `expense`
3. Generate a UUID for each category
4. Write all categories to IndexedDB

Expected output for the two source CSVs is documented in [`specs/data/import-output.md`](data/import-output.md).

---

## Implementation

### Entry point: Settings → Import CSV

Add below the existing Backup/Restore section. Paste CSV or upload `.csv` file.

```
┌─────────────────────────────────┐
│  Import from Google Sheets      │
│                                 │
│  [Paste CSV data here          ]│
│                                 │
│  or [Upload CSV]               │
│                                 │
│  ─── Preview ───               │
│  438 valid rows · 2 errors     │
│  8 accounts · 21 categories    │
│  ₱87,234.50 total              │
│                                 │
│  [Cancel] [Import]             │
└─────────────────────────────────┘
```

### Files

| File | Change |
|---|---|
| `src/lib/idb.ts` | `importFromCsv(csvText, userId)` atomically replaces the six managed stores, writes the durable marker snapshot, and clears stale managed queue entries |
| `src/lib/csv-import.ts` | Parser: `parseCsv(text) → ParsedCsv` |
| `src/lib/dataset-replacement.ts` | Managed-store list, normalized account identity, marker/snapshot types, generation sequencing |
| `src/lib/sync.ts` | Replacement RPC, generation-gated push/pull, remote snapshot reconciliation, local marker adoption |
| `src/lib/orphans.ts` | Missing-account grouping, safe labels, explicit relinking |
| `src/app/settings/page.tsx` | Import status, conflict actions, Missing Account Review |
| `supabase/migrations/007_dataset_generation.sql` | Generation table, write fence, managed-write RPC, replacement RPC |

### Parser (`csv-import.ts`)

```typescript
interface ParsedCsv {
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  errors: CsvError[];
  summary: {
    totalRows: number;
    validRows: number;
    errorRows: number;
    accountCount: number;
    categoryCount: number;
    incomeCount: number;
    expenseCount: number;
    transferCount: number;
    carryOverCount: number;
    totalAmount: number;
    truncated: boolean;
  };
}

interface CsvError {
  row: number;
  message: string;
}
```

### Import flow (`idb.ts` — `importFromCsv`)

1. Parse the CSV and read existing accounts inside one `readwrite` transaction over the six managed stores, `syncQueue`, and `datasetMarkers`
2. Retain IDs for accounts with exactly one normalized-name match and remap transaction references
3. Clear the six managed stores and write the snapshot
4. Write the durable marker with a new snapshot UUID and the next generation, status `pending`
5. Delete managed queue entries in the same transaction
6. For an authenticated import, also delete the obsolete `local` marker in the same transaction
7. Commit, activate the pending generation, refresh visible context, then attempt cloud replacement

A failure at any step aborts the transaction, leaving the previous data and marker intact.

### Marker lifecycle and status

| Status | Meaning |
|---|---|
| `pending` | Local commit succeeded; cloud replacement not yet applied |
| `applied` | The RPC applied this generation |
| `failed` | The RPC failed; snapshot retained and retried |
| `conflict` | Another device advanced the generation, or pending local managed edits must be resolved |

Settings distinguishes saved-locally-pending, cloud-applied, failed, and conflicted states. A `local` marker is adopted under the authenticated user ID on first sync; the check, copy, and delete run in one `datasetMarkers` readwrite transaction. An authenticated import deletes any obsolete `local` marker in its own transaction so a stale local-only snapshot cannot be adopted by a later account.

### Missing account review

The `Deleted accounts` catch-all keeps totals correct. Missing Account Review lists each missing ID with its transactions and requires an explicit existing target account. Target existence, the reviewed transaction ID set, and self-transfer validity are checked inside the same readwrite transaction before any write. A changed set is rejected and refreshed. Transfers that would end up with the same account on both sides are rejected and must be edited individually. Only matching from/to references change, and nothing is deleted or guessed.

### Empty-state handling

When no transactions exist in IndexedDB, every page shows a card:

```
┌────────────────────────────────────┐
│  No data yet                       │
│  Import your Google Sheets data    │
│  to get started.                   │
│                                    │
│  [Go to Settings → Import]        │
└────────────────────────────────────┘
```

The app **should still render** — just show the empty state instead of tables/graphs. Do not crash.

---

## Edge Cases

| Case | Handling |
|---|---|
| Empty CSV | Show "No data found" — do not import |
| Carry Over row with amount 0 | Still sets `startingBalance: 0` (no-op, but valid) |
| Duplicate accounts from CSV | Only one account created per unique name |
| Same row has both Carry Over category AND is income | Treat as Carry Over (carry-over wins) |
| Account referenced but no Carry Over row | `startingBalance: 0` |
| All rows have errors | Show error list, don't allow import |
| File picker rejects non-.csv | Accept `.csv` MIME type and `.csv` extension |
| CSV pasted with BOM (UTF-8 BOM) | Strip BOM before parsing |
| Amount without ₱ symbol (plain number) | Parse as-is (handle both ₱-prefixed and plain) |

---

## Acceptance Criteria

1. Import commits the six managed stores, the durable marker snapshot, managed queue cleanup, and any obsolete `local` marker deletion in one IndexedDB transaction
2. A crash or write failure during import leaves the previous stores and marker intact
3. Re-importing the same CSV produces one latest local snapshot and one latest cloud snapshot after sync
4. Offline import commits locally and the marker remains actionable when online
5. Exactly one normalized-name account match retains the account ID and remaps transaction references
6. The UI refreshes transactions/accounts/categories immediately after the local commit
7. Status distinguishes local pending, cloud applied, failed, and conflicted replacement
8. Cloud replacement is idempotent for the same snapshot and reports generation conflicts
9. Accounts and `balance_snapshots` are never hard-deleted; stale writes cannot resurrect rows
10. Missing account references stay visible with exact IDs; explicit relinking changes only selected references and deletes nothing
11. No automatic orphan guessing or duplicate deletion remains
12. A failed import shows the underlying error name and message

## Key Decisions

| Decision | Rationale |
|---|---|
| Durable marker plus transactional RPC | Six REST calls can half-replace the ledger; one snapshot application is atomic and retryable |
| Per-user generation with managed-write RPC | Direct table writes cannot require a generation argument, so legacy clients could overwrite current rows. Revoking direct writes and routing managed changes through `apply_managed_write` makes the generation mandatory |
| Snapshot UUID idempotency | A retry after a lost response applies once |
| Generation conflict surfaced | Another device's replacement is a user decision |
| Account IDs retained on unambiguous normalized match | Keeps references stable; ambiguity falls back to a new UUID |
| Explicit orphan relinking only | Guessing corrupts financial data |
| `balance_snapshots` excluded | Outside the six-store scope; accounts are soft-deleted |

## Future (not building now)

- Incremental merge (appending to existing data)
- CSV template download
- Drag-and-drop file upload
