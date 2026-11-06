# Quick Add — Sticky Defaults

**Status:** ✅ Implemented

A small UX optimization for the Quick Add form: after submitting a transaction, the type/category/account/description fields persist instead of resetting to defaults.

---

## What It Does

After adding a transaction via Quick Add:

- **Clears:** `amount` field only
- **Stays the same:** `type`, `category`, `fromAccount`, `toAccount`, `description`

This means for repetitive entries (e.g. daily coffee), the user only types the amount and hits Enter.

## Why This Design

Three options were considered:

| Option | Pros | Cons |
|--------|------|------|
| **1. "Copy Last" link** | One extra tap, explicit | Only covers one previous entry |
| **2. Recent chips** | Most visual, flexible | Takes space on mobile, more code |
| **3. Sticky defaults (chosen)** | Zero UI, ~3 lines changed | No visibility into what's sticky |

**Chosen: Option 3** — covers 90% of the use case (daily recurring transaction) with minimal code. Chips can be added on top later if needed.

## Implementation

In `QuickAddForm.tsx`, after successful `addTransaction()`:

```typescript
setForm((prev) => ({
  ...initialFormState,
  type: prev.type,
  category: prev.category,
  fromAccount: prev.fromAccount,
  toAccount: prev.toAccount,
  description: prev.description,
}));
```

The form also auto-collapses on mobile after submit.

## Mobile disclosure

On mobile (`<768px`) the form is a disclosure:

- Closed: only the disclosure button is reachable. It reports `aria-expanded="false"`, points at the panel with `aria-controls="quick-add-panel"`, and the panel carries `inert`, so its fields are out of the tab order and the accessibility tree.
- Open: `aria-expanded="true"`, `inert` is removed, and the form controls are usable.
- Submit success: the panel collapses and focus moves to the disclosure instead of remaining inside the now-hidden panel.

Desktop keeps the static `+ Add Transaction` heading and an always-expanded form. The mobile height transition is unchanged. See [`ui-accessibility-onboarding.md`](ui-accessibility-onboarding.md) for the full contract and regression coverage.

## Files

| File | Role |
|------|------|
| `src/components/forms/QuickAddForm.tsx` | Sticky defaults on form reset after submit; mobile disclosure semantics and focus return |
| `e2e/quick-add-summary.spec.ts` | Sticky-default sync flows plus mobile disclosure regression |
