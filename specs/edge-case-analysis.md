# Edge-Case Analysis — specs/project-spec.md

> Generated: 2026-07-13 (elaborate phase)
> Source: Unified spec compiled from 12 individual specs

---

## 1. Data Model Gaps

### 1.1 Transaction cross-field validation — INCOMPLETE

The spec defines validation rules for QuickAddForm but doesn't cover:
- **Editing:** EditTransactionModal reuses TransactionFormFields — does it enforce the same rules? (Spec says yes, but not explicit.)
- **CSV import:** Imported transactions bypass form validation entirely. A CSV row with `type=income` + `fromAccount` set + `toAccount` null would pass import but violate the income rule. **Gap:** CSV import doesn't validate against the same business rules as the form.

**Recommendation:** Add explicit statement: "CSV-imported transactions must satisfy the same type/account validation rules as QuickAddForm. Rows that violate them should be logged as import errors, not silently accepted."

### 1.2 BudgetTarget month format — UNVALIDATED

Spec says `month = "YYYY-MM"` or null. No validation that:
- Month is 01-12
- Year is reasonable (e.g., 2020-2030)
- `month = "2026-13"` would be accepted by the set function

**Recommendation:** Add month format validation to `setBudgetTarget`. Reject invalid month strings.

### 1.3 CashDenomination — NO NEGATIVE GUARD

`count` is `INTEGER NOT NULL` but no `CHECK (count >= 0)`. Negative denomination counts are physically impossible but would silently corrupt the cash balance calculation.

**Recommendation:** Add `CHECK (count >= 0)` on the IDB layer (Supabase already has no CHECK on this column either).

### 1.4 Category type vs. usage cross-check — MISSING

A category with `type = 'income'` can be used in an expense transaction via CSV import or direct IDB manipulation. The form prevents this, but nothing else does.

**Impact:** Low for single-user app, but could cause confusing dashboard totals if a category appears in both income and expense breakdowns.

---

## 2. Sync Edge Cases

### 2.1 Stale sync queue entries after migration — PARTIALLY HANDLED

Migration v8 clears all stores including syncQueue. But:
- If a user has pending sync entries and the app updates (new DB_VERSION), the migration clears the queue.
- Old entries that were about to push are silently lost.
- **Gap:** No user notification that pending offline changes were discarded.

**Recommendation:** Acceptable for 2-user household (documented in user-data-isolation.md). But the unified spec should note this explicitly.

### 2.2 resyncAll vs. backgroundSync race — GUARDED

`syncInFlight` guard prevents concurrent cycles. `resyncAll` clears queue then re-enqueues — if called while `syncInFlight` is true, the new entries won't be processed until the current cycle finishes. **No gap.**

### 2.3 Soft-delete + LWW trigger interaction — SUBTLE

When a record is soft-deleted locally:
1. `deleted_at` and `updated_at` are set
2. Sync pushes to Supabase
3. LWW trigger checks `NEW.updated_at > OLD.updated_at` — since `updated_at` was just set to `Date.now()`, this passes
4. Record is upserted with `deleted_at` set

On pull, other devices see `deleted_at` set and purge locally. **Correct behavior.** No gap.

But: what if Device A soft-deletes, then Device B edits the same record before sync? Device B's edit has a newer `updated_at`, so it wins the LWW trigger. The soft-delete is lost. Device A's record reappears on next pull.

**Impact:** Low (rare in 2-user household). But worth documenting as a known limitation.

### 2.4 Sync queue entry for non-existent store after schema change

If a future migration removes a store, orphaned sync entries would reference a non-existent store. The `processSyncQueue` function would try `supabase.from(tableName)` with a table that doesn't exist → error → retry → eventually dropped.

**Impact:** Low. Only relevant if stores are removed in future migrations.

---

## 3. Auth Edge Cases

### 3.1 Magic link in different browser — HANDLED

Session established on click, but local IDB is empty. `backgroundSync()` pulls from Supabase. If Supabase has no data (first sign-in), user sees empty state. **Correct.**

### 3.2 Multiple tabs with different users — PARTIALLY HANDLED

Supabase-js broadcasts auth events across tabs via `broadcastChannel`. But:
- Tab A signs out → Tab B gets `SIGNED_OUT` event → wipes local data
- Tab B signs in as different user → Tab A's IDB now has User B's data (shared origin)
- **Gap:** No `lastUserId` check across tabs. Only checked on mount, not on cross-tab auth events.

**Impact:** Medium. Could cause data contamination if both tabs are actively used. Mitigation: `lastUserId` check on mount catches this on next page load, but not in real-time.

### 3.3 Session expires during long offline period — EDGE CASE

User goes offline for weeks. Session token expires. On reconnection:
1. `backgroundSync()` tries to push → Supabase rejects (no valid session)
2. `pullStore()` fails (no valid session)
3. `onAuthStateChange` fires `SIGNED_OUT`
4. Route guard redirects to `/login`

But: local data remains intact. User re-authenticates, sync resumes. **Correct behavior.**

**Gap:** Sync queue entries accumulated during the offline period are pushed with stale auth → all fail → retry limit hit → entries dropped. User's offline changes are lost silently.

**Recommendation:** On auth failure during sync, warn the user that unsynced changes may be lost.

### 3.4 Sign-out while sync in progress — GUARDED

