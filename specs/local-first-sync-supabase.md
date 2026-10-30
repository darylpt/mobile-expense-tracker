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

The six CSV-managed stores below map to Supabase tables. The full store inventory is in [the project data model](project-spec.md#3-data-model). UUID primary keys match the
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

### RLS (per-user, after migration 007)

Every table is gated on `auth.uid() = user_id`, but migration 007 splits the
policy set:

- **Six managed tables** (`accounts`, `categories`, `transactions`,
  `cash_denominations`, `payouts`, `budget_targets`): `SELECT USING
  (auth.uid() = user_id)` only. `INSERT`/`UPDATE`/`DELETE` policies are
  dropped; writes must go through `apply_managed_write` or
  `replace_user_dataset`, which run as `SECURITY DEFINER` and enforce the
  dataset generation.
- **Remaining synced tables** (`stocks`, `stock_transactions`, `dividends`,
  `balance_snapshots`): SELECT/INSERT/UPDATE/DELETE, all gated on
  `auth.uid() = user_id`.
- **`dataset_generations`**: `SELECT USING (auth.uid() = user_id)` only; the
  RPCs own inserts and updates.

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
    datasetGeneration?: number; // managed writes carry the hydrated generation
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

### Dataset replacement gate

CSV import writes a durable `datasetMarkers` snapshot and clears managed queue entries in one transaction. `backgroundSync` reads `dataset_generations.generation`; a non-applied marker is applied through `replace_user_dataset` before any managed push or pull. The RPC records the snapshot UUID for idempotent retry and returns `conflict` when another device advanced the generation.

Managed single-record writes use `apply_managed_write(p_generation, p_store, p_operation, p_record_id, p_record)`. Direct INSERT/UPDATE/DELETE policies on the six managed tables are removed, so a legacy client that omits the generation cannot write at all. The trigger also requires `NEW.dataset_generation` to equal the current generation. `dataset_generations` is read-only to clients. Creates and updates carry the record's `updated_at`; the RPC writes that incoming timestamp (server time only when it is absent), so the LWW trigger still skips a queued change older than the stored row instead of overwriting newer data.

When the remote generation advances, a client with no queued managed writes reconciles the authoritative remote snapshot with paginated reads and replaces the six local stores in one transaction that also rechecks the applied marker identity (user ID, generation, snapshot ID) and `syncQueue`. A client with no local marker starts at generation 0, so any remote generation above 0 triggers that reconcile instead of preserving stale local-only rows. If a concurrent import or replacement changed the marker while the remote pages were fetched, the stores, queue, and marker are left untouched and the current marker is returned so the next step handles its pending or conflict state. A client with queued managed edits receives a `conflict` marker containing a local snapshot; its queue and local rows are preserved until the user resolves it. Adoption of a pending `local` marker under the authenticated user ID checks, copies, and deletes the marker in one `datasetMarkers` readwrite transaction, so a concurrent import cannot overwrite the user marker or delete a newer local marker.

When `apply_managed_write` returns `conflict` during a push, `processSyncQueue` stops immediately without incrementing the retry count or dropping the entry, then reports the conflict to `backgroundSync`. `backgroundSync` rechecks the marker inside the snapshot transaction and records a conflict marker with the current local rows; the rest of the queue is left untouched, and no pull runs against the superseding remote snapshot.

Conflict resolution rebuilds the snapshot from the current local six stores, clears only the managed queue entries represented by that snapshot, writes the pending marker, and activates the next generation before calling the RPC. The marker is re-read inside that transaction and the next generation derives from that fresh view (`max(generation, remoteGeneration) + 1`), so a concurrent import or reconciliation is never overwritten with stale data; if the marker is no longer a conflict, nothing is rebuilt or applied. Each replacement RPC outcome commits only if the marker still matches the user ID, snapshot ID, generation, and status the attempt started from; a newer import wins untouched and no active generation is rolled back. Edits queued during the RPC carry the new generation and are pushed after the replacement succeeds. On failure the marker, snapshot, and queued edits remain intact.

### Process Sync Queue (3-phase)

The queue is processed in three distinct phases to avoid IndexedDB
async-boundary leaks:

1. **Read** — single read-only transaction to fetch all pending entries
2. **Network** — non-managed entries upsert directly. Managed entries call `apply_managed_write` with the applied generation; a `conflict` response stops the phase and keeps the entry and the rest of the queue untouched. An entry stamped below the current generation is not dropped: replacement transactions clear managed entries atomically, so a surviving older-generation entry is a post-snapshot edit from a tab with a stale in-memory generation. It raises a managed conflict before any write or pull so the queue and local rows are preserved for explicit resolution
3. **Write** — fresh readwrite transaction to delete successes and update retry counts; a retry is only re-put if the entry still exists. A managed conflict rethrows after this phase so `backgroundSync` can record the conflict marker instead of pulling

### Conflict Resolution: Last-Writer-Wins

Non-managed pushes use direct upserts; managed pushes use the generation-fenced RPC and verify the persisted row before acknowledging a queued create or update. A rejected managed edit remains queued and enters actionable conflict state, including when the generation is unchanged. Explicit resolution replaces the entire cloud managed dataset with the current local snapshot at a newer generation.

Pulls compare per-record timestamps, preserve queued local edits, and validate the applied marker inside the managed-store write transaction. See the correction details below for replacement-time replay and stale-cycle fencing.

### Soft-delete strategy

- "Delete" operations set `deleted_at` + `updated_at` on Supabase (never
  hard-delete from the REST API).
- During pull, records with `deleted_at` set are purged from local IDB.

### ensureUuids()

Called at the start of `backgroundSync()`. Scans every account and category for
legacy slug IDs (non-UUID strings) and replaces them with
`crypto.randomUUID()`. The old primary key is deleted before the new one is
written, so the unique account-name index never holds both rows. One
`readwrite` transaction covers accounts, categories, transactions,
balanceSnapshots, syncQueue, and datasetMarkers: transaction refs, a balance
snapshot's `id`/`accountId`, queue identity fields, and every persisted
replacement-marker snapshot follow the new IDs. The completion flag is
versioned. `uuid_migration_v2_done` is set only after the transaction commits.
The earlier `uuid_migration_done` key is ignored, so an installation that
completed the first migration still runs this corrected one once; after that
commit the versioned flag suppresses the scan on later syncs.

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
| **Same record edited on 2 devices offline** | See [Conflict Resolution](#conflict-resolution-last-writer-wins); rejected managed edits remain available for explicit resolution. |
| **Sync queue overflow** | Non-managed failures are dropped after 5 retries with a console warning. Managed network failures remain queued for retry; managed write conflicts remain queued for explicit resolution. |
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
4. `004_stock_sync.sql` — stocks, stock transactions, legacy dividends
5. `005_balance_snapshots.sql` — balance snapshots
6. `006_dividend_schema_compatibility.sql` — expanded dividend columns and backfill
7. `007_dataset_generation.sql` — generation table, read-only generation RLS, managed-write RPC, row fence, replacement RPC, revoked direct managed writes

After running migrations, `NOTIFY pgrst, 'reload schema'` or refresh the
Supabase API schema cache in Dashboard → API.

**Production status:** migration 007 is already applied in production following the user-confirmed successful pre-migration backup. Production postflight confirmed the generation table, six generation columns, both RPCs, and zero direct managed-write policies. Do not rerun migration 007 in production.

**Fresh deployments:** apply the migration sequence above, including 007, before enabling client sync. Without 007, `backgroundSync` stops before push/pull and leaves local data and the queue intact.

## 7. Key Decisions

| Decision | Rationale |
|---|---|
| All managed writes go through RPCs | Direct PostgREST writes cannot prove the client sent the current generation, so legacy upserts could overwrite current rows |
| Exact generation match in the trigger | Rejects omitted/older generations and arbitrary future generations |
| Generation table is client read-only | Only the RPCs may change server generation |
| Paginated remote reconciliation | Supabase caps a select at 1000 rows; a partial replace would drop rows |
| Pending managed edits produce a conflict | Silently dropping the queue or stale local rows loses user work |
| A fenced push keeps its queue entry | Retry counting would drop the user's write after five attempts even though only an explicit resolution can fix the generation |
| Local marker adoption is one transaction | Separate check, copy, and delete can overwrite a user marker or delete a newer local marker |
| Conflict preparation re-reads the marker | Reading before the transaction can rebuild and overwrite a marker changed by a concurrent import |

### Import sync correction (0.18.3)

Managed pulls validate the applied generation inside the IndexedDB write transaction; stale cycles stop before processing newer queue entries. Replacement completion rebases queued edits above cloud snapshot timestamps in FIFO order, including explicit conflict resolution. Managed writes require a persisted-row readback before acknowledgement; rejected writes remain queued and enter the existing actionable conflict state, including same-generation LWW conflicts across accounts, categories, transactions, payouts, and budget targets. Explicit resolution rebuilds the local snapshot and replaces the cloud dataset at a newer generation. Network failures retain the queue for retry. Pulls preserve records with queued changes. Settings status and repair behavior is documented in [CSV import](csv-import.md#marker-lifecycle-and-status).
