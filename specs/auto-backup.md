# Auto-Backup

**Status:** ✅ Implemented

An automatic localStorage backup triggered on app load to protect against data loss.

---

## What It Does

On every app load, `AutoBackup` component (rendered in `LayoutWithError`) calls `saveAutoBackup()` which exports all IndexedDB data (all stores) to `localStorage` as a JSON snapshot.

**Throttled to once per 24 hours** — subsequent page loads within the same day are no-ops. This prevents excessive writes and performance impact.

## Why

IndexedDB can be evicted by the browser under storage pressure, or cleared when the user clears site data. localStorage is more persistent and survives accidental cache clears in most browsers. The auto-backup provides a safety net.

## Data Flow

```
App load → AutoBackup component mounts
  → saveAutoBackup() checks if 24h have passed
  → If yes: reads all stores via getAllRecords(), serializes to JSON
  → Stores under localStorage keys: 'auto-backup-data' / 'auto-backup-time'
  → If no: no-op
```

## User Interface

Settings → Backup & Restore section shows:

- **"Last auto-backup: X ago"** — relative time since last backup
- **"Restore from auto-backup"** button — calls `importAllData()` followed by page reload

## Storage Keys

- `auto-backup-data` — JSON blob of all stores
- `auto-backup-time` — ISO timestamp of last backup

## Error Handling

All errors are caught silently. A full localStorage quota or corrupt data won't break the app — the auto-backup simply fails and retries on next load.

## Files

| File | Role |
|------|------|
| `src/components/layout/AutoBackup.tsx` | Side-effect component, triggers `saveAutoBackup()` on mount |
| `src/components/layout/LayoutWithError.tsx` | Renders `AutoBackup` once |
| `src/lib/idb.ts` | `saveAutoBackup()`, `getAutoBackup()`, `importAllData()` |
