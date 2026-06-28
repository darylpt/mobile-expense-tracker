# Spec: Budget Target Persistence

**For:** Architect agent → delegate to Coder / Critic
**Status:** Decision confirmed (hybrid). Ready to hand off to Coder.
**Scope:** Persist the existing "Planned" budget target values (currently in-memory, lost on reload) to IndexedDB. No new UI, no new screen — the inline editor on the Summary page's Expenses Breakdown table already exists and works; only the storage layer changes.

---

## 1. Why this spec exists

Per-category monthly budget targets ("Planned" column on the Expenses Breakdown table) are currently held in component/React state only. Refreshing the page or reopening the app loses every value the user entered. This is a data-loss bug from the user's perspective, not a missing feature — the input UI already exists and is used; it just doesn't survive a reload.

---

## 2. Data model addition

### 2.1 `BudgetTarget` record (new IndexedDB store)

| Field | Type | Notes |
|---|---|---|
| id | string (uuid) | |
| category | string | references an Expense category from the existing category list |
| month | string \| null | `"2026-06"` format. `null` = global default (applies to every month unless overridden). Non-null = per-month override. |
| amount | number | the "Planned" value |
| createdAt, updatedAt | number | timestamps, matching the convention already used on `Transaction` |

**Decision (confirmed with user, 2026-06-28): Hybrid — global defaults with per-month overrides.**

A category has one global default target (`month = null`) that applies to every month. Individual months can override it with a different amount (`month = "YYYY-MM"`).

**Lookup logic (given category + month):**
1. Look for record where `category = cat AND month = targetMonth`
2. If not found, look for record where `category = cat AND month IS NULL`
3. If neither found, return 0

**Editor behavior:** reads the effective target for the currently viewed month. When user saves a value:
- If an override exists for the current month: update it.
- If no override but a global default exists: update the global default.
- If neither exists: create a global default (`month = null`).

**No per-month entry required unless it differs from global.** The inline editor works as-is since it already scopes to the current month's view.

### 2.2 Migration

This is IndexedDB schema version N → N+1 (Coder should check current version per the existing migration pattern from the Phase 1 `Transaction` type rename, v2→3). New object store `budgetTargets`, keyed by `id`, with indexes on `category` and `month` (to support the hybrid lookup: query by category + month for override, fall back to category + null for global default).

No migration of existing data needed — there is no existing persisted budget target data, since it was in-memory only. This is purely additive: new empty store, no risk to existing `Transaction`/`Account`/`Payout`/`CashDenomination` data.

---

## 3. Behavior changes

- On Summary page load, read all `BudgetTarget` rows once (or via the existing `TransactionContext` pattern used for cross-page sync per Phase 1 task 8 — reuse that pattern rather than introducing a second context).
- Inline editor ("Edit Budgets" toggle) writes directly to the `budgetTargets` store on save, same interaction as today — just swap the state setter for an IndexedDB write + context refresh.
- Expenses Breakdown table's "Planned" column reads from the persisted store instead of local state. Default to 0/blank for any category with no saved target, same as current behavior.
- Settings page is **not** in scope for this task — budget targets stay editable only from the Summary page's existing inline editor. (If the user later wants to manage targets from Settings too, that's a separate follow-up, not part of this.)

---

## 4. File/task breakdown for delegation

Single Coder task:

1. Add `budgetTargets` store to the IndexedDB schema + migration (DB_VERSION bump). Indexes on `category` and `month`.
2. Add data layer functions to `src/lib/idb.ts`:
   - `getBudgetTarget(category, month): Promise<number>` — hybrid lookup (override first, then global, then 0)
   - `setBudgetTarget(category, amount, month?): Promise<void>` — upsert: if month omitted, operates on the global default; if month given and a record exists for that category+month, updates it; otherwise inserts.
   - `getAllBudgetTargets(): Promise<BudgetTarget[]>` — full dump for editor initialization
3. Remove the in-memory `budgetTargets` Map and `getBudgetTarget`/`setBudgetTarget`/`getAllBudgetTargets` functions from `src/lib/aggregations.ts`. Replace `calculateExpenseBreakdown`'s call to `getBudgetTarget(category)` with the IndexedDB-persisted version.
4. Wire the Summary page's inline editor to call the new indexedDB functions via `useTransactionContext` pattern (reuse context refresh for cross-page sync).
5. Jest tests for the new data layer functions, covering: global-only, per-month override, override falls back to global, unknown category returns 0.

Critic review focus:
- Confirm no regression to existing Expenses Breakdown rendering when a category has zero saved target (should still show 0/blank, not throw or show `undefined`).
- Confirm the migration doesn't break on a fresh install (no existing `budgetTargets` data) vs. an existing install (store didn't exist before, must be created cleanly).
- Confirm reload-persistence actually works end-to-end as the core acceptance check — this is the entire point of the task, so an explicit manual or automated check ("set a target, reload, value is still there") should be part of the PASS criteria, not just unit tests on the data functions in isolation.


