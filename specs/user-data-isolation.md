# Spec: User Data Isolation (per-user scoping)

**Status:** 🟡 Identity-scope fencing landed; outbox, pull and deletion safety pending.

> **Current behavior:** `lastUserId` is an ownership check, not a cache-wipe
> trigger. Sign-out, unauthenticated state, a different account, or local data
> with unknown ownership in any local store hides records and retains them on
> disk. Every read and write is admitted only under a verified, current scope;
> a stale continuation cannot republish rows or errors into a later identity.
> The outbox and pull path still use the pre-Phase-3A protocol, so entries are
> pushed under whichever account currently holds the verified scope, and retry
> exhaustion still drops queued work. See [§7](#7-known-gaps) for the gaps.
>
> **Ownership check:** an unmarked cache counts as empty only when every local
> store is empty. A cache with no marker that still holds records is retained,
> hidden, and left unassigned rather than claimed by the next sign-in.
>
> **Sync-layer notes (Jul 2026):** `pullStore()` scopes queries with
> `.eq('user_id', userId)` and every outgoing payload is stamped with `userId`.
> Migration 003 (`sort_order`) fixed a 400 caused by sending a column a table
> did not have yet.

---

## Objective

Isolate each user's data behind their Supabase Auth user ID. Currently all users share a single ledger (no `user_id` column, RLS gates on `auth.role() = 'authenticated'`). After this change, each user sees only their own transactions, accounts, categories, etc.

**Key decision:** Wipe existing shared data from both Supabase and local IndexedDB. No backfill or ownership migration. Both users start fresh after the rollout.

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

`clearAllLocalData()` still exists and clears every store, but the auth lifecycle no longer calls it on sign-out, account switch, or unauthenticated startup. Queued work is retained with the cache and pushed only while a verified scope owns it; nothing in the current client moves it to another account.

---

## 3. Sync layer changes (`sync.ts`)

### `processSyncQueue()`
- At the top, resolve the current user: `const { data: { user } } = await supabase.auth.getUser()`
- If no user, bail entirely (don't push anonymous data)
- Stamp `userId` onto every outgoing create/update payload before the `camelToSnake()` transform

### `pullStore(storeName)`
- Add a `userId` parameter
- Scope the Supabase select: `.select('*').eq('user_id', userId)`
- This is defensive — RLS already scopes it, but explicit filtering is clearer and avoids pulling data that the merge would reject anyway

### `backgroundSync()`
- Resolve current user first
- Bail entirely if no session (skip both push and pull)
- Pass `user.id` to `pullStore()`

### Transform map
- Add `userId: 'user_id'` to `FIELD_MAP` in sync.ts (and reverse will be auto-generated)

---

For saved transaction filter isolation, see the [filter persistence contract](transaction-filters.md#2-behavior-contract).

## 4. Auth lifecycle (`TransactionContext.tsx`)

### Current behavior
The provider binds a verdict to the exact rendered identity: `verifiedAuth`
holds the `{state, userId, generation}` that passed every ownership check, and
`isScopeVerified` is true only while the current render matches it. A new
identity therefore renders unverified immediately, before the startup effect
runs. Every IndexedDB read captures the rendered identity plus the shared
`auth-scope` token; only the newest read for the current scope may publish rows,
errors, or settle loading.

```typescript
// localStorage key identifying the cached account
const LAST_USER_KEY = 'lastUserId';

// disabled (no Supabase) → local-only owner; verification is granted to the
//   rendered identity of this run
// loading → no verdict, no rows
// unauthenticated → hidden, retained; verdict cleared
// authenticated → marker/user/emptiness checks decide, then verify
```

**On mount (authenticated):**
1. Read `lastUserId`
2. Marker names another account → fail closed: no rows, no marker write, no sync
3. No marker → `hasAnyLocalData()` decides: any record in any store fails
   closed; a truly empty database is claimed by writing the marker
4. Marker matches → verify, publish the local cache, settle loading, then run
   `backgroundSync()` and refresh from IndexedDB if the identity is still current

**On sign-out / unauthenticated:**
1. Hide transactions, accounts, and categories; clear the verdict
2. Keep IndexedDB, the outbox, and the `lastUserId` marker on disk
3. Render nothing private (`AuthGuard` handles routing)

**On sign-in as a different account while a cache exists:** the marker mismatch
keeps the scope unverified, so the new account sees no rows and cannot export,
mutate, or sync the retained cache. The owner must sign back in as the account
that owns the cache; the app never reassigns it.

### Why the marker?
It names the account that owns the cache. Case-folding ownership into a boolean
would let a later identity inherit a previous session's verdict, so the verdict
is bound to the rendered identity instead.

---

## 5. Edge cases

| Case | Behavior |
|---|---|
| **Same user refreshes page** | Marker matches → verified immediately; `backgroundSync()` pulls latest data. |
| **User A signs out, User B signs in** | A's cache, outbox, and marker stay on disk, hidden from B. B's scope stays unverified, so no rows render and no sync or export runs. A signing back in restores A's view. |
| **Offline + cached session** | `getUser()` returns the cached user; ownership checks still run against IndexedDB. |
| **Offline + no session** | `getUser()` errors → the app renders nothing private and routes to `/login`. |
| **Supabase not configured** | `state === 'disabled'` — local-only owner; reads and writes are admitted for the rendered identity without a marker. |
| **Unsaved changes on sign-out** | Queued entries and their payloads stay in `syncQueue`; they are pushed only under the verified owner's scope. |
| **Unmarked cache with records** | Fails closed: retained, hidden, not exported, never reassigned to the signed-in account. |
| **First sign-in (fresh install)** | No marker and every store empty → the cache is claimed, then `backgroundSync()` pulls that account's data. |
| **First sign-in after migration (existing install)** | DB v8 migration clears the pre-isolation shared cache; ownership is decided as above. |

---

## 6. What does NOT change

- All existing IDB CRUD functions (`addAccount`, `getAllTransactions`, etc.) — they read/write local cache, no user awareness needed
- `src/types/index.d.ts` — interfaces stay the same (no `userId` field in local types)
- UI routing and screens — unchanged; the same hooks and context feed them
- Offline-first — IDB is the source of truth for UI; sync is background
- `src/context/AuthContext.tsx` — clears the saved transaction filter mirror at identity boundaries
- The sync protocol itself — push, pull, retry counting, and remote tombstones behave as before; see §7

---

## 7. Rollout order

1. Apply `002_user_isolation.sql` to Supabase (wipes shared data)
2. Deploy updated app code (DB v8 migration clears local caches)
3. Users sign in → each sees their own empty data
4. Import/enter data per user

---

## 8. Known gaps

These are still the pre-Phase-3A protocol on `main`, and the identity-scope work
does not change them:

- **Retry exhaustion drops work.** `src/lib/sync.ts` deletes a queue entry once
  `retryCount >= 5`; the payload and error history are lost.
- **Pull can overwrite pending local edits.** `pullStore()` merges remote rows
  without consulting the outbox, so a newer remote row can replace an unpushed
  local change.
- **Remote tombstones remove local rows without an archive.** Nothing keeps a
  recoverable snapshot of a record deleted because the cloud row was deleted.
- **Acknowledgement is optimistic.** A write is treated as applied without a
  read-back comparison against the intended payload.
- **The optimistic local delete removes the row before the server agrees**, and
  no per-record baseline is stored, so a later push cannot detect a remote edit.
- **No owner stamp on queued work.** Entries are pushed under whichever account
  currently holds the verified scope; a second account never inherits them only
  because its scope stays unverified.
- **No server-managed revisions, atomic receipts, or older-client protection.**
  RLS scopes rows; it does not make concurrent writes safe.

Same-user sign-out → sign-in recovery has not been exercised in a browser, and
no authenticated two-client run has been performed against this integration.

## 9. Regression coverage

- `src/lib/auth-scope.test.ts` — generation publication, exact scope capture, invalidation
- `src/context/AuthContext.test.tsx` — identity generations, filter-mirror clearing, sign-out recovery
- `src/context/TransactionContext.test.tsx` — startup barrier, stale read/error/loading publication fences, sync lifecycle
- `src/hooks/useAccounts.scope.test.tsx`, `useCategories.scope.test.tsx`, `useStocks.scope.test.tsx` — render-time bucket reset, cached-callback inertness, admission-time write gates
- `src/app/available-balance/page.scope.test.tsx`, `page.provider-scope.test.tsx` — balance and denomination reads/writes under verified, revoked, and transitioning scopes
- `src/app/stocks/page.scope.test.tsx` and `src/lib/stock-prices.test.ts` — the live scope predicate reaching every price write
- `src/components/auth/AuthGuard.test.tsx` — public login paths, failure-closed rendering, PIN precedence
