# Spec: Local-First Sync with Supabase

**Status:** ✅ Done — client-side containment under the transitional REST
protocol. Phase 3B server revisions, atomic receipts, and an old-client
compatibility or retirement plan remain unimplemented.

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

Ten IndexedDB financial stores map 1:1 to Supabase tables: the six core stores
(`transactions`, `accounts`, `categories`, `cashDenominations`, `payouts`,
`budgetTargets`) and four later synchronized financial stores
(`balanceSnapshots`, `stocks`, `stockTransactions`, `dividends`). The three
local safety stores (`syncQueue`, `syncMeta`, `syncDeletions`) have no remote
table. UUID primary keys match the `crypto.randomUUID()` format. Timestamps are
`TIMESTAMPTZ` — conversion between `Date.now()` ms and Postgres happens in the
sync layer.

The schema below documents the six core tables. Migration `004` adds `stocks`,
`stockTransactions`, and `dividends`; `005` adds `balanceSnapshots`; `006`
expands the dividend shape and backfills legacy rows.

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

-- Applied to: accounts, categories, transactions, payouts, budget_targets,
-- balance_snapshots, stocks, stock_transactions, dividends
-- (cash_denominations has no updated_at column)
```

### RLS (per-user, from migration 002)

All six core tables share 4 policies each; the four later financial tables added
in migrations 004–006 use the same per-user policy pattern:
- `SELECT USING (auth.uid() = user_id)`
- `INSERT WITH CHECK (auth.uid() = user_id)`
- `UPDATE USING (auth.uid() = user_id)`
- `DELETE USING (auth.uid() = user_id)`

---

## 2. Sync Strategy — Outbox Pattern

`syncQueue` stores durable outbound operations. Each entry has an ID, target
store/record, operation and payload, FIFO timestamp, retry count, verified
`ownerId` (or `null`), state (`pending`, `blocked`, `conflict`, or
`quarantined`), optional baseline/revision, optional deletion-snapshot ID, and
attempt/error metadata. Legacy entries without trustworthy ownership are
preserved and quarantined; they are not assigned to the current user or replayed.

`syncMeta` stores per-record owner, last observed remote baseline and revision,
local update time, and conflict state. `syncDeletions` stores recoverable record
snapshots for local and remote deletions. These stores are local-only, but they
are included in the startup emptiness/ownership check: an unmarked cache is
claimed only when all 13 stores are empty (see §3 and
[User Data Isolation §5](user-data-isolation.md#5-fixed-behavior-unowned-safety-only-caches-fail-closed)).

### Atomic Enqueue

Each local mutation and its queue entry are written in the same IndexedDB
transaction. Local deletion also writes its recoverable snapshot in that
transaction. Failure of the transaction commits none of those local changes.

The queue timestamp uses a monotonic counter seeded from `Date.now()` so
multiple mutations in one millisecond retain FIFO order.

### Process Sync Queue

Queue work follows Read → Network → Write, with no IndexedDB transaction held
across a Supabase request. The write phase removes an entry only after the
returned server representation has been checked. Failed work remains durable;
after five failures it becomes `blocked` rather than being deleted.
`conflict` entries preserve both versions for manual review (there is no
in-app conflict-resolution UI), and `quarantined` entries require trustworthy
ownership before they can be replayed.

Creates use a server readback check. Updates and deletions compare the stored
baseline token and verify the response. A zero-row compare-and-set (CAS) result,
unexpected server row, or missing baseline is not acknowledged.

The outcome transaction re-reads the queued entry before writing queue,
metadata, or deletion state. It applies success, retry, or conflict outcomes
only while the exact pending operation sent to Supabase remains unchanged. If
restore or another local change replaces or conflicts it during the request,
the client preserves the current queue and metadata and applies no stale
outcome. The request may already have committed remotely.

### Transitional conflict handling

The client protects local records with pending edits from remote active rows and
tombstones. Pull merges read local rows, outbox entries, and record metadata
inside the same IndexedDB read-write transaction that applies merged rows,
conflicts, and deletion archives. The remote fetch remains outside this
transaction; overlapping local CRUD writes are serialized before or after the
merge, so its decisions do not use stale pre-transaction state. A competing
active row or tombstone becomes a conflict; neither version is silently
substituted. An untouched local record receiving a remote tombstone is archived
before local removal.

An empty successful pull still runs this merge. A local-only record without a
queued operation or known remote baseline remains in IndexedDB and is marked
quarantined, so the empty response cannot certify it as synchronized.

This is client-side containment, not a server-managed revision protocol. The
existing `updated_at` comparisons do not provide atomic operation receipts,
exactly-once effects, or reliable multi-client conflict resolution. Older clients
can still use the existing REST/upsert protocol; a future RPC cutover needs an
old-client compatibility or retirement plan.

### Auth-generation fencing

Every sync cycle captures the AuthProvider-published identity generation (the
user ID plus the exact persisted `lastUserId` owner marker) before its first
await. Push and pull receive that captured token; neither recaptures the active
identity mid-cycle. A same-user token refresh does not advance the generation,
but signing out and signing back in — even as the same user — does.

A pull revalidates the token after the remote request and after its IDB read.
Its merge transaction registers with the auth scope, so invalidation aborts it
synchronously; later writes in that transaction fail and roll back, and the
`finally` releases the registration. An aborted transaction or a stale response
is treated as cancellation, not success: it cannot write rows, metadata, or
deletion archives, acknowledge queue work, dispatch sync events, or advance
`last_sync_time`, even when the remote snapshot is empty.

This guarantee is client-side only. It does not add server-managed revisions,
atomic operation receipts, cross-client ordering, or exactly-once effects; the
transitional REST protocol above remains unchanged.

### Current protocol limits (Phase 3A)

- **Unpaginated pulls.** Each table pull is one `.select('*').eq('user_id', …)`
  request without paging (`src/lib/sync.ts:1004-1008`). A remote result above
  the API row limit is incomplete for that cycle.
- **Stock deletion is not one remote operation.** The local archive and delete
  are atomic, but the remote side receives individual delete queue operations
  for the affected records (`src/lib/idb.ts:1410-1470`).
- **Reference checks live in the UI.** Account/category in-use checks run in
  Settings (`src/app/settings/page.tsx:421-435,783-797`), not inside the
  IndexedDB deletion functions (`src/lib/idb.ts:835-855,962-982`). Direct IDB
  deletes can leave dangling references.
- **Cash snapshot replacement is multi-step.** It deletes existing rows by
  date and then inserts each denomination as a separate call
  (`src/components/available-balance/CashDenominationInput.tsx:71-89`).
- **Privileged writers bypass the outbox.** The portfolio API and price-refresh
  script update stock prices directly in Supabase (`server/index.ts:361-365`,
  `server/refresh-prices.mjs:72-76`), outside client baselines and receipts.
- **No server revision/receipt protocol.** The REST protocol has no
  server-managed revisions or atomic operation receipts. Do not claim
  exactly-once effects, complete cloud backup, or full concurrency guarantees.

These are current limitations, not promised fixes.

### Recoverable deletion

Local deletion archives the full record and enqueues the delete atomically.
Records removed with a related-record cascade are also archived before removal
in that transaction. Remote tombstones never erase a pending local edit;
deletion snapshots remain available for recovery and are not automatically
cleaned up.

### ensureUuids()

Called at the start of `backgroundSync()`. Scans all stores for legacy slug IDs
(non-UUID strings) and replaces them with `crypto.randomUUID()`. This smooths
the migration from the old slug-based ID scheme.

`resyncAll()` is nondestructive. It retains queued operations, baselines,
conflicts, quarantined entries, and deletion archives. It retries eligible
blocked work without rebuilding the outbox or duplicating already queued local
changes. It does not resolve conflicts automatically.

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
    verify local cache owner before loading it
         ↓
    refresh UI from the verified local IndexedDB cache
    settle initial loading
         ↓
    ┌─ offline or auth disabled → remain local-only
    └─ authenticated and online → start backgroundSync() without awaiting it
                                  ↓
                                  push eligible operations → pull all ten stores
                                  ↓
                                  protect pending work; record conflicts or archive tombstones
                                  ↓
                                  after any settle (true, false, rejection),
                                  refresh IndexedDB if this identity is current
```