`syncInFlight` prevents new cycles but doesn't cancel the current one. Sign-out calls `backgroundSync()` first (which is a no-op if already in flight). If sync is mid-network-phase:
- Remaining network calls fail (auth invalidated)
- Write phase deletes successful entries (none, since auth failed)
- Queue entries remain with incremented retryCount

**Acceptable.** Entries will be retried or dropped after max retries.

---

## 4. CSV Import Edge Cases

### 4.1 BOM handling — DOCUMENTED

Spec says "Strip BOM before parsing." Implementation in csv-import.ts handles this. **No gap.**

### 4.2 Empty CSV with valid headers — HANDLED

Spec says: "Empty CSV → Show 'No data found' — do not import." **No gap.**

### 4.3 Negative Carry Over amounts — UNHANDLED

A Carry Over row with `₱-100.00` would set `startingBalance = -100`. This is technically valid (overdraft) but could be unintended.

**Recommendation:** Add a warning in the import preview for negative starting balances, but allow it (user may intentionally track overdrafts).

### 4.4 Carry Over with both From and To accounts — PARTIALLY HANDLED

Spec says: "To Account wins if both are set." But what if `To Account` is empty and `From Account` has a value? The spec says "falls back to From Account." **No gap.**

### 4.5 Same account in both columns of a non-Carry-Over row — UNVALIDATED

A regular transaction row with `From Account = Cash` and `To Account = Cash` violates the "must differ" transfer rule. CSV import doesn't enforce this.

**Recommendation:** Add validation: if both accounts are set and identical, log as import error.

### 4.6 CSV with non-UTF-8 encoding — UNHANDLED

Google Sheets exports as UTF-8 by default, but manual CSV exports from other tools may use different encodings. The parser assumes UTF-8.

**Impact:** Low. Filipino peso symbol (₱) and special characters in descriptions could render as garbage.

---

## 5. UI / Interaction Edge Cases

### 5.1 Quick Add double-submit — FIXED 2026-07-15

Added `if (isSubmitting) return;` guard at top of `handleSubmit` in `QuickAddForm.tsx`. Button already receives `isLoading` prop — the guard is belt-and-suspenders against React state update races.

### 5.2 Edit modal + delete race — UNHANDLED

User opens edit modal for Transaction X, then deletes Transaction X from the list (if modal doesn't block interaction with the background). The modal would try to save to a deleted transaction.

**Impact:** Low. The update would create a new entry or fail gracefully. But worth noting.

### 5.3 Transaction list filter + pagination interaction — ALREADY HANDLED

`TransactionList.tsx` lines 216-223: `useEffect` deletes `page` from URL params when `hasActiveFilters` is true. Filtered view forces `totalPages=1` and shows all results. Clearing filters navigates to `/transactions` (no page param) → pagination resumes at page 1. No code change needed.

### 5.4 Settings with many accounts/categories — PERFORMANCE

No virtualization on the accounts/categories lists. With 50+ entries, the Settings page could become sluggish. Current use case (8 accounts, 21 categories) is fine.

**Impact:** Low for current use. Flag for Phase 2 if data grows.

---

## 6. Payout Edge Cases

### 6.1 Payout with 0 persons — FIXED 2026-07-15

`canSave` now requires `splits.length > 0` in `payout/page.tsx`. Save button is disabled when all person rows are removed.

### 6.2 Negative totalAmount — ALREADY HANDLED

`payout/page.tsx` line 89: `if (totalAmount <= 0)` validation already catches negative and zero amounts. Input has `min={0}` as well. No code change needed.

### 6.3 Savings sub-split percentages ≠ 100% — DOCUMENTED

Spec says "amber warning if percentages ≠ 100%." But the warning is advisory — the user can still save with mismatched percentages. The sub-split amounts would be computed from the incorrect percentages.

**Acceptable.** User explicitly chose to override.

---

## 7. Offline / Storage Edge Cases

### 7.1 IndexedDB quota exceeded during CSV import — UNHANDLED

A large CSV import (thousands of transactions) could hit the browser's IndexedDB quota. The atomic transaction would fail partway through.

**Impact:** Medium. Could leave the app in a partially-imported state if the transaction doesn't roll back cleanly.

**Recommendation:** Check available storage before import (navigator.storage.estimate()). Warn if import size exceeds 80% of quota.

### 7.2 Browser eviction of IndexedDB data — MITIGATED

PWA with proper service worker should prevent eviction. But if the browser needs storage, IDB data could be cleared. Supabase sync provides redundancy.

**Acceptable.** Documented in backup-restore.md.

### 7.3 Multiple backgroundSync calls queued — GUARDED

`syncInFlight` prevents concurrent cycles. `requestSync()` is debounced (2s). Multiple rapid CRUD operations only trigger one sync cycle. **No gap.**

---

## Summary

| Category | Gaps Found | Severity | Action |
|---|---|---|---|
| Data Model | 3 | Low-Medium | Add validation rules to spec |
| Sync | 2 | Low | Document known limitations |
| Auth | 2 | Medium | Add cross-tab guard, auth failure warning |
| CSV Import | 2 | Low | Add account-equal validation, negative balance warning |
| UI | 3 | Low | Double-submit guard, filter+pagination reset |
| Payout | 2 | Low | Empty splits guard, negative amount validation |
| Storage | 1 | Medium | Pre-import quota check |

**Total: 15 findings. 0 critical, 3 medium, 12 low.**

No blockers for current Phase 1 completion. Medium items are candidates for Phase 2 scope or hardening pass.
