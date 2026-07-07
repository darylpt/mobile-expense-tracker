# Spec: Local-First Sync with Supabase

**Status:** ✅ Done

---

## Objective

Replace the purely offline PWA with a **Local-First Sync** architecture where
IndexedDB remains the instant UI cache and Supabase serves as the remote cloud
broker for cross-device syncing.

---

## Constraints

- Zero server-side operations: no Next.js server components, API endpoints, or
  SSR mechanics.
- Offline-first: disconnecting the network must NOT crash the app. The ledger
  must remain fully interactive offline using the IDB fallback.
- Zero regression: all existing unit tests and pure aggregation functions must
  remain intact.
- Per-user data isolation: each user sees only their own data (via `user_id`).
  This was changed from the original shared-ledger design — see
  [`user-data-isolation.md`](./user-data-isolation.md).

---

## 1. PostgreSQL Schema

All 6 IndexedDB stores map 1:1 to Supabase tables. UUID primary keys match the
`crypto.randomUUID()` format. Timestamps are `TIMESTAMPTZ` — conversion between
`Date.now()` ms and Postgres happens in the sync layer.

### Tables

#### accounts

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | Matches front-end ID |
| `name` | `TEXT NOT NULL` | |
| `starting_balance` | `DOUBLE PRECISION NOT NULL DEFAULT 0` | |
| `sort_order` | `INTEGER` | Display order (lower = first); added in migration 003 |
| `user_id` | `UUID NOT NULL → auth.users(id) ON DELETE CASCADE` | Added in migration 002 |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `deleted_at` | `TIMESTAMPTZ DEFAULT NULL` | Soft-delete column |

#### categories

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | |
| `name` | `TEXT NOT NULL` | |
| `type` | `TEXT NOT NULL CHECK (type IN ('income','expense','transaction'))` | |
| `sort_order` | `INTEGER` | Display order; added in migration 003 |
| `user_id` | `UUID NOT NULL → auth.users(id) ON DELETE CASCADE` | Added in migration 002 |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `deleted_at` | `TIMESTAMPTZ DEFAULT NULL` | Soft-delete column |

#### transactions

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | |
| `amount` | `DOUBLE PRECISION NOT NULL` | |
| `date` | `DATE NOT NULL` | |
| `type` | `TEXT NOT NULL CHECK (type IN ('income','expense','transaction'))` | |
| `category` | `TEXT NOT NULL` | |
| `from_account` | `UUID → accounts(id) ON DELETE SET NULL` | Nullable for pure income |
| `to_account` | `UUID → accounts(id) ON DELETE SET NULL` | Nullable for pure expense |
| `description` | `TEXT` | |
| `user_id` | `UUID NOT NULL → auth.users(id) ON DELETE CASCADE` | Added in migration 002 |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `deleted_at` | `TIMESTAMPTZ DEFAULT NULL` | Soft-delete column |

Indexes: `date`, `type`, `user_id`

#### cash_denominations

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | |
| `date` | `DATE NOT NULL` | |
| `denomination` | `DOUBLE PRECISION NOT NULL` | Bill/coin value |
| `count` | `INTEGER NOT NULL` | |
| `user_id` | `UUID NOT NULL → auth.users(id) ON DELETE CASCADE` | Added in migration 002 |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `deleted_at` | `TIMESTAMPTZ DEFAULT NULL` | Soft-delete column |

#### payouts

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | |
| `date` | `DATE NOT NULL` | |
| `total_amount` | `DOUBLE PRECISION NOT NULL` | |
| `split_mode` | `TEXT NOT NULL CHECK (split_mode IN ('amount','percentage'))` | |
| `splits` | `JSONB NOT NULL DEFAULT '[]'` | Nested `PayoutSplit[]` |
| `savings_sub_split` | `JSONB` | Nullable nested object |
| `user_id` | `UUID NOT NULL → auth.users(id) ON DELETE CASCADE` | Added in migration 002 |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `deleted_at` | `TIMESTAMPTZ DEFAULT NULL` | Soft-delete column |

