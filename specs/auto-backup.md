# Auto-Backup

**Status:** ✅ Implemented (same-device convenience snapshot)

An automatic localStorage snapshot triggered on app load. It reuses the full
13-store export and the normal import/restore semantics.

---

## What It Does

After the local data scope is verified, the `AutoBackup` component calls
`saveAutoBackup()`, which runs `exportAllData()` and stores the resulting
`version: 1` snapshot in localStorage. `src/app/layout.tsx` renders
`<AutoBackup />` as a sibling immediately after the `LayoutWithError` wrapper;
`LayoutWithError` itself only adds the global error banner above its children.

- **Scope-verified trigger:** `AutoBackup` calls `saveAutoBackup()` only when
  `isScopeVerified` is true. Fail-closed states (unauthenticated, different
  account, or legacy cache without verified ownership) do not back up. With
  Supabase disabled, local-only usage is treated as the owner.
- **Same 13-store scope as JSON export:** the six core stores, the four later
  financial stores (`balanceSnapshots`, `stocks`, `stockTransactions`,
  `dividends`), and the three local safety stores (`syncQueue`, `syncMeta`,
  `syncDeletions`).
- **Throttled to once per 24 hours:** if the last successful snapshot has a
  timestamp less than 24 hours old, the call is a no-op.

## Why

IndexedDB can be evicted under storage pressure, or cleared when the user
clears site data. A local snapshot gives a recent copy for recovery from some
local failures without downloading a file.

The snapshot contains the same sensitive ledger, outbox, metadata, and archive
data as a JSON export. It is not encrypted.

**localStorage is not an independent backup.** It lives in the same browser
profile and origin as the database. Clearing site data, browser eviction, or
storage-pressure cleanup can remove the database and the auto-backup together.
It does not survive a device change and provides no off-device copy.

## Data Flow

```
App load → AutoBackup component mounts
  → isScopeVerified?
      no  → no-op
      yes → saveAutoBackup() checks the 24h throttle
              → if due: exportAllData() reads all 13 stores
              → serialize to JSON
              → write 'auto-backup-data', then 'auto-backup-time' (two calls)
              → if not due: no-op
```

## User Interface

Settings → Backup & Restore (mobile: Settings → Data Tools → Import / Export
Data) shows:

- **"Auto-backup: saved X ago"** — relative time of the last saved snapshot;
  "none yet (saves daily)" when absent
- **"Restore from auto-backup"** — shown only when a snapshot exists. Calls
  `importAllData()` and instructs the user to reload.

The restore confirmation is: *"Restore auto-backup? Current records in the
backed-up stores are archived locally; pending uploads are kept for review."*

## Storage Keys

- `auto-backup-data` — JSON snapshot of all 13 stores
- `auto-backup-time` — ISO timestamp of the last successful snapshot

## Restore Semantics

Auto-backup restore calls the same `importAllData()` used by **Import from
file…**, so the [backup/restore contract](./backup-restore.md) applies:

- Only financial stores present in the snapshot are replaced; an empty array
  clears that financial store.
- Existing records in replaced stores are archived in `syncDeletions`.
- The existing outbox is retained; pre-existing pending/blocked work for
  replaced records becomes `conflict`.
- Incoming queue/meta/deletion entries are merged by ID; an existing entry is
  not replaced by the backup's copy. Restored records that lack incoming
  metadata still receive fresh `pending`/`quarantined` metadata.
- Restored records are queued for sync; that is not server acknowledgement.

## Error Handling

Errors are caught silently and `saveAutoBackup()` returns `false`. A full
localStorage quota, a serialization failure, or an IndexedDB error does not
break the app, and there is no UI error for a failed auto-backup.

A `false` result does **not** mean nothing was written. The payload and its
timestamp are two independent writes: `auto-backup-data` is set first, then
`auto-backup-time`. A failure between them — quota exhaustion on the second
write, for example — can leave a newly written payload paired with the previous
snapshot's timestamp, or with no timestamp at all:

- with a previous timestamp still in place, the stored data is newer than the
  reported save time;
- with no timestamp, `getAutoBackup()` returns `null` because it requires both
  keys, so the UI reports no saved snapshot even though payload bytes exist.

Because a snapshot attempt only starts when the time key is absent or at least
24 hours old, such a partial failure leaves the throttle still expired, and the
next app load retries the snapshot.

`getAutoBackup()` returns `null` when either key is missing, JSON parsing
fails, or the snapshot lacks a truthy `version` and `data`. It performs no
deeper schema validation.

## Files

| File | Role |
|------|------|
| `src/components/layout/AutoBackup.tsx` | Side-effect component rendered by `src/app/layout.tsx`; calls `saveAutoBackup()` once scope is verified |
| `src/components/layout/LayoutWithError.tsx` | Error-banner wrapper only; renders `GlobalErrorBanner` plus its children, never `AutoBackup` |
| `src/lib/idb.ts` | `saveAutoBackup()`, `getAutoBackup()`, `exportAllData()`, `importAllData()` |