For authenticated startup, the verified local read completes before the
background sync is invoked; network work never gates initial loading. The
post-sync refresh runs after any settled attempt, including a `false` result or
rejection, and remains scoped to the startup identity. `isScopeVerified` means
local ownership was verified, not that cloud reconciliation completed. Within
one provider and identity generation, only the newest authorized IndexedDB read
may publish rows, errors, or loading completion. Startup is keyed by auth state,
user ID, and generation; a new `User` object with the same identity does not
restart it.

Online and foreground lifecycle events are gated by a provider-local marker for
the current rendered identity's completed initial local read; ownership
verification alone does not permit a pre-read sync.

These are client-side scheduling and publication guards. They do not provide
cross-tab request ordering or server-managed revisions, atomic receipts, or
exactly-once effects; those guarantees require the future server protocol.

On sign-out, unauthenticated state, or a different signed-in account, cached
records and queued work are hidden from the UI and retained. A user mismatch, or
an unowned cache with a record in any of the 13 stores, fails closed; it is
neither cleared nor uploaded under the new identity. `hasAnyLocalData()` checks
the ten financial stores plus `syncQueue`, `syncMeta`, and `syncDeletions` in one
readonly transaction, so a cache whose only records are sync-safety entries is
not treated as empty and is never assigned to the signed-in account. Those
safety records stay local and hidden, and export, import, restore, and
AutoBackup remain gated while the scope is unverified; the app has no automatic
reassignment path for an unmarked cache that still holds records. This is
verified client behavior under the transitional REST protocol; it does not add
server-managed revisions or receipts.

UI reads and lifecycle refreshes capture the identity generation that started
them. A read, error, or `finally` handler that resumes after a transition cannot
repopulate transactions, accounts, or categories from the previous generation,
and cannot trigger a refresh for a stale scope. `AuthGuard` renders no private
children while unauthenticated and remounts the authenticated subtree whenever
the generation changes. These are client-side guards; they do not strengthen the
transport protocol's revision or receipt guarantees.

