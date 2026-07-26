# Payout Calculator

**Status:** ✅ Implemented

A standalone calculator for splitting a total payout amount across people or categories.

---

## Route

`/payout`

## Purpose

Provides a quick calculator for splitting a lump-sum payout (e.g. salary, freelance income) into designated shares. Savings has a sub-split into Emergency/Wants/Investment/Motor. The result is saved to IndexedDB for record-keeping but **does not** create ledger transactions.

## How It Works

### Inputs

| Field | Description |
|-------|-------------|
| **Total Amount** | Gross payout amount (₱) |
| **Split Mode** | `By Percentage` or `By Amount` |
| **Person Rows** | Each person gets a name + percentage or amount. Default names: Savings, Gy, John, Sona, Daryl |

### Validation

- Total amount must be > 0
- In percentage mode, all rows must sum to ~100%
- In amount mode, all amounts must sum to ~total amount
- Sub-split percentages must sum to ~100% per person

### Output

Read-only table showing each person's calculated amount. If a person has sub-split enabled, their amount is further broken down into Emergency/Wants/Investment/Motor.

### Save

Saves to IndexedDB `payouts` store. Shows "✓ Saved!" confirmation for 3 seconds.

## Data Model

**Store:** `payouts`

```typescript
interface Payout {
  id: string;
  date: string;          // ISO date
  totalAmount: number;
  splitMode: 'amount' | 'percentage';
  splits: { person: string; value: number }[];
  savingsSubSplit?: {
    emergencyPct: number;   // default 50
    wantsPct: number;       // default 15
    investmentPct: number;  // default 20
    motorPct: number;       // default 15
  };
}
```

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **No ledger writes** | Payout calculator is a planning tool. Creating actual income/expense records from it would require user review. Phase 1 scope. User confirmed. |
| **Savings sub-split hardcoded** | 4 categories (Emergency 50%, Wants 15%, Investment 20%, Motor 15%) based on user's existing budget system. Per-person independent percentages via later refactor. |
| **Saves one canonical sub-split** | When saving, only the first person with sub-split enabled is saved as `savingsSubSplit`. Simplifies the data model — sufficient for single-person savings tracking. |

## E2E Tests

`e2e/payout-calculator.spec.ts` covers:
- Adding/removing people
- Percentage vs amount mode switching
- Validation warnings
- Save flow

## Files

| File | Role |
|------|------|
| `src/app/payout/page.tsx` | Full route — input form, output table, validation, save |
| `src/types/index.d.ts` | `Payout`, `PayoutSplit` interfaces |
| `src/lib/idb.ts` | `addPayout()` |