#### budget_targets

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | |
| `category` | `TEXT NOT NULL` | |
| `month` | `TEXT` | `"YYYY-MM"` or NULL for global default |
| `amount` | `DOUBLE PRECISION NOT NULL` | |
| `user_id` | `UUID NOT NULL → auth.users(id) ON DELETE CASCADE` | Added in migration 002 |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `deleted_at` | `TIMESTAMPTZ DEFAULT NULL` | Soft-delete column |

Indexes: `category`, `user_id`

### LWW Trigger (all tables with updated_at)

```sql
CREATE OR REPLACE FUNCTION prevent_older_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.updated_at <= OLD.updated_at THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- Applied to: accounts, categories, transactions, payouts, budget_targets
```

### RLS (per-user, from migration 002)

All 6 tables share 4 policies each:
- `SELECT USING (auth.uid() = user_id)`
- `INSERT WITH CHECK (auth.uid() = user_id)`
- `UPDATE USING (auth.uid() = user_id)`
- `DELETE USING (auth.uid() = user_id)`

---

## 2. Sync Strategy — Outbox Pattern

### Local Sync Queue (IndexedDB store)

```
syncQueue {
  key: auto-incrementing ID
  value: {
    id: string;
    storeName: string;
    recordId: string;
    operation: 'create' | 'update' | 'delete';
    payload: object | null;
    timestamp: number;       // monotonic counter (syncSeqCounter)
    retryCount: number;
  }
  indexes: { byTimestamp: number }
}
```

### Atomic Enqueue

Each `add*` / `update*` / `delete*` in `idb.ts` enqueues a sync entry **inside
the same IndexedDB transaction** as the data write — atomic by construction.

**Monotonic counter:** Instead of `Date.now()`, the timestamp uses
`++syncSeqCounter` seeded with `Date.now()` on init. This guarantees strict
FIFO ordering during bulk imports where multiple entries share the same
millisecond timestamp.

### Process Sync Queue (3-phase)

The queue is processed in three distinct phases to avoid IndexedDB
async-boundary leaks:

1. **Read** — single read-only transaction to fetch all pending entries
2. **Network** — loop over entries, calling Supabase upsert/deletes outside
   any IDB transaction
3. **Write** — fresh readwrite transaction to delete successes and update
   retry counts

```typescript
async function processSyncQueue(): Promise<void> {
  // 1. Read
  const allEntries = await db.getAllFromIndex('syncQueue', 'byTimestamp');
  // 2. Network
  for (const entry of allEntries) {
    await supabase.from(tableName).upsert(remotePayload, { onConflict: 'id' });
  }
  // 3. Write
  const tx = db.transaction('syncQueue', 'readwrite');
  for (const id of drops) await tx.store.delete(id);
}
```

### Conflict Resolution: Last-Writer-Wins

- **Push (local→remote):** Supabase upsert with `?on_conflict=id`. The LWW
  trigger silently rejects updates where incoming `updated_at` ≤ existing.
- **Pull (remote→local):** Per-record `updated_at` comparison — newer wins.

### Soft-delete strategy

- "Delete" operations set `deleted_at` + `updated_at` on Supabase (never
  hard-delete from the REST API).
- During pull, records with `deleted_at` set are purged from local IDB.

### ensureUuids()

Called at the start of `backgroundSync()`. Scans all stores for legacy slug IDs
(non-UUID strings) and replaces them with `crypto.randomUUID()`. This smooths
the migration from the old slug-based ID scheme.

### resyncAll() recovery

Clears the entire sync queue and re-enqueues all local data in dependency order:

1. Accounts
2. Categories
3. Cash denominations
4. Payouts
5. Budget targets
6. Transactions

This ensures FK dependencies are satisfied when pushing to Supabase (accounts
must exist before transactions referencing them). Button in Settings with
confirmation dialog.

### Auto-sync after CRUD

Every `enqueueSyncEntry()` call triggers `requestSync()` — a debounced function
(2 second debounce) that imports `backgroundSync()` dynamically (to avoid
circular dependency) and calls it. Sync fires automatically after every local
change without manual intervention.

---

## 3. Network Lifecycle

### Startup Flow