The UI remains local-first. Sync completion is reported separately from full
reconciliation: pending, blocked, conflicted, or quarantined work prevents a
clean-success status.

**Critical:** The UI never waits for the network. `refreshTransactions()` runs
immediately from IDB; sync is a background promise.

### Online/Offline Reactivity

Online and foreground events request background reconciliation only after the
current identity's initial local IndexedDB read has settled. A sync-complete
event refreshes IndexedDB only when the current identity is still authorized.

### Pull and conflict behavior

Pulls are scoped by authenticated `user_id`. Records with pending local work are
not overwritten by a newer remote active row or removed because of a remote
tombstone. Competing remote state is recorded as a conflict while both versions
remain recoverable. An untouched local row replaced by a tombstone is archived
before removal. A pull whose authorizing identity generation is invalidated
(sign-out, account switch, or same-user re-login) is a no-op: it never merges,
deletes, acknowledges work, or reports success. This is best-effort client-side
protection under the current REST protocol, not a server-enforced revision
guarantee.

---

## 4. File Plan

| File | Action |
|---|---|
| `supabase/migrations/001_schema.sql` | **NEW** — Full schema + LWW trigger + initial RLS |
| `supabase/migrations/002_user_isolation.sql` | **NEW** — TRUNCATE + user_id + per-user RLS |
| `supabase/migrations/003_add_sort_order.sql` | **NEW** — sort_order for accounts/categories |
| `src/lib/supabase.ts` | **NEW** — Supabase client wrapper (null if env missing) |
| `src/lib/auth-scope.ts` | **NEW** — Published identity generation, scope tokens, transaction invalidation registry |
| `src/lib/sync.ts` | **NEW** — processSyncQueue, scope-fenced pullStore, backgroundSync, FIELD_MAP |
| `src/lib/idb.ts` | **MODIFY** — Add syncQueue store, wrap CRUD to enqueue, monotonic counter, ensureUuids, resyncAll |
| `src/lib/constants.ts` | **MODIFY** — DB_VERSION, STORES including syncQueue |
| `src/context/AuthContext.tsx` | **MODIFY** — Auth provider + guard with useEffect redirect |
| `src/context/TransactionContext.tsx` | **MODIFY** — Auth-aware cache lifecycle, generation-fenced reads/refreshes, call backgroundSync |
| `src/components/auth/AuthGuard.tsx` | **MODIFY** — Fail closed while unauthenticated; key the app subtree by auth generation |
| `src/app/layout.tsx` | **MODIFY** — Wrap with AuthProvider + AuthGuard |
| `src/app/login/page.tsx` | **NEW** — Magic link form |
| `src/app/settings/page.tsx` | **MODIFY** — Sign-out button, SyncSection |
| `.env.local` | **NEW** — Supabase URL + anon key |

---

## 5. Edge Cases

| Case | Behavior |
|---|---|
| **Offline launch** | Local IndexedDB remains available; unsynced operations stay in the durable outbox. |
| **Online→offline mid-sync** | The attempted operation remains queued; retry failures are visible as blocked work. |
| **Concurrent edits on separate devices** | Client baseline checks can detect some changes and preserve both versions; they do not provide server-managed revisions or atomic receipts. |
| **Retry exhaustion** | The operation is retained as `blocked`; it is never discarded automatically. |
| **Resync** | Retains the outbox, conflicts, baselines, and archives; retries eligible work without rebuilding the queue. |
| **Account switch or sign-out** | Local data is hidden and retained. A mismatched cache, or an unowned cache with a record in any of the 13 stores (including a safety-only cache), is not loaded, claimed, or replayed. Export/import/restore/AutoBackup stay locked while the scope is unverified; an unmarked cache with records is never automatically reassigned. See [User Data Isolation §5](user-data-isolation.md#5-fixed-behavior-unowned-safety-only-caches-fail-closed). |
| **Legacy unowned outbox operation** | Preserved as `quarantined`; it is not assigned to the active account. |
| **Supabase not configured** | App remains local-only; no cloud sync is available. |
| **Overlapping sync cycles** | `syncInFlight` prevents concurrent background sync cycles in this client instance. |
| **Cash-denomination schema mismatch** | Deletion avoids unsupported `updated_at` writes; updates without a valid baseline fail closed as conflicts. |
| **Older client coexistence** | Older clients may bypass client-side safeguards. The future RPC cutover requires a compatibility or retirement plan. |

---

## 6. Migrations

### Migration order (run sequentially on Supabase)

1. `001_schema.sql` — six core tables, LWW trigger, initial auth.role() RLS
2. `002_user_isolation.sql` — TRUNCATE, user_id column, per-user RLS
3. `003_add_sort_order.sql` — sort_order on accounts + categories
4. `004_stock_sync.sql` — stocks, stock_transactions, and legacy dividends tables
5. `005_balance_snapshots.sql` — balance_snapshots table
6. `006_dividend_schema_compatibility.sql` — expanded dividend columns and legacy backfill

After running migrations, `NOTIFY pgrst, 'reload schema'` or refresh the
Supabase API schema cache in Dashboard → API.
