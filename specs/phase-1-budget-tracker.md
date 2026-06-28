# Spec: Budget Tracker Feature Parity

**Source of truth:** Google Sheets budget tracker (screenshots reviewed June 2026)
**Status:** All Phase 1 tasks implemented ✓

---

## Implementation status

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Data model migration | ✓ | Transaction renamed to `income│expense│transaction`, `fromAccount`/`toAccount` fields, migration v2→3 |
| 2 | Reference data seed | ✓ | 8 accounts, 21 categories, 21 demo seed transactions |
| 3 | Summary screen | ✓ | Month nav, Accounts/Income/Expenses tables, in-memory budget targets |
| 4 | Available Balance screen | ✓ | Reconciliation table + Cash denomination input with toggle |
| 5 | Payout screen | ✓ | Standalone calculator, save to IndexedDB, no ledger writes |
| 6 | Budget targets input | ✓ | Inline editor below Expenses Breakdown table, in-memory storage |
| 7 | Settings CRUD | ✓ | `/settings` page: add/edit/delete accounts and categories, delete-blocked-if-in-use checks |
| 8 | Context sync fix | ✓ | Settings changes now reflected on Summary page (TransactionContext refresh) |
| 9 | Show all accounts | ✓ | Zero-balance accounts no longer hidden from dashboard |

**Routes:** `/` (Summary), `/available-balance`, `/payout`, `/settings`

---

## 1. Why this spec exists

The current PWA's seeded demo feature set is simpler than the user's real Google Sheets workflow. This spec captures the actual sheet structure/behavior observed and translates it into PWA features, so the Architect can break it into tasks for Coder (implementation) and Critic (review) without re-deriving requirements from scratch.

---

## 2. Reference data model (from "References" sheet)

These are enumerations the Sheets version hardcodes via dropdown source ranges. They are now seed data in IndexedDB and **editable via the Settings page**.

- **Accounts:** GoTyme, GoTyme(Sona), Cash, Landbank, Seabank, Gcash, BPI BanKo, DragonFi
- **Transaction Type:** Income, Expense, Transaction (internal transfer)
- **Income categories:** Paycheck, Bonus, Interest, Cashback, Dividends, Other, Adjustments
- **Expense categories:** Food, Home, Personal, Health, Transportation, Savings, Investment, Motor - Gas, Motor - Maintenance, Other, Adjustments
- **Transaction (transfer) sub-types:** Savings Transfer, Cash In, Cash Out, Carry Over

