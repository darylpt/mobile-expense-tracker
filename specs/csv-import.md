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
3. Retain an existing ID only for an unambiguous match on both sides: exactly one imported account and exactly one existing account share the normalized name. Duplicate normalized names on either side are ambiguous and never match — including two imported names like `Cash` and `CASH`, which keep their distinct parser-generated IDs so transaction references stay distinct
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

1. Parse the CSV, then read existing accounts inside one `readwrite` transaction over the six managed stores, `syncQueue`, and `datasetMarkers`
2. Retain IDs only for accounts whose normalized name is unambiguous on both sides, then remap transaction references
3. Clear the six managed stores and write the snapshot
4. Write the durable marker with a new snapshot UUID and the next generation, status `pending`
5. Delete managed queue entries in the same transaction
6. For an authenticated import, also delete the obsolete `local` marker in the same transaction
7. Commit, activate the pending generation, refresh visible context, then attempt cloud replacement

A failure at any step aborts the transaction, leaving the previous data and marker intact.

### First-open generation hydration

`getDB()` keeps one initialization promise per module instance and resolves it only after `datasetMarkers` hydrates the active generation. Every concurrent caller awaits that same promise, so a write enqueued during the first open is stamped with the persisted generation instead of `0`. A failed open or hydration closes the connection and clears the promise, so a later call retries with no partially initialized singleton left behind. The sync queue enqueue paths read the active generation only after `getDB()` resolves, so no entry is written while hydration is pending.

### UUID identity migration

`ensureUuids()` runs at the start of `backgroundSync()`. It collects every account and category whose primary key is not a UUID, generates replacements with `crypto.randomUUID()`, and applies the remap in one `readwrite` transaction over `accounts`, `categories`, `transactions`, `balanceSnapshots`, `syncQueue`, and `datasetMarkers`. Each old record is deleted before the new key is written, so the unique `accounts.name` index never holds the old and new rows at once. The same transaction rewrites transaction `fromAccount`/`toAccount`, a balance snapshot's `id`/`accountId`, queue `recordId` and payload identity fields, and every persisted replacement-marker snapshot (account IDs, category IDs, and transaction account references). Snapshot fields outside those identities keep their committed values. The completion flag is versioned. `uuid_migration_v2_done` is set only after the transaction commits, and an abort rolls back every store, so the next sync retries from a clean state. The earlier `uuid_migration_done` key is ignored, so an installation that completed the first migration still runs this corrected one on its next sync, then skips the scan once the versioned flag is written.

`src/lib/idb-import-uuid-snapshot.test.ts` covers the path: an import that retains a legacy account ID migrates without leaving a duplicate account, the local transaction and balance snapshot point at the migrated ID, and the persisted marker snapshot agrees with local state. A second case migrates a legacy category ID and remaps markers for both the local owner and an authenticated user. A third case sets only the legacy `uuid_migration_done` key and asserts the corrected migration still runs and writes `uuid_migration_v2_done`. A fourth case forces UUID generation to fail and asserts the versioned flag is absent afterwards.

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

Settings exposes the review at `/settings#orphan-review`. The first client render uses the same `accounts`/hub state as the server, then an effect applies the fragment after mount, so hydration never sees two different trees. Once the store loading placeholders clear and the `#orphan-review` section exists, a second effect scrolls it into view with `scroll-mt-24` keeping the heading clear of the sticky header. `e2e/settings-orphan-review-deeplink.spec.ts` covers the direct navigation: the section is visible and in the viewport, the page scrolled, and no hydration error reached the console.

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
5. A normalized name shared by exactly one imported account and exactly one existing account retains the existing account ID and remaps transaction references; duplicate normalized names in the import keep their distinct parser-generated IDs with transaction references unchanged
6. The UI refreshes transactions/accounts/categories immediately after the local commit
7. Status distinguishes local pending, cloud applied, failed, and conflicted replacement
8. Cloud replacement is idempotent for the same snapshot and reports generation conflicts
9. Accounts and `balance_snapshots` are never hard-deleted; stale writes cannot resurrect rows
10. Missing account references stay visible with exact IDs; explicit relinking changes only selected references and deletes nothing
11. No automatic orphan guessing or duplicate deletion remains
12. A failed import shows the underlying error name and message
13. On the first open, every concurrent caller awaits one shared initialization that hydrates the persisted generation before any sync entry is stamped; a failed open or hydration leaves no usable singleton and a later call retries
14. The UUID migration replaces account and category primary keys without leaving duplicate rows, and every persisted replacement-marker snapshot, transaction reference, balance snapshot, and queue entry follows the new IDs in the same transaction; the versioned completion flag `uuid_migration_v2_done` is written only after it commits, and a leftover `uuid_migration_done` key never suppresses this migration

## Key Decisions

| Decision | Rationale |
|---|---|
| Durable marker plus transactional RPC | Six REST calls can half-replace the ledger; one snapshot application is atomic and retryable |
| Per-user generation with managed-write RPC | Direct table writes cannot require a generation argument, so legacy clients could overwrite current rows. Revoking direct writes and routing managed changes through `apply_managed_write` makes the generation mandatory |
| Snapshot UUID idempotency | A retry after a lost response applies once |
| Generation conflict surfaced | Another device's replacement is a user decision |
| Account IDs retained on an unambiguous normalized match on both sides | Keeps references stable; ambiguity on either side falls back to the parser-generated ID |
| Explicit orphan relinking only | Guessing corrupts financial data |
| `balance_snapshots` excluded from import replacement | Outside the six-store scope; accounts are soft-deleted. The UUID identity migration still remaps a snapshot's `id`/`accountId` when its account key changes |

## Future (not building now)

- Incremental merge (appending to existing data)
- CSV template download
- Drag-and-drop file upload

### Import sync correction (0.18.3)

Sync fencing, queued-edit replay, and acknowledgement are owned by the [sync spec](local-first-sync-supabase.md#import-sync-correction-0183). Missing Account Review reloads on account/transaction changes and sync completion in both Settings layouts.

The shared Settings import panel refreshes its persisted replacement marker and status text on `sync-complete` in both desktop and mobile layouts. Background conflicts and failed replacements expose resolution or retry controls without remounting the page; applied or cleared markers remove stale controls.

Settings conflict status and recovery text share the same explanation: a higher remote generation identifies a replaced cloud dataset; otherwise the panel describes conflicting cloud records and local edits. Both display the persisted error detail and explain that explicit resolution replaces the entire cloud dataset with the local snapshot. No import is presumed.
