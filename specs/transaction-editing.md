# Spec: Transaction Editing

**Status:** Ready for Coder
**Scope:** Add edit capability to existing transactions. Delete already exists in `TransactionList.tsx` — this spec adds edit only.

---

## 1. Why this exists

Transactions can be added via Quick Add and deleted from the transaction list, but there is no way to edit an existing transaction. Users who make a typo (wrong amount, category, account) must delete and re-enter the transaction instead of fixing it in place.

## 2. UX design

### 2.1 Entry point

Add an "Edit" button (pencil icon) next to the existing "Delete" (trash icon) in each transaction row in `TransactionList.tsx`.

### 2.2 Edit modal

Clicking "Edit" opens a centered modal overlay containing the same form fields as QuickAddForm (Amount, Date, Type, Category, From Account, To Account, Description), pre-populated with the transaction's current values.

**Modal behavior:**
- Close via X button, Cancel button, or Escape key
- Click outside the modal to close
- Focus trap while open (Tab cycles within modal)
- On close, focus returns to the Edit button that triggered it
- On save, modal closes and transaction list updates via existing `TransactionContext.updateTransaction`

### 2.3 Form reuse

The edit form should share field rendering logic with QuickAddForm — extract a shared `TransactionFormFields` component rather than duplicating the grid.

## 3. Implementation plan

### 3.1 Shared form fields component

Extract from `QuickAddForm.tsx` into `src/components/forms/TransactionFormFields.tsx`:

```typescript
interface TransactionFormFieldsProps {
  form: {
    amount: string;
    date: string;
    type: TransactionType;
    category: string;
    fromAccount: string;
    toAccount: string;
    description: string;
  };
  onFieldChange: <K extends keyof FormState>(field: K, value: FormState[K]) => void;
  error: string | null;
}
```

Returns the same grid of Input/Dropdown fields as QuickAddForm (lines 192–268 of QuickAddForm), minus the submit button and header.

### 3.2 Update QuickAddForm

Import and use `TransactionFormFields` instead of rendering the grid inline. Keep the form state, validation, submit logic, and header in QuickAddForm — only the field rendering is extracted.

### 3.3 Edit modal component

New file: `src/components/forms/EditTransactionModal.tsx`

- Receives `transaction: Transaction | null` (null = closed)
- When a transaction is provided, initializes form state from it
- On save: calls `ctx.updateTransaction(updatedTx)` then closes
- On cancel/close: resets to null
- Portal-based overlay with backdrop
- aria-modal, role="dialog", aria-labelledby
- Focus trap (use `useEffect` + ref to trap Tab)
- Closes on Escape key

### 3.4 Update TransactionList

- Import and render `EditTransactionModal`
- Add `editingTx` state: `Transaction | null`
- Add "Edit" button (pencil icon SVG, same as delete pattern) next to existing delete button
- onClick sets `editingTx` to the transaction
- Pass `editingTx` to the modal; on close set back to null

## 4. Files to modify

| File | Change |
|---|---|
| `src/components/forms/QuickAddForm.tsx` | Extract field grid to `TransactionFormFields`, import and use it |
| `src/components/forms/TransactionFormFields.tsx` | **New** — shared field grid |
| `src/components/forms/EditTransactionModal.tsx` | **New** — modal wrapper with form |
| `src/components/summary/TransactionList.tsx` | Add Edit button + modal |

## 5. Accessibility requirements

- Modal has `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing to the heading
- Focus trapped inside modal while open
- Escape key closes modal
- Close button has `aria-label="Close"` (X icon) or text "Cancel"
- Focus returns to the triggering Edit button on close
- Form fields inherit existing labels from `TransactionFormFields`

## 6. Validation

Same validation rules as QuickAddForm:
- Amount must be positive number
- Date required
- Category required
- From/To accounts required per transaction type rules
- Transfer must have different From and To accounts

## 7. Test considerations

- Modal opens/closes correctly
- Pre-populated fields match the transaction data
- Save updates the transaction and closes
- Cancel closes without saving
- Escape key closes
- Focus trap works (Tab stays within modal)
- No regression to QuickAddForm

## 8. Non-goals

- No batch editing
- No drag-to-reorder transactions
- No undo after save (user can edit again)
