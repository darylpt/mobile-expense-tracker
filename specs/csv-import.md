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
2. Generate an `id` from the name: lowercase, replace non-alphanum with hyphens (e.g., `GoTyme(Sona)` → `gotyme-sona`)
3. For Carry Over accounts: set `startingBalance` from the Carry Over row amount
4. For all other accounts: set `startingBalance: 0`
5. Write all accounts to IndexedDB

### Category creation

1. Collect all unique category names (excluding `Carry Over`)
2. For each category, determine its `type` by examining all its rows:
   - **Primary:** If all rows have the same CSV `Type` value (`Income` / `Expense` / `Transfer`), use that directly
   - **Fallback:** If rows have mixed `Type` values (e.g., Adjustments), use the account-pattern heuristic:
     - All rows have both accounts → `transaction`
     - Any row has `To Account` but no `From Account` → `income`
     - Otherwise → `expense`
3. Generate `id` from name: lowercase, replace spaces/special chars with hyphens
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
| `src/lib/idb.ts` | Add `importFromCsv(csvText)` — orchestrates clearing all stores, parsing CSV, writing accounts/categories/transactions in one atomic transaction |
| `src/lib/csv-import.ts` | **New** — parser: `parseCsv(text) → ParsedCsv` that returns extracted accounts, categories, transactions, and errors |
| `src/lib/constants.ts` | Remove `DEFAULT_ACCOUNTS`, `DEFAULT_CATEGORIES`, `SEED_TRANSACTIONS`, `DEFAULT_BUDGET_TARGETS`. Keep `DB_NAME`, `DB_VERSION`, `STORES` only. |
| `src/app/settings/page.tsx` | Add Import CSV section |
| `src/components/forms/CsvImportPreview.tsx` | **New** — preview table: account list, category list, sample transactions, error list |
| `src/components/summary/MonthlySummaryCard.tsx` | Handle empty state — show "Import your data to get started" with link to Settings if no transactions |
| `src/app/available-balance/page.tsx` | Handle empty accounts gracefully |
| `src/app/payout/page.tsx` | Handle empty state gracefully |
| `src/app/transactions/page.tsx` | Handle empty state — show "Import your data" instead of "No transactions yet" |

### Parser (`csv-import.ts`)

```typescript
interface ParsedCsv {
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  carryOvers: Array<{ accountId: string; amount: number }>;
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
  };
}

interface CsvError {
  row: number;
  message: string;
}
```

### Import flow (`idb.ts` — `importFromCsv`)

1. Call `parseCsv(csvText)` — if errors, return them (don't proceed)
2. Open a single `readwrite` transaction across all stores
3. Clear all stores
4. Write all accounts (with correct starting balances from carry-overs)
5. Write all categories
6. Write all transactions with auto-generated `id`, `createdAt`, `updatedAt`
7. Done → user reloads the app

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

1. Paste the user's ~38-row ledger CSV → parses all rows, extracts 8 accounts with correct starting balances, 21 categories, ~30 transactions
2. Import creates everything in IndexedDB in one atomic write
3. After import + reload: Summary shows correct totals from Jan 2026
4. After import: Accounts table shows correct starting balances (Cash = 34, Landbank = 600.68, etc.)
5. Export CSV after import is approximately round-trippable
6. Fresh app (no data) shows empty-state guidance on every page
7. 0 ESLint errors, 0 TS build errors

## Future (not building now)

- Incremental merge (appending to existing data)
- CSV template download
- Drag-and-drop file upload
