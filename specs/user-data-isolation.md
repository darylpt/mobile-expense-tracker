# Spec: User Data Isolation (per-user scoping)

**Status:** ✅ Client-side safety fix verified — unowned safety-only caches fail
closed (§5). Server protocol limits remain; this is not a Phase 3B or release
approval.

> **Current behavior (Phase 3A):** `lastUserId` is an ownership check, not a
> cache-wipe trigger. Sign-out, unauthenticated state, a different account, or
> local data with unknown ownership in any of the 13 local stores hides records
> and retains them with their outbox and deletion snapshots. Legacy queue entries
> without a verified owner are quarantined, not replayed. This client-side
> containment does not replace server-enforced revisions or atomic operation
> receipts.
>
> **Ownership check:** an unmarked cache counts as empty only when all 13 stores
> are empty. A safety-only cache with no marker is therefore retained and left
> unassigned, not claimed by the next signed-in account. See §5.

---

## Objective

**Historical objective:** isolate each user's data behind their Supabase Auth
user ID. That rollout added per-user RLS; the migration's original shared-data
wipe is historical and does not describe current local account transitions.

**Historical rollout decision:** The original shared-data isolation rollout
intentionally wiped shared Supabase data and old local caches. That migration
history does not describe current account-transition behavior.

---

## Files

### New files

| File | Purpose |
|---|---|
| `supabase/migrations/002_user_isolation.sql` | TRUNCATE all 6 tables + ADD COLUMN `user_id` + new RLS policies |

### Modified files

| File | Change |
|---|---|
| `src/lib/constants.ts` | `DB_VERSION`: 7 → 8 |
| `src/lib/idb.ts` | DB v8 migration: clear all 6 stores + syncQueue. Export `clearAllLocalData()`. |
| `src/lib/sync.ts` | Stamp `user_id` on outgoing creates/updates. Scope pulls to current user. Bail if no session. |
| `src/context/TransactionContext.tsx` | Watch auth state via `useAuth()`. Wipe local cache on user change. |
| `specs/README.md` | Add this spec to index |
| `specs/local-first-sync-supabase.md` | Update shared-ledger decision note |

---

## 1. Supabase migration (`002_user_isolation.sql`)

### What it does

1. **TRUNCATE** all 6 data tables (wipes shared data)
2. **ADD COLUMN `user_id`** UUID NOT NULL REFERENCES `auth.users(id)` ON DELETE CASCADE on each
3. **Index** each table on `user_id`
4. **Drop** the 4 `auth.role() = 'authenticated'` policies per table
5. **Create** per-user RLS policies:

```sql
CREATE POLICY "users can read own rows" ON <table>
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "users can insert own rows" ON <table>
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users can update own rows" ON <table>
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "users can delete own rows" ON <table>
  FOR DELETE USING (auth.uid() = user_id);
```

Tables: `accounts`, `categories`, `transactions`, `cash_denominations`, `payouts`, `budget_targets`.

---

## 2. IDB: DB migration v7 → v8

### `src/lib/constants.ts`
- `DB_VERSION`: 7 → 8

### `src/lib/idb.ts`

**In `upgrade()` callback**, add:

```typescript
if (oldVersion < 8) {
  // Wipe old shared-data caches — user isolation means each
  // device's local cache belongs to the currently signed-in user.
  for (const storeName of Object.values(STORES)) {
    const store = transaction.objectStore(storeName);
    await store.clear();
  }
}
```

This runs once per existing install. Fresh installs (no prior DB) skip this — stores are created empty anyway.

**New exported function:**

```typescript
export async function clearAllLocalData(): Promise<void> {
  const db = await getDB();
  for (const storeName of Object.values(STORES)) {
    const tx = db.transaction(storeName, 'readwrite');
    await tx.objectStore(storeName).clear();
    await tx.done;
  }
}
```

Used by the auth lifecycle in TransactionContext (step 4). Separate from the migration path so it can fire on sign-out too.

### Sync queue note

`STORES.SYNC_QUEUE` is included in the clear. Any unsynced local changes from the previous user are discarded on sign-out — they were never pushed to Supabase and belong to a different user. This is intentional: offline-created records that haven't synced yet are lost on user switch.

---

## 3. Sync layer changes (`sync.ts`)

