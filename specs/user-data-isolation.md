# Spec: User Data Isolation (per-user scoping)

**Status:** ✅ Done

> **Implementation notes (Jul 2026):** A `lastUserId` localStorage marker prevents
> unnecessary cache wiping on same-user page refresh — only clears local data when
> the signed-in user actually changes. Sync queue entries from the old user are
> discarded on user switch (intentional — unsynced changes from another user should
> not pollute the new user's queue). The sync layer stamps `userId` on every
> outgoing payload. `pullStore()` now scopes queries with `.eq('user_id', userId)`.
> Migration 003 (`sort_order` column) was added later to fix a 400 error caused by
> the sync code sending `sort_order` to tables that didn't have the column yet.

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

`STORES.SYNC_QUEUE` is included in the clear. Any unsynced local changes from the previous user are discarded on sign-out — they were never pushed to Supabase and belong to a different user. This is intentional: offline-created records that haven't synced yet are lost on user switch.

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

## 4. Auth lifecycle (`TransactionContext.tsx`)

### Current behavior
On mount: seeds data (removed), runs `refreshTransactions()`, triggers `backgroundSync()` if online. Listens for `online` events.

### New behavior
Consume `useAuth()` and track auth transitions:

```typescript
// localStorage key for tracking which user's data is cached
const LAST_USER_KEY = 'lastUserId';

// Current state machine:
// disabled (no Supabase) → no change, app works offline as before
// authenticated → check marker against user.id
// unauthenticated → if marker exists, clear and remove marker
```

**On mount (authenticated):**
1. Read `lastUserId` from localStorage
2. If marker exists and `marker !== user.id` → `clearAllLocalData()` (user switch detected)
3. Set `lastUserId = user.id`
4. Run `backgroundSync()` then `refreshTransactions()`

**On SIGNED_OUT event (via onAuthStateChange):**
1. `clearAllLocalData()`
2. `localStorage.removeItem(LAST_USER_KEY)`
3. `refreshTransactions()` → renders empty state

**On mount (unauthenticated):**
1. Read `lastUserId` from localStorage
2. If marker exists → `clearAllLocalData()`, remove marker, `refreshTransactions()`
3. This handles the case where a user signed out, then refreshed the page

**On mount (disabled):**
1. No auth — app works as today. No cache clearing.

### Why localStorage marker?
Without it, refreshing the page as the same user would trigger a clear + full re-pull on every reload. The marker persists across refreshes and only differs when a different user signs in.

---

## 5. Edge cases

| Case | Behavior |
|---|---|
| **Same user refreshes page** | Marker matches → no wipe. `backgroundSync()` pulls latest data. |
| **User A signs out, User B signs in** | Auth fires SIGNED_OUT → wipe + remove marker. Then auth fires authenticated (B) → marker empty / differs → wipe (already clean), set marker to B, pull B's data. |
| **Offline + cached session** | `getUser()` returns cached user. Normal flow. |
| **Offline + no session** | `getUser()` errors → bail. User sees login page. |
| **Supabase not configured** | `state === 'disabled'` — no auth lifecycle runs. App works offline. |
| **Unsaved changes on sign-out** | Sync queue entries for the old user are discarded (cleared with everything else). Acceptable for 2-user household — unsaved changes are lost on user switch. |
| **First sign-in (fresh install)** | No marker, no local data. `backgroundSync()` pulls their (empty) Supabase data. User starts clean. |
| **First sign-in after migration (existing install)** | DB v8 migration clears old shared cache. No marker. `backgroundSync()` pulls their (empty) Supabase data (TRUNCATE wiped everything). User starts clean. |

---

## 6. What does NOT change

- All existing IDB CRUD functions (`addAccount`, `getAllTransactions`, etc.) — they read/write local cache, no user awareness needed
- `src/types/index.d.ts` — interfaces stay the same (no `userId` field in local types)
- UI components — no changes; data comes from the same hooks/context
- Offline-first — IDB is the source of truth for UI; sync is background
- `src/context/AuthContext.tsx` — stays as-is; TransactionContext consumes it

---

## 7. Rollout order

1. Apply `002_user_isolation.sql` to Supabase (wipes shared data)
2. Deploy updated app code (DB v8 migration clears local caches)
3. Users sign in → each sees their own empty data
4. Import/enter data per user
