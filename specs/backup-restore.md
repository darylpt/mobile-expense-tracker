# Spec: Backup / Restore

**Status:** ✅ Done

---

## Why

All data lives in IndexedDB in one browser profile. Clear site data, switch
phones, reinstall the browser, or have the PWA evicted for storage pressure
— and the ledger is gone. A Google Sheet is implicitly backed up by Google.
This feature eliminates that single-point-of-failure risk for the local
profile.

A backup is a **local IndexedDB snapshot**. It is not proof of complete cloud
state, and it does not include authentication secrets.

---

## Export — JSON (all 13 stores)

One-click export of the local database as a single portable JSON file.

### Stores included

| Store | Required in file | Contents |
|---|---|---|
| `transactions` | Yes | All Transaction records |
| `accounts` | Yes | All Account records |
| `categories` | Yes | All Category records |
| `cashDenominations` | Yes | All CashDenomination snapshots |
| `payouts` | Yes | All Payout records |
| `budgetTargets` | Yes | All BudgetTarget records |
| `balanceSnapshots` | No | Per-account balance snapshots |
| `stocks` | No | Tracked stocks and funds |
| `stockTransactions` | No | Buy/sell log |
| `dividends` | No | Cash and stock dividend records |
| `syncQueue` | No | Full outbox: pending, blocked, conflicting, and quarantined work |
| `syncMeta` | No | Per-record owner, baseline/revision, and conflict state |
| `syncDeletions` | No | Durable deletion archives (local and remote deletions) |

The six core stores are required by the TypeScript `BackupData` type. The four
later financial stores and the three local safety stores are optional so that a
legacy six-store backup still imports. The app never exports authentication
tokens or secrets.

### File format

```json
{
  "version": 1,
  "exportedAt": "2026-11-06T14:32:07.481Z",
  "data": {
    "transactions": [],
    "accounts": [],
    "categories": [],
    "cashDenominations": [],
    "payouts": [],
    "budgetTargets": [],
    "balanceSnapshots": [],
    "stocks": [],
    "stockTransactions": [],
    "dividends": [],
    "syncQueue": [],
    "syncMeta": [],
    "syncDeletions": []
  }
}
```

Each store array holds the exported record objects; the arrays are empty above
only to keep the example short and syntactically valid.

`version` remains `1` for backward compatibility; the newer fields were added
without a version bump. Older backups that omit them remain valid.

### Implementation

- **`exportAllData()`** in `src/lib/idb.ts` — one `readonly` transaction across
  all ten financial stores plus `syncQueue`, `syncMeta`, and `syncDeletions`.
- Settings UI: **Export All (JSON)** triggers a browser download
  (`<a download>` + `URL.createObjectURL`).
- Export is available only while the local cache scope is verified
  (`isScopeVerified`); the tools are disabled otherwise. In authenticated mode,
  the scope is verified only for a matching owner or a cache that is empty
  across all 13 stores; local-only mode (Supabase not configured) treats the
  local profile as the owner. A cache with no owner marker that retains any
  record — including only `syncQueue`, `syncMeta`, or `syncDeletions` — keeps
  the scope unverified, so its retained records stay hidden and cannot be
  exported while the scope is unverified. A matching-owner scope can export all
  13 stores.

---

## Sensitive data

A JSON backup contains the complete financial history, sync outbox, per-record
sync metadata, and deletion archives. Treat backup files as sensitive:

- Store exported files somewhere you control; delete extra copies.
- The app does not encrypt backup files.
- The automatic localStorage copy is readable by any script running on the
  same origin, just like the app itself.
- A backup is intended for recovery by the signed-in account (or local-only
  profile) that created it. Do not use it to move data between accounts.

**Ownership is not encoded in the backup.** The file carries no account
identity, and the app does not inspect or validate the backup's owner on import
or restore. A backup exported by one account can be imported by another; restore
does not reassign existing remote rows, move cloud ownership, or transfer
account data. Do not treat a backup file as an account-transfer mechanism.

The export gate relies on `isScopeVerified`, which proves local cache ownership
only. An unowned cache with any record in any of the 13 stores — including a
cache whose only records are `syncQueue`, `syncMeta`, or `syncDeletions`
entries — is not claimed for the newly signed-in account. Startup leaves
`isScopeVerified` false, hides the records, and keeps export, import, restore,
and AutoBackup locked while the scope is unverified. A matching-owner scope can
export the retained safety stores as part of the 13-store snapshot, and that
export includes those records; protect the file accordingly.

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

