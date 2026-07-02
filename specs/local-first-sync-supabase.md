# Spec: Local-First Sync with Supabase

**Status:** 🟡 Design proposed, pending user decision

---

## Objective

Migrate from purely offline PWA to a **Local-First Sync** architecture for exactly 2 users who need cross-device syncing (Mobile phone ↔ Home PC), replacing their shared Google Sheets setup.

**Supabase** serves as the remote cloud broker. The existing `idb` layer remains the instant UI cache — offline-first is preserved.

---

## Constraints

- Zero server-side operations: no Next.js server components, API endpoints, or SSR mechanics. App must compile as a static PWA export.
- Offline-first: disconnecting the network must NOT crash the app. The ledger must remain fully interactive offline using the `idb` fallback.
- Zero regression: all existing unit tests (`*.test.ts`) and pure aggregation functions (`src/lib/aggregations.ts`, `src/lib/utils.ts`, `src/lib/reconciliation.ts`) must remain intact.
- No UI component changes — all hooks and components consume the same context shape.

---

## 1. PostgreSQL Schema

All 6 IndexedDB stores map 1:1 to Supabase tables. UUID primary keys match the `crypto.randomUUID()` format already used. Timestamps are `TIMESTAMPTZ` — conversion between `Date.now()` ms and Postgres happens in the sync layer.

**Key decision:** No `user_id` on data tables. This is a shared ledger for 2 users. RLS simply gates on `auth.role() = 'authenticated'` — both users see all rows equally.

### Tables

#### accounts

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | Matches front-end ID |
| `name` | `TEXT NOT NULL` | |
| `starting_balance` | `DOUBLE PRECISION NOT NULL DEFAULT 0` | |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

#### categories

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | |
| `name` | `TEXT NOT NULL` | |
| `type` | `TEXT NOT NULL CHECK (type IN ('income','expense','transaction'))` | |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

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
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

Indexes: `date`, `type`

#### cash_denominations

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | |
| `date` | `DATE NOT NULL` | |
| `denomination` | `DOUBLE PRECISION NOT NULL` | Bill/coin value |
| `count` | `INTEGER NOT NULL` | |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

#### payouts

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | |
| `date` | `DATE NOT NULL` | |
| `total_amount` | `DOUBLE PRECISION NOT NULL` | |
| `split_mode` | `TEXT NOT NULL CHECK (split_mode IN ('amount','percentage'))` | |
| `splits` | `JSONB NOT NULL DEFAULT '[]'` | Nested `PayoutSplit[]` |
| `savings_sub_split` | `JSONB` | Nullable nested object |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

#### budget_targets

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | |
| `category` | `TEXT NOT NULL` | |
| `month` | `TEXT` | `"YYYY-MM"` or NULL for global default |
| `amount` | `DOUBLE PRECISION NOT NULL` | |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

Indexes: `category`

### RLS Policies

All 6 tables share the same 4 policies:

```sql
-- Each table gets these 4 policies
CREATE POLICY "authenticated users can read" ON <table>
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "authenticated users can insert" ON <table>
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "authenticated users can update" ON <table>
  FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "authenticated users can delete" ON <table>
  FOR DELETE USING (auth.role() = 'authenticated');
```

---

## 2. Sync Strategy — Outbox Pattern

### Local Sync Queue (new IndexedDB store)

```
sync_queue {
  key: string (auto-generated UUID)
  value: {
    id: string;
    storeName: string;       // 'transactions' | 'accounts' | etc.
    recordId: string;        // ID of the changed record
    operation: 'create' | 'update' | 'delete';
    payload: object | null;  // full data snapshot (null for delete)
    timestamp: number;       // Date.now()
    retryCount: number;      // 0-based, max 5
  }
  indexes: { byTimestamp: number }
}
```

### Atomic Enqueue

Each `add*` / `update*` / `delete*` function in `idb.ts` enqueues a sync entry **inside the same IndexedDB transaction** as the data write — atomic by construction.

```
addTransaction(tx):
  1. generate id, timestamps
  2. db.add('transactions', newTx)
  3. db.add('sync_queue', { storeName, recordId, operation: 'create', payload, ... })
  └── one readwrite transaction → both commit or neither commits
```

### Background Sync Loop

```typescript
async function processSyncQueue(): Promise<void> {
  if (!navigator.onLine) return;

  const entries = await getUnsyncedEntries(); // oldest first
  for (const entry of entries) {
    try {
      switch (entry.operation) {
        case 'create':
        case 'update':
          await supabase.from(entry.storeName).upsert(entry.payload);
          break;
        case 'delete':
          await supabase.from(entry.storeName).delete().eq('id', entry.recordId);
          break;
      }
      await deleteQueueEntry(entry.id); // success → remove
    } catch {
      entry.retryCount++;
      entry.retryCount >= 5
        ? await deleteQueueEntry(entry.id) // dead-letter after 5 retries
        : await updateQueueEntry(entry);    // keep for retry
    }
  }
}
```

