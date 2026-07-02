# Spec: Backup / Restore

**Status:** ✅ Done

---

## Why

All data lives in IndexedDB in one browser profile. Clear site data, switch
phones, reinstall the browser, or have the PWA evicted for storage pressure
— and the ledger is gone. A Google Sheet is implicitly backed up by Google.
This feature eliminates that single-point-of-failure risk.

---

## Export — JSON (all stores)

One-click export of every store as a single portable JSON file.

### Stores included

| Store | Records |
|---|---|
| `transactions` | All Transaction records |
| `accounts` | All Account records |
| `categories` | All Category records |
| `cashDenominations` | All CashDenomination snapshots |
| `payouts` | All Payout records |
| `budgetTargets` | All BudgetTarget records |

### File format

```json
{
  "version": 1,
  "exportedAt": "2026-07-02T...",
  "data": {
    "transactions": [ ... ],
    "accounts": [ ... ],
    "categories": [ ... ],
    "cashDenominations": [ ... ],
    "payouts": [ ... ],
    "budgetTargets": [ ... ]
  }
}
```

### Implementation

- **`exportAllData()`** in `src/lib/idb.ts` — single `readonly` transaction
  across all 6 stores, returns a `BackupData` object.
- Settings UI: **Export All (JSON)** button triggers a browser download
  (`<a download>` + `URL.createObjectURL`).

---

## Export — CSV (transactions only)

Separate CSV export for spreadsheet analysis.

### Columns

`id, date, type, category, fromAccount, toAccount, amount, description, createdAt, updatedAt`

### Implementation

- **`transactionsToCsv()`** in `src/lib/idb.ts` — pure function, no side
  effects. RFC 4180-ish quoting (commas, quotes, newlines in values are
  escaped).
- Settings UI: **Export Transactions (CSV)** button.

---

## Import — JSON

Full restore from a previously exported JSON file.

### Behavior

1. User picks a `.json` file via native file picker.
2. Confirmation dialog: *"Import will REPLACE all current data. Are you sure?"*
3. On confirm: single `readwrite` transaction clears every store, then bulk-adds
   the records from the backup file.
4. User is prompted to reload the page for changes to take effect.

### Implementation

- **`importAllData(backup)`** in `src/lib/idb.ts` — atomic clear-and-replace.
- Settings UI: **Import from file…** button triggers a hidden `<input type="file" accept=".json">`.

---

## Edge cases

| Case | Behavior |
|---|---|
| Corrupt JSON file | Parsing throws → error message shown, no data touched |
| Missing `version` or `data` fields | Explicit check rejects the file |
| Partial backup (some stores empty) | Acceptable — empty arrays are valid |
| Import while using the app | Data replaced; page reload required |
| Browser blocks download popup | Native `<a download>` + click — no popup blocker issue |
| File too large for IndexedDB | IndexedDB quotas apply (typically 50MB+ per origin) |