Partial or full restore from a previously exported JSON file.

### UI path and labels

Desktop: **Settings → Backup & Restore**. Mobile: **Settings → Data Tools →
Import / Export Data**.

- **Import from file…** opens a hidden `<input type="file" accept=".json">`.
- Confirmation: *"Import will replace records in the stores contained in this
  backup. Replaced records are archived locally and pending uploads are kept
  for review. Continue?"*
- Success message: *"Data imported. Reload the page to see changes."*
- **Restore from auto-backup** uses the same import function and a separate
  confirmation: *"Restore auto-backup? Current records in the backed-up stores
  are archived locally; pending uploads are kept for review."*
- Auto-backup success message: *"Auto-backup restored. Reload to see changes."*
- Import and restore are disabled unless `isScopeVerified`; a cache owned by
  another account, or an unowned cache retaining any safety-store record, stays
  locked. Startup checks all 13 stores, so a safety-only cache is not marked
  verified for a new account.

### Behavior

1. The file is parsed as JSON.
2. The UI checks only that `version` and `data` are truthy. It does not
   validate the version number, store names, required stores, or record
   shapes. This is envelope validation only.
3. `importAllData()` runs one `readwrite` transaction across all 13 stores.
4. For each of the ten **financial** stores explicitly present in the file:
   - existing records are archived in `syncDeletions` (`state: 'archived'`,
     `reason: 'backup-restore-replaced'`, owner set to the active owner when
     one is established, otherwise `null`);
   - the store is cleared;
   - the incoming records are added.
5. A financial store **omitted** from the backup is left untouched. A store
   present as an **empty array** is replaced with an empty set.
6. The existing outbox is not cleared. Pre-existing `pending` or `blocked`
   entries for record IDs in replaced stores are marked `conflict` with
   "Record was replaced by a backup restore; review before syncing".
   A success, conflict, or network error from a request started before restore
   cannot clear this conflict or write stale metadata. Supabase may already
   have committed the request before the client received the response.

7. Incoming `syncQueue`, `syncMeta`, and `syncDeletions` entries are inserted
   **only when an entry with that ID is absent**. A backup entry therefore
   cannot replace an existing local queue, metadata, or deletion record with
   the same ID. These safety stores are never cleared by import.
8. Restored records receive create work owned by the active account unless the
   backup carries a matching non-delete queue operation for the same
   store/record. Restored records with no matching incoming metadata get fresh
   sync metadata: `pending` when an owner is established, `quarantined`
   otherwise. This fresh entry replaces prior metadata for that restored
   record ID.
9. The transaction commits, then `requestSync()` is requested. That is a local
   sync request, **not** server acknowledgement; restored records may still be
   pending, blocked, conflicted, or quarantined afterward.

Import runs inside a single readwrite transaction, but the UI checks only that
the envelope has a truthy `version` and `data`; record shapes inside `data` are
not validated. A malformed payload can therefore fail after the transaction has
begun clearing or writing stores, so rejection before any write is not
guaranteed. Restore only from an app-generated backup, and keep a separate
export before restoring.

### What restore does not do

- It does not offer per-record restore, conflict-resolution, or archive-browsing
  UI.
- The import itself does not clear or rewrite the remote Supabase snapshot; it
  only requests a later sync.
- It does not guarantee that restored data reaches the cloud.
- It does not validate that incoming records reference existing accounts or
  categories.

---

## Edge cases

| Case | Behavior |
|---|---|
| Corrupt JSON file | Parsing throws → "Import failed" message, no data touched |
| Missing or falsy `version` or `data` | Rejected by the UI envelope check |
| Unknown or newer `version` value | Passes the truthy check; no version compatibility validation |
| Legacy six-store backup | Imports; stock, balance, and safety stores are left intact |
| Partial backup (some financial stores omitted) | Omitted stores are not replaced |
| Financial store present but empty | That store is replaced with an empty set |
| Import while using the app | Data replaced; page reload required |
| Existing pending/blocked work for replaced records | Marked `conflict`; the outbox is retained |
| Existing queue/meta/deletion entry with the same ID | Existing entry wins |
| Cache not verified for the current identity | Tools are locked; restore cannot run |
| Unowned cache with only safety-store records | Treated as non-empty across all 13 stores; ownership stays unverified, records stay hidden and retained, and export/import/restore/AutoBackup stay locked |
| Browser blocks download popup | Native `<a download>` + click — no popup blocker issue |
| File too large for IndexedDB | IndexedDB quotas apply; no pre-flight quota check in the JSON import path |
