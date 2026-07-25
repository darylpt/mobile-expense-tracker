// ============================================================
// DividendForm.test.tsx — Tests for DividendForm component
// ============================================================

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DividendForm } from './DividendForm';

const mockStocks = [
  { id: 's1', ticker: 'BDO', name: 'BDO Unibank', currentPrice: 150, priceUpdatedAt: null, sortOrder: 0, createdAt: 1, updatedAt: 1 },
  { id: 's2', ticker: 'SM', name: 'SM Investments', currentPrice: 900, priceUpdatedAt: null, sortOrder: 1, createdAt: 1, updatedAt: 1 },
];

/** Grab the form <form> element from the rendered tree. */
function getForm(container: HTMLElement): HTMLFormElement {
  const form = container.querySelector('form');
  if (!form) throw new Error('Form element not found');
  return form;
}

/** Grab all form elements by their accessible labels/roles. */
function getFormElements() {
  return {
    stockSelect: screen.getByRole('combobox', { name: /stock/i }) as HTMLSelectElement,
    qtyInput: screen.getByLabelText('Qty (Shares)') as HTMLInputElement,
    rateInput: screen.getByLabelText('Rate per Share') as HTMLInputElement,
    exDateInput: screen.getByLabelText('Ex-Date') as HTMLInputElement,
    payDateInput: screen.getByLabelText('Payment Date') as HTMLInputElement,
    feeInput: screen.getByLabelText('Fee (Tax)') as HTMLInputElement,
    yieldInput: screen.getByLabelText('Yield % (optional)') as HTMLInputElement,
    cashRadio: screen.getByRole('radio', { name: /cash/i }) as HTMLInputElement,
    stockRadio: screen.getByRole('radio', { name: /stock/i }) as HTMLInputElement,
    submitButton: screen.getByRole('button', { name: /add dividend/i }),
  };
}

/** Fill the common required fields (stock, qty, rate, dates). */
function fillRequiredFields(elements: ReturnType<typeof getFormElements>) {
  fireEvent.change(elements.stockSelect, { target: { value: 's1' } });
  fireEvent.change(elements.qtyInput, { target: { value: '1000' } });
  fireEvent.change(elements.rateInput, { target: { value: '2.5' } });
  fireEvent.change(elements.exDateInput, { target: { value: '2026-06-15' } });
  fireEvent.change(elements.payDateInput, { target: { value: '2026-06-20' } });
}

