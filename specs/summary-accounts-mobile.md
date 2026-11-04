# Spec: Mobile Accounts Summary

**Status:** ✅ Done (v0.19.1)
**Scope:** Render the existing per-account balance summary on the Summary route below the `md` breakpoint. Layout and visibility only. No data model, schema, aggregation, or sync changes.

---

## 1. Purpose

The Summary route (`/`) is where a phone user lands after adding transactions. Before v0.19.1 the accounts summary was wrapped in `hidden md:block`, so at widths below 768px the route showed month navigation, four metric cards, and the grouped `CategoryBreakdown`, but no per-account starting balance, inflow, outflow, or ending balance.

`CategoryBreakdown` is not a substitute. Its Account tab lists `totalIncome`, `totalExpenses`, and `netFlow` for the selected month. It never shows starting or ending balances, and it cannot answer what each account holds now. The Summary screen therefore lacked an accounts summary on the platform it is used on most.

Commit `a3851de` introduced the `hidden md:block` wrapper while restructuring the summary layout. This spec records the correction and the data contract behind it.

---

## 2. Data model

The summary renders `AccountBalanceRow[]`, produced by `calculateAccountBalances(transactions, allTransactions, accounts, monthYear)` in `src/lib/aggregations.ts` and exposed by `useTransactions().accountBalances`.

| Field | Type | Meaning |
|---|---|---|
| `accountId` | `string` | Account id, the sentinel `'TOTAL'`, or `'_orphaned'` for the deleted-accounts row |
| `accountName` | `string` | Account display name, `'TOTAL'`, or `'Deleted accounts'` |
| `startingBalance` | `number` | `account.startingBalance` plus net flow from every transaction dated before the first day of the selected month |
| `inflow` | `number` | Money into the account during the selected month |
| `outflow` | `number` | Money out of the account during the selected month |
| `endingBalance` | `number` | `startingBalance + inflow - outflow` |

The array holds one row per configured account in `sortOrder`. When transactions reference account ids that no longer exist, a `_orphaned` row named `Deleted accounts` follows the account rows so their flows still reach the totals. A trailing `'TOTAL'` row always closes the array. `AccountsTable` splits the `TOTAL` row out of `dataRows` and renders it as a footer; the orphan row renders as a normal data row. Accounts with no activity still appear, with zero inflow and outflow and an ending balance equal to the starting balance. Transfers appear as outflow on the source row and inflow on the destination row.

---

## 3. Implementation

`src/components/summary/MonthlySummaryCard.tsx` renders `AccountsTable` directly. The previous wrapper `<div className="hidden md:block">` is gone. Everything else is unchanged:

- `AccountsTable` stays a table inside `SectionCard` (`title="Accounts"`).
- The table keeps its `overflow-x-auto` container, so narrow viewports scroll the five columns inside the card instead of widening the page.
- Five columns on every viewport: Account, Starting Balance, Inflow, Outflow, Ending Balance.
- The `TOTAL` footer row, color coding for inflow and outflow, and `hideAmounts` masking are untouched.
- The desktop-only Income and Expenses breakdown wrappers are untouched.
- `LoadingSkeleton` already renders the accounts card placeholder at all widths, so it matches the loaded layout without changes.

### Key decisions

| Decision | Reason |
|---|---|
| Reuse `AccountsTable` instead of building a mobile card list | One render path and one data source. A second representation would need its own tests and would drift from the desktop table's balance semantics. |
| Remove the breakpoint instead of adding a mobile-only variant | The table answers the same question at every width. Hiding it was the only difference between the two experiences. |
| Keep `overflow-x-auto` rather than restyling cells for phones | The existing container already prevents page-level horizontal scroll. Restyling five columns into a phone width would require dropping or abbreviating a column, which loses the starting and ending balances the summary exists to show. |
| Leave `CategoryBreakdown` on mobile | It remains the only grouped income/expense view with progress bars on phones. The accounts summary answers a different question and sits above it. |

### Mobile scroll limit

At a 375px viewport the card's inner width is about 311px once page and card padding are removed, which is narrower than the five-column table's minimum content width. The table scrolls horizontally inside its card; Ending Balance sits behind a short swipe. This is the accepted tradeoff for keeping all five values. If swipe friction shows up in use, the replacement is a stacked card per account row, which is how Settings and the transaction list already handle tables on phones.

---

## 4. Acceptance criteria

- At widths below 768px, `/` renders the `Accounts` section with one row per account plus the `TOTAL` footer.
- At 768px and above, the Summary route renders exactly what it rendered before this change.
- Every account row exposes starting balance, inflow, outflow, and ending balance at every breakpoint.
- The route scrolls vertically only. Horizontal overflow stays inside the accounts table container.
- An account with no transactions in the selected month still appears with its starting balance as its ending balance.
- `hideAmounts` masks every numeric cell in the accounts table, on every breakpoint.
- The `No data yet` empty state still replaces the whole summary when the datastore holds no transactions.

---

## 5. File map

| File | Role |
|---|---|
| `src/components/summary/MonthlySummaryCard.tsx` | Renders `AccountsTable` without the `hidden md:block` wrapper. Owns the `AccountRow` shape and the `TOTAL` footer split. |
| `src/lib/aggregations.ts` | Produces `AccountBalanceRow[]` via `calculateAccountBalances`. Unchanged. |
| `src/hooks/useTransactions.ts` | Exposes `accountBalances` for the selected month. Unchanged. |
| `src/components/summary/CategoryBreakdown.tsx` | Mobile grouped category and account flow view. Unchanged. |
| `src/app/page.tsx` | Composes `MonthlySummaryCard` and the mobile-only `CategoryBreakdown`. Unchanged. |
| `e2e/quick-add-summary.spec.ts` | `Mobile accounts summary` runs at mobile width only. It asserts the visible `Accounts` section, the Cash row with five cells, and starting 500, inflow 0, outflow 0, ending 500 from the default seed against the current-month summary. |