### Conflict Resolution: Last-Writer-Wins

- **Push (local→remote):** Supabase upsert uses `ON CONFLICT (id) DO UPDATE WHERE updated_at < EXCLUDED.updated_at`. If remote row has a newer `updated_at`, the local change is a no-op.
- **Pull (remote→local):** Full-replace approach (see §3). Since push ensures local changes are sent first, the pull is a clean superset.

> **ponytail:** Full-replace pull is safe for 2 users (<1K records). Per-record merge adds complexity with negligible benefit at this scale. Revisit if data volume grows past 10K records or if sync latency becomes noticeable.

---

## 3. Network Lifecycle

### Startup Flow

```
mount → seedTransactionsIfEmpty()
         ↓
    refreshTransactions() ← from local IDB (instant, same as today)
         ↓
    [if online] triggerBackgroundSync() ← fire-and-forget
         ↓
    processSyncQueue()  → push local changes to Supabase
         ↓
    pullFromSupabase()  → fetch all remote records
         ↓
    mergeIntoIDB()      → full-replace per store (see ponytail note)
         ↓
    refreshTransactions() → re-read from IDB, UI updates
```

**Critical:** The UI never waits for the network. `refreshTransactions()` runs immediately from IDB; sync is a background promise. The user sees cached data instantly, fresher data arrives when sync completes.

### Online/Offline Reactivity

```typescript
useEffect(() => {
  const handleOnline = () => backgroundSync().then(() => refreshTransactions());
  window.addEventListener('online', handleOnline);
  return () => window.removeEventListener('online', handleOnline);
}, []);
```

### Pull Strategy (full-replace)

```typescript
async function pullStore(storeName: string): Promise<void> {
  const remoteRecords = await supabase.from(storeName).select('*');
  const db = await getDB();
  const tx = db.transaction(storeName, 'readwrite');
  const allLocal = await tx.store.getAll();

  // Merge LWW: keep local if its updated_at >= remote's updated_at
  const remoteMap = new Map(remoteRecords.data.map(r => [r.id, r]));
  const toWrite: any[] = [];

  for (const local of allLocal) {
    const remote = remoteMap.get(local.id);
    if (remote && new Date(remote.updated_at).getTime() > local.updatedAt) {
      toWrite.push(transformFromSupabase(remote));  // remote is newer
    } else {
      toWrite.push(local);                           // keep local
    }
    remoteMap.delete(local.id);
  }

  // Remaining remote-only records are new
  for (const remote of remoteMap.values()) {
    toWrite.push(transformFromSupabase(remote));
  }

  // Bulk-replace
  await tx.store.clear();
  for (const record of toWrite) await tx.store.add(record);
  await tx.done;
}
```

---

## 4. File Plan

| File | Action | Purpose |
|---|---|---|
| `supabase/migrations/001_schema.sql` | **NEW** | Full SQL migration + RLS policies |
| `src/lib/supabase.ts` | **NEW** | Supabase client wrapper (anon key, URL) |
| `src/lib/sync.ts` | **NEW** | `processSyncQueue()`, `pullFromSupabase()`, background sync orchestrator |
| `src/lib/idb.ts` | **MODIFY** | Add `sync_queue` store; wrap CRUD to enqueue sync entries |
| `src/context/TransactionContext.tsx` | **MODIFY** | Call `backgroundSync()` after seed; add `online` listener |
| `.env.local` | **NEW** | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `.gitignore` | **MODIFY** | Add `.env.local` if missing |

### Files NOT changing

- `src/types/index.d.ts` — all interfaces stay identical
- `src/lib/aggregations.ts` — pure functions, unchanged
- `src/lib/utils.ts` — pure functions, unchanged
- `src/lib/reconciliation.ts` — pure function, unchanged
- `src/hooks/*` — still consume context, no changes
- `src/components/*` — all UI components unchanged
- `src/app/layout.tsx` — no server component addition
- Test configs — unchanged

---

## 5. Edge Cases

| Case | Behavior |
|---|---|
| **Offline launch** | IDB loads instantly. Sync queue accumulates. No crash. |
| **Online→offline mid-sync** | Current queue entry fails, retries on next `online` event. No partial data. |
| **Same record edited on 2 devices offline** | LWW by `updated_at`. Second device to sync loses that edit. |
| **Conflict (LWW dropped edit)** | No data loss — the dropped edit only exists on one device's IDB and is overwritten on next pull. If user notices, they can re-enter. Acceptable for 2-user household. |
| **Account deleted on one device** | Deletes from IDB + sync queue → Supabase → pulled by other device. Transactions keep the UUID references (FK `ON DELETE SET NULL` means Supabase doesn't cascade; local IDB handles via app logic). |
| **First-time setup (no Supabase project yet)** | App works fully offline. Sync silently no-ops. Once Supabase is configured, sync starts automatically. |
| **Sync queue overflow** | Max 5 retries per entry, then dropped with console warning. |