```
mount → AuthGuard checks session
         ↓
    [authenticated] → localStorage lastUserId check → maybe clearAllLocalData()
         ↓
    refreshTransactions() ← from local IDB (instant)
         ↓
    [if online] backgroundSync() ← fire-and-forget
         ↓
    ensureUuids() → migrate legacy slug IDs
         ↓
    processSyncQueue() → push local changes to Supabase
         ↓
    pullStore(transactions) → pull fresh data for all 6 stores
         ↓
    refreshTransactions() → re-read from IDB, UI updates
```

**Critical:** The UI never waits for the network. `refreshTransactions()` runs
immediately from IDB; sync is a background promise.

### Online/Offline Reactivity

```typescript
window.addEventListener('online', () => backgroundSync().then(refreshTransactions));
```

### Pull Strategy (per-record LWW merge)

```typescript
async function pullStore(storeName, userId):
  remoteRecords = await supabase.from(table).select('*').eq('user_id', userId)
  for each local record:
    if remote.deleted_at → purge locally
    else if remote.updated_at > local.updatedAt → take remote
    else → keep local
  for remaining remote-only records → add locally
```

---

## 4. File Plan

| File | Action |
|---|---|
| `supabase/migrations/001_schema.sql` | **NEW** — Full schema + LWW trigger + initial RLS |
| `supabase/migrations/002_user_isolation.sql` | **NEW** — TRUNCATE + user_id + per-user RLS |
| `supabase/migrations/003_add_sort_order.sql` | **NEW** — sort_order for accounts/categories |
| `src/lib/supabase.ts` | **NEW** — Supabase client wrapper (null if env missing) |
| `src/lib/sync.ts` | **NEW** — processSyncQueue, pullStore, backgroundSync, FIELD_MAP |
| `src/lib/idb.ts` | **MODIFY** — Add syncQueue store, wrap CRUD to enqueue, monotonic counter, ensureUuids, resyncAll |
| `src/lib/constants.ts` | **MODIFY** — DB_VERSION, STORES including syncQueue |
| `src/context/AuthContext.tsx` | **MODIFY** — Auth provider + guard with useEffect redirect |
| `src/context/TransactionContext.tsx` | **MODIFY** — Auth-aware cache lifecycle, call backgroundSync |
| `src/app/layout.tsx` | **MODIFY** — Wrap with AuthProvider + AuthGuard |
| `src/app/login/page.tsx` | **NEW** — Magic link form |
| `src/app/settings/page.tsx` | **MODIFY** — Sign-out button, SyncSection |
| `.env.local` | **NEW** — Supabase URL + anon key |

---

## 5. Edge Cases

| Case | Behavior |
|---|---|
| **Offline launch** | IDB loads instantly. Sync queue accumulates. No crash. |
| **Online→offline mid-sync** | Current queue entry fails (warn, retry later). No partial data. |
| **Same record edited on 2 devices offline** | LWW by `updated_at`. Second device to sync loses that edit. |
| **Sync queue overflow** | Max 5 retries per entry, then dropped with console warning. |
| **FK violation (23503)** | Dependency ordering ensures accounts → categories → … → transactions. resyncAll re-enqueues in correct order. |
| **First-time setup** | App works fully offline. Sync silently no-ops until Supabase configured. |
| **Sign-out with pending sync** | backgroundSync() runs first; if it fails and queue non-empty, user is warned before proceeding. |
| **Supabase not configured** | supabase client is null → sync no-ops, auth is disabled. App works fully offline. |
| **Overlapping sync cycles** | `syncInFlight` module-level guard prevents concurrent backgroundSync cycles. |
| **sort_order missing on remote** | Migration 003 must be run on Supabase, otherwise upsert returns 400 (unknown column). |

---

## 6. Migrations

### Migration order (run sequentially on Supabase)

1. `001_schema.sql` — tables, LWW trigger, initial auth.role() RLS
2. `002_user_isolation.sql` — TRUNCATE, user_id column, per-user RLS
3. `003_add_sort_order.sql` — sort_order on accounts + categories

After running migrations, `NOTIFY pgrst, 'reload schema'` or refresh the
Supabase API schema cache in Dashboard → API.
