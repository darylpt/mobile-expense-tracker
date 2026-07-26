# Balance Sub-Splits

**Status:** ✅ Implemented (2026-07-22)

A feature on the Available Balance page that lets users break a single "Current" balance into labeled sub-amounts.

---

## What It Does

On the `/available-balance` page, each account row has a **sub-split toggle** (layers icon). When enabled, the single "Current" number input is replaced by:

1. A read-only computed total (sum of all sub-splits)
2. A dynamic list of label + amount rows

The user can add/remove sub-split rows. Each row has a label (text) and an amount (₱). The Current value is always the sum of all sub-split amounts — users cannot type a total directly while sub-split mode is active.

## Why It Exists

Some accounts have internal structure that a single number doesn't capture. Examples:
- **Cash**: physical bills separated by envelope/envelope category
- **Savings**: allocated across Emergency / Wants / Investment / Motor buckets
- **Checking**: earmarked amounts for specific upcoming bills

Sub-splits let users see and reconcile at a more granular level without creating separate sub-accounts.

## Data Model

```typescript
// On BalanceSnapshot:
interface BalanceSnapshot {
  // ...
  useSubSplit?: boolean;
  subSplits?: {
    id: string;       // uuid
    label: string;    // user-defined category name
    amount: number;   // ₱ amount
  }[];
}
```

## State Flow

1. **Toggle ON:** Initializes 3 empty sub-split rows, sets `useSubSplit = true`, `value = 0`
2. **Edit:** User fills label + amount per row. `value` recomputes as sum of all amounts on every change.
3. **Add row:** Appends empty row (label: '', amount: 0).
4. **Remove row:** Filters out row by id. Recomputes sum.
5. **Toggle OFF:** Strips `useSubSplit` and `subSplits` fields, keeps the last computed value as the plain `value`.

## Sync

Sub-splits are stored in the `balanceSnapshots` IndexedDB store, which syncs to Supabase. This means sub-split configurations and values are available across all devices.

## IDB Migration

**DB v13** — Migrated `balanceSnapshots` store to accept the new `useSubSplit` and `subSplits` fields. Legacy records (without these fields) continue to work as plain number entries.

## UI

### Layers Icon (toggle button)

- **Off state:** Grey layers icon, click to enable
- **On state:** Blue highlighted layers icon, click to disable

### Sub-Split Editor

Inline below the Current field. Rows are:
```
[label input] [₱ amount input] [× remove button]
+ Add sub-split link at bottom
```

Desktop and mobile both use the same `SubSplitEditor` component.

## Files

| File | Role |
|------|------|
| `src/app/available-balance/page.tsx` | State management, toggle handlers, SubSplitEditor component |
| `src/types/index.d.ts` | `BalanceSnapshot.subSplits` field |
| `src/lib/idb.ts` | DB v13 migration, `upsertBalanceSnapshot()` |
| `src/lib/constants.ts` | `DB_VERSION = 13` |