Note: "Investment" appears as both an **expense category** (money moving toward Phase 2's investment accounts) and a feature area we're deferring — only the category/account plumbing matters in Phase 1, not portfolio math.

---

## 3. Core data model (implemented)

### 3.1 `Transaction` record
| Field | Type | Notes |
|---|---|---|
| id | string (uuid) | ✓ |
| date | ISO date | ✓ |
| amount | number (decimal-safe) | ✓ |
| description | string | ✓ |
| type | `'income' \| 'expense' \| 'transaction'` | ✓ renamed from legacy 'Transfer' |
| category | string | ✓ references income/expense/transfer list |
| fromAccount | string \| null | ✓ account id; null for pure income |
| toAccount | string \| null | ✓ account id; null for pure expense |
| createdAt, updatedAt | number | ✓ timestamps |

Validation rules (enforced in QuickAddForm):
- `type = income` → `toAccount` required, `fromAccount` null, `category` from income list
- `type = expense` → `fromAccount` required, `toAccount` optional (set for Savings/Investment categories)
- `type = transaction` → both `fromAccount` and `toAccount` required, must differ

### 3.2 `Account` record
| Field | Type | Notes |
|---|---|---|
| id | string | ✓ |
| name | string | ✓ editable via Settings |
| startingBalance | number | ✓ editable via Settings |

### 3.3 `CashDenomination` snapshot (Available Balance screen)
| Field | Type | Notes |
|---|---|---|
| id | string | ✓ |
| date | ISO date | ✓ "Date Check" in sheet |
| denomination | number | ✓ bill/coin value |
| count | number | ✓ how many on hand |

Computation: Cash Current = `sum(denomination × count)`

### 3.4 `Payout` record
| Field | Type | Notes |
|---|---|---|
| id | string | ✓ |
| date | ISO date | ✓ |
| totalAmount | number | ✓ |
| splitMode | `'amount' \| 'percentage'` | ✓ |
| splits | `{ person: string, value: number }[]` | ✓ |
| savingsSubSplit | `{ emergencyPct, wantsPct, investmentPct, motorPct }` | ✓ defaults 50/15/20/15 |

---

## 4. Screen: Summary / Dashboard (`/`)

Mirrors the "Summary" sheet tab. **Implemented ✓**

**Controls:** Month + Year navigation (previous/next month buttons).

**Top row (computed, read-only):**
- Total Income (sum of income transactions in period)
- Total Expenses (sum of expense transactions in period)
- Net Savings = Total Income − Total Expenses
- Entry/transfer counts

**Accounts table:** per account — Starting Balance, Inflow, Outflow, Ending Balance, plus TOTAL row. All accounts shown (including zero-balance). Starting Balance = account's `startingBalance` + net flow from prior periods.

**Income breakdown table:** per income category — Amount, % of Total. Only categories with activity shown.

**Expenses breakdown table:** per expense category — Planned (budget target, editable inline), Amount (actual), Difference, % of Total. Only categories with activity shown. "Edit Budgets" button toggles inline editor.

---

## 5. Screen: Available Balance (`/available-balance`)

Mirrors the "Available Balance" sheet tab. **Implemented ✓**

**Controls:** Date Check (defaults to today).

**Table:** per account — Expected (computed running balance), Current (manually entered, except Cash), Difference.

**Cash account special case:** "Current" auto-computed from cash denomination breakdown. Toggle button to switch between denomination input grid and plain number input.

---

## 6. Screen: Payout (`/payout`)

Mirrors the "Payout" sheet tab. **Implemented ✓**

Standalone calculator (no transaction writes).

**Inputs:**
- Total amount
- Split mode toggle: By Percentage / By Amount
- 5 default person rows (Savings, Gy, John, Sona, Daryl) — names and values editable, rows removable, "Add Person" button

**Savings sub-split:** collapsible section below the "Savings" row, 4 inputs (Emergency 50%, Wants 15%, Investment 20%, Motor 15%), live ₱ computed amounts.

**Validation:** amber warning if percentages ≠ 100% or amounts ≠ total.

**Output:** per-person ₱ amounts table, Savings expanded into 4 sub-rows. "Save" persists to IndexedDB via `addPayout`.

---

## 7. Screen: Settings (`/settings`)

**Implemented beyond original spec — added per user request.**

Two sections:

**Accounts:** table with Name, Starting Balance, Actions. Add/edit inline. Delete blocked with amber warning if transactions reference the account.

**Categories:** grouped by type (Expense, Income, Transfer). Same inline add/edit/delete. Delete blocked if any transaction uses the category.

---

## 8. Open questions (resolved)

| Question | Resolution |
|---|---|
| Should Payout post transactions? | No — calculator only (Phase 1). Flagged to user. |
| Are Planned budget targets wanted? | Yes — inline editor added below Expenses table. |
| Should person names be editable? | Yes — all names are editable text inputs. |
| Should zero-balance accounts be hidden? | No — all accounts shown; user deletes unwanted ones via Settings. |
| Should accounts/categories be editable? | Yes — Settings page with full CRUD added. |

---

## 9. Deferred to Phase 2 (not started)

- Stock Portfolio Tracker (ticker, shares, cost basis, market value, unrealized G/L)
- Dividend Log (per-ticker dividend events, withholding tax, reinvestment flag)
- DCA Rotation Log (recurring buy schedule/log)

Note: the "Investment" expense category and `toAccount` flows in Phase 1's data model already provide the bridge — money leaving Cash/bank accounts into "DragonFi" account, categorized "Investment" — so Phase 2 can key off existing transactions rather than needing a parallel re-entry system.

## 10. Possible Phase 1.5 items (not started, not deferred)

- **Budget target persistence** — currently in-memory (resets on reload). Could save to IndexedDB.
- **Transaction editing** — currently add/delete only, no edit UI.
- **Income/Expense breakdowns showing all categories** — currently only show categories with activity.
- **Subcategory support** — spec mentions subcategories; not implemented.
- **Payout → Transaction auto-creation** — explicitly deferred to Phase 2.
- **Responsive desktop layout** — see responsive-layout-spec.md