### `processSyncQueue()`
- At the top, resolve the current user: `const { data: { user } } = await supabase.auth.getUser()`
- If no user, bail entirely (don't push anonymous data)
- Stamp `userId` onto every outgoing create/update payload before the `camelToSnake()` transform

### `pullStore(storeName, userId)`
- Scope the Supabase select: `.select('*').eq('user_id', userId)`
- This is defensive — RLS already scopes it, but explicit filtering is clearer and avoids pulling data that the merge would reject anyway
- Direct callers must hold the exact captured auth scope (matching user, generation, and `lastUserId` marker); a supplied user ID never widens it
- `backgroundSync()` uses a private scoped path with the token captured at cycle entry, so a sign-out/re-login cannot revive old pull work
- The merge transaction is registered with the auth scope and aborts synchronously on invalidation; a stale response or aborted merge is a no-op, not success

### `backgroundSync()`
- Resolve current user first
- Bail entirely if no session (skip both push and pull)
- Capture one auth scope at cycle entry and pass it to push and pull; never recapture mid-cycle

### Transform map
- Add `userId: 'user_id'` to `FIELD_MAP` in sync.ts (and reverse will be auto-generated)

---

For saved transaction filter isolation, see the [filter persistence contract](transaction-filters.md#2-behavior-contract).

## 4. Auth lifecycle (`TransactionContext.tsx`)

### Current Phase 3A behavior

- Supabase disabled: local-only access remains available.
- Authenticated user matches the verified `lastUserId`: the cache may be loaded
  and sync is scoped to that user.
- Different authenticated user: local data remains in IndexedDB but is hidden;
  the app does not pull into or upload from that cache under the new identity.
- No marker with at least one record in any store, including a safety-only
  cache: ownership is unknown, so the cache remains hidden, is not uploaded, and
  is never claimed for the signed-in user. See §5.
- No marker and no records in any of the 13 local stores: the cache is treated
  as empty and assigned to the signed-in user. `hasAnyLocalData()` inspects all
  13 stores in one readonly transaction, so a cache that retains only
  `syncQueue`, `syncMeta`, or `syncDeletions` records is not empty.
- Sign-out or unauthenticated state: local data, queued operations, and deletion
  snapshots are retained but hidden. Sign-out does not guarantee pending work
  reached Supabase.
- The Available Balance page and cash-denomination controls start local reads
  and writes only under a verified, current page scope. Identity changes,
  verification revocation, and unmount fence stale results and callbacks;
  retained IndexedDB snapshots remain hidden rather than reassigned. Writes
  already admitted while authorized may finish. These UI guards do not add
  server-side revision checks or cancel an in-flight IndexedDB transaction.
- In-flight reads and lifecycle refreshes capture the `AuthContext` identity
  generation. A continuation from a previous generation cannot repopulate
  transactions, accounts, or categories, publish a stale error/loading state, or
  trigger a refresh after sign-out or same-user re-login.
- Stock-price refresh takes a required `isCurrent` predicate from the Stocks
  page. The service checks it before starting, after the local stock read,
  after the network response and JSON body awaits, and immediately before each
  `updateStock` call. A false result stops the refresh and returns no results,
  so a price write plus its outbox entry is never started for a revoked page
  scope. The predicate is sensitive to verification revocation alone (same
  identity generation), to a new page scope after re-verification, to a changed
  shared identity generation before the page rerenders, and to unmount. In
  verified Supabase-disabled mode the same predicate is live, because
  local-only access is authorized by verification. A write admitted while the
  predicate was true is not cancelled or rolled back: `updateStock` performs
  its own asynchronous stock + outbox transaction, so the guarantee is
  admission-time only. There is no transaction-time cancellation or
  server-side concurrency guarantee.
- Only the exact public login routes `/login` and `/login/` render children
  while unauthenticated. Other paths render no private children and replace to
  `/login`; the authenticated subtree is keyed by generation, forcing a remount
  on every identity transition.
- Legacy queue entries with unknown ownership are preserved as quarantined work.

The app has no automatic local-data transfer between users. The owner must sign
back in to access an owned cache; Phase 3A does not decide ownership for
unassigned legacy records, including safety-only caches. An unowned cache is
never adopted by a newly signed-in account, so its records remain local,
hidden, and retained; the app has no automatic reassignment path for an
unmarked cache that still contains records. Push/pull cycles and UI
reads are fenced by the identity generation captured when they started, so work
authorized before sign-out or a same-user re-login cannot become authoritative
again. These are client-side safety checks. They do not stop older clients from
using the direct REST protocol or provide server-managed revision and
idempotency guarantees.

Earlier sections document the original v8 isolation migration and its rollout;
they are historical implementation details, not the current sign-out or
account-switch procedure.

---

## 5. Fixed behavior: unowned safety-only caches fail closed

`hasAnyLocalData()` (`src/lib/idb.ts`) opens one `readonly` transaction over
`ALL_BACKUP_STORES` — the ten financial stores plus `syncQueue`, `syncMeta`, and
`syncDeletions` — and returns true as soon as any store holds a record.
The result is used only after the transaction completes. The helper does not
write, clear, reassign, or repair any record while checking.

On authenticated startup without a `lastUserId` marker,
`TransactionContext.tsx` calls `hasAnyLocalData()` before assigning ownership.
The outcomes are:

- **Any record in any of the 13 stores.** Ownership is unverified. Startup sets
  `isScopeVerified = false`, publishes no financial rows, writes no
  `lastUserId` marker, and does not start background sync. A safety-only cache
  (outbox, metadata, or deletion archives with empty financial stores) is
  therefore retained and left unassigned. Its payloads, owner fields, and queue
  state are unchanged.
- **No record in all 13 stores.** The cache is truly empty; startup may claim it
  by writing `lastUserId` for the signed-in user, verify the scope, and start
  sync.
- **The check itself fails** (for example, the database is unavailable). Startup
  treats that as an error, not as an empty cache: it does not claim ownership or
  mark the scope verified.

Export, import, restore, and AutoBackup all require `isScopeVerified`. A
safety-only cache that fails ownership verification keeps those tools locked:
the retained safety records stay local, hidden, and unexportable while the scope
is unverified. A matching-owner scope can still export all
13 stores, including `syncQueue`, `syncMeta`, and `syncDeletions`. The export
snapshot does not encode its owner, and restoring it does not transfer cloud
ownership (see [Backup / Restore](backup-restore.md#sensitive-data)).

### Regression coverage

Focused tests assert this client behavior:

- `src/lib/phase3a-idb.test.ts` — `hasAnyLocalData()` returns true for a
  safety-only cache and for each safety store seeded alone, returns false only
  when all 13 stores are empty, leaves records unchanged, and rejects instead of
  reporting empty when the database is unavailable.
- `src/context/TransactionContext.startup.test.tsx` — a new user is refused an
  unowned cache seeded with `syncQueue`, `syncMeta`, or `syncDeletions`; a truly
  empty database is claimed; AutoBackup creates or replaces no snapshot while
  the scope is refused.
- `src/app/settings/page.scope.test.tsx` — every data-tool action stays locked
  for an unowned safety-only cache, and a matching owner can export all 13
  stores through Settings.
- `src/lib/stock-prices.test.ts` — `refreshAllPrices` uses real fake-IndexedDB
  stock records and real sync-queue insertion while only the Phisix response is
  mocked. Cases cover an initially invalid scope, invalidation during the local
  read, during a deferred network response, during a deferred JSON body, and
  between two stock writes; a fully valid refresh updates both prices and their
  queue entries.
- `src/app/stocks/page.scope.test.tsx` — the page passes its live scope
  predicate to the refresh service and keeps it false after verification
  revocation, re-verification, a shared identity publication without a
  rerender, and unmount; it is true in verified Supabase-disabled mode.
- `e2e/stocks-price-refresh.spec.ts` — a successful refresh is displayed and
  persists across reload; a deferred refresh followed by client-side
  navigation away, response release, and return leaves the stock and outbox
  unchanged.

### Public anonymous A/B observation (2026-11-15)

One manual check ran against the dedicated non-production Supabase project with
two anonymous users (A and B) signed in through separate isolated browser
contexts of the static export. It created exactly one synthetic zero-balance
account, named for the run, and no other records.

- The app accepted A as the local cache owner, and the created row was readable
  by A with `user_id = A`.
- B's UI showed no A account, B's direct Supabase query returned no A row, and
  A's row was still present after B's check.

Limits of this observation:

- Coverage is one account row; no transaction, cash, stock, budget-target, or
  balance-snapshot record was exercised across users.
- Same-user sign-out → sign-in recovery was not exercised.
- Fixture cleanup was not confirmed. The app's delete control left the remote
  row active after the sync wait, and the run's browser sessions ended before a
  retry, so the synthetic row and both anonymous Auth users were removed by the
  project owner outside the app. The repository does not verify the
  `ON DELETE CASCADE` effect on that row.
- Anonymous sign-ins were enabled only for this run.

These tests and the observation above describe local client behavior plus one
sampled public check. They do not add server-managed revisions, atomic
operation receipts, or a guarantee that older clients respect the same
ownership check. Phase 3B server protocol work remains outstanding.

---

## 6. Scope and current constraints

- Local CRUD remains IndexedDB-backed; authenticated mutations are permitted only after the cache owner is verified.
- Queue entries carry an owner when available; unknown-owner work stays quarantined.
- UI data remains local-first, but a cache with mismatched ownership, or unknown
  ownership with a record in any of the 13 stores, is hidden rather than loaded
  and is never reassigned to the signed-in account. §5 covers the safety-only
  case.
- Sign-out retains local records and recovery metadata; it does not guarantee an attempted sync has completed.
- `AuthContext` also clears the saved transaction-filter mirror at identity boundaries.

---

## 7. Historical rollout record

The original shared-data isolation rollout was:

1. Apply `002_user_isolation.sql` to Supabase (the migration truncates shared data).
2. Deploy the then-current app (DB v8 migration cleared old local caches).
3. Users sign in and import or enter data per user.

This is historical deployment information, not a current Phase 3A instruction.