describe('DividendForm', () => {
  // ----------------------------------------------------------
  // Test 1 — renders all required fields
  // ----------------------------------------------------------
  test('renders all required fields', () => {
    render(<DividendForm stocks={mockStocks} onSubmit={jest.fn()} />);

    const els = getFormElements();

    // Every field/button is in the document
    expect(els.stockSelect).toBeTruthy();
    expect(els.qtyInput).toBeTruthy();
    expect(els.rateInput).toBeTruthy();
    expect(els.exDateInput).toBeTruthy();
    expect(els.payDateInput).toBeTruthy();
    expect(els.feeInput).toBeTruthy();
    expect(els.yieldInput).toBeTruthy();
    expect(els.cashRadio).toBeTruthy();
    expect(els.stockRadio).toBeTruthy();
    expect(els.submitButton).toBeTruthy();

    // Stock options rendered
    expect(screen.getByText('BDO — BDO Unibank')).toBeTruthy();
    expect(screen.getByText('SM — SM Investments')).toBeTruthy();
  });

  // ----------------------------------------------------------
  // Test 2 — shares received field only for stock type
  // ----------------------------------------------------------
  test('shows shares received field only for stock type', () => {
    render(<DividendForm stocks={mockStocks} onSubmit={jest.fn()} />);

    // Initially hidden (Cash is default)
    expect(screen.queryByLabelText('Shares Received')).toBeNull();

    // Switch to Stock → appears
    fireEvent.click(screen.getByRole('radio', { name: /stock/i }));
    expect(screen.getByLabelText('Shares Received')).toBeTruthy();

    // Switch back to Cash → hidden
    fireEvent.click(screen.getByRole('radio', { name: /cash/i }));
    expect(screen.queryByLabelText('Shares Received')).toBeNull();
  });

  // ----------------------------------------------------------
  // Test 3 — validation error when stock not selected
  // ----------------------------------------------------------
  test('shows validation error when stock not selected', async () => {
    const { container } = render(<DividendForm stocks={mockStocks} onSubmit={jest.fn()} />);

    // Submit the form directly to bypass HTML5 validation on required fields
    fireEvent.submit(getForm(container));

    expect(await screen.findByText('Please select a stock.')).toBeTruthy();
  });

  // ----------------------------------------------------------
  // Test 4 — calls onSubmit with computed amount = qty × rate
  // ----------------------------------------------------------
  test('calls onSubmit with computed amount = qty × rate', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    render(<DividendForm stocks={mockStocks} onSubmit={onSubmit} />);

    const els = getFormElements();
    fillRequiredFields(els);
    fireEvent.change(els.feeInput, { target: { value: '0' } });

    fireEvent.click(els.submitButton);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    expect(onSubmit).toHaveBeenCalledWith({
      stockId: 's1',
      qty: 1000,
      rate: 2.5,
      amount: 2500,
      fee: 0,
      type: 'cash',
      exDate: '2026-06-15',
      payDate: '2026-06-20',
      dividendYield: null,
      sharesReceived: null,
      notes: null,
    });
  });

  // ----------------------------------------------------------
  // Test 5 — defaults fee to 0 when empty
  // ----------------------------------------------------------
  test('defaults fee to 0 when empty', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    render(<DividendForm stocks={mockStocks} onSubmit={onSubmit} />);

    const els = getFormElements();
    fillRequiredFields(els);
    // Deliberately leave fee empty

    fireEvent.click(els.submitButton);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ fee: 0 }),
    );
  });

  // ----------------------------------------------------------
  // Test 6 — validation error when qty is 0 or negative
  // ----------------------------------------------------------
  test('shows validation error when qty is 0 or negative', async () => {
    const onSubmit = jest.fn();

    // --- qty = 0 (passes HTML5 min="0" but fails our check) ---
    const { container, unmount } = render(
      <DividendForm stocks={mockStocks} onSubmit={onSubmit} />,
    );
    const els = getFormElements();
    fillRequiredFields(els);
    fireEvent.change(els.qtyInput, { target: { value: '0' } });

    fireEvent.submit(getForm(container));

    expect(
      await screen.findByText('Qty must be a positive number.'),
    ).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();

    // --- qty = -5 (fails HTML5 min="0", so submit directly) ---
    const { container: c2 } = render(
      <DividendForm stocks={mockStocks} onSubmit={onSubmit} />,
    );
    const els2 = getFormElements();
    fillRequiredFields(els2);
    fireEvent.change(els2.qtyInput, { target: { value: '-5' } });

    fireEvent.submit(getForm(c2));

    expect(
      await screen.findByText('Qty must be a positive number.'),
    ).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------
  // Test 7 — loading state on submit button
  // ----------------------------------------------------------
  test('shows loading state on submit button', async () => {
    // A promise that never resolves keeps the form in submitting state
    const onSubmit = jest.fn(
      () => new Promise<void>(() => {
        /* never resolves */
      }),
    );
    render(<DividendForm stocks={mockStocks} onSubmit={onSubmit} />);

    const els = getFormElements();
    fillRequiredFields(els);

    fireEvent.click(els.submitButton);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /adding/i }),
      ).toBeTruthy();
    });

    const loadingBtn = screen.getByRole('button', { name: /adding/i });
    expect((loadingBtn as HTMLButtonElement).disabled).toBe(true);
  });
});
