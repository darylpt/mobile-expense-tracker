// ============================================================
// DividendLog.test.tsx — Tests for DividendLog component
// ============================================================

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DividendLog } from './DividendLog';
import type { Dividend, Stock } from '@/types';

const mockStock: Stock = {
  id: 's1', ticker: 'BDO', name: 'BDO Unibank', currentPrice: 150, priceUpdatedAt: null, sortOrder: 0, createdAt: 1, updatedAt: 1,
};

function makeDiv(overrides: Partial<Dividend> = {}): Dividend {
  return {
    id: 'd1', stockId: 's1', exDate: '2026-06-15', payDate: '2026-06-20',
    type: 'cash', qty: 1000, rate: 2.5, amount: 2500, fee: 250, dividendYield: 5.0,
    notes: null, sharesReceived: null, createdAt: 1, updatedAt: 1,
    ...overrides,
  };
}

// ----------------------------------------------------------
// Basics
// ----------------------------------------------------------

describe('DividendLog', () => {
  test('renders empty state when no dividends', () => {
    render(
      <DividendLog
        dividends={[]}
        stocks={[mockStock]}
        onDelete={jest.fn()}
        onUpdate={jest.fn()}
      />,
    );

    expect(screen.getByText('No dividends recorded yet.')).toBeTruthy();
  });

  test('renders table headers with all columns', () => {
    render(
      <DividendLog
        dividends={[makeDiv()]}
        stocks={[mockStock]}
        onDelete={jest.fn()}
        onUpdate={jest.fn()}
      />,
    );

    expect(screen.getByRole('columnheader', { name: 'Stock' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Qty' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Rate' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Yield' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Ex-Date' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Pay Date' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Gross' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Fee' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Net' })).toBeTruthy();
  });

// ----------------------------------------------------------
// Computations
// ----------------------------------------------------------

  test('computes gross as qty × rate', () => {
    render(
      <DividendLog
        dividends={[makeDiv({ qty: 1000, rate: 2.5 })]}
        stocks={[mockStock]}
        onDelete={jest.fn()}
        onUpdate={jest.fn()}
      />,
    );
    // gross = 1000 × 2.5 = 2500 → formatCurrency(2500) → ₱2,500.00
    const matches = screen.getAllByText('₱2,500.00');
    expect(matches.length).toBeGreaterThan(0);
  });

  test('computes net as gross − fee', () => {
    render(
      <DividendLog
        dividends={[makeDiv({ qty: 1000, rate: 2.5, fee: 250 })]}
        stocks={[mockStock]}
        onDelete={jest.fn()}
        onUpdate={jest.fn()}
      />,
    );
    // gross = 2500, net = 2500 - 250 = 2250 → ₱2,250.00
    const matches = screen.getAllByText('₱2,250.00');
    expect(matches.length).toBeGreaterThan(0);
  });

  test('falls back to amount for legacy records (qty=0)', () => {
    render(
      <DividendLog
        dividends={[makeDiv({ qty: 0, rate: 0, amount: 500, fee: 0 })]}
        stocks={[mockStock]}
        onDelete={jest.fn()}
        onUpdate={jest.fn()}
      />,
    );
    // Gross falls back to amount = 500 → ₱500.00
    const amountMatches = screen.getAllByText('₱500.00');
    expect(amountMatches.length).toBeGreaterThan(0);

    // Qty and Rate columns show '—' (fee=0 also shows '—' in mobile)
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

// ----------------------------------------------------------
// Yield display
// ----------------------------------------------------------

  test('displays dividendYield as percentage', () => {
    render(
      <DividendLog
        dividends={[makeDiv({ dividendYield: 5.0 })]}
        stocks={[mockStock]}
        onDelete={jest.fn()}
        onUpdate={jest.fn()}
      />,
    );

    const matches = screen.getAllByText('5.00%');
    expect(matches.length).toBeGreaterThan(0);
  });

  test('shows — for null dividendYield', () => {
    render(
      <DividendLog
        dividends={[makeDiv({ dividendYield: null })]}
        stocks={[mockStock]}
        onDelete={jest.fn()}
        onUpdate={jest.fn()}
      />,
    );
    // With qty=1000, rate=2.5, fee=250, the only '—' is from the yield cell
    expect(screen.getByText('—')).toBeTruthy();
  });

// ----------------------------------------------------------
// Interactions
// ----------------------------------------------------------

  test('calls onDelete when delete button clicked', () => {
    const onDelete = jest.fn();
    render(
      <DividendLog
        dividends={[makeDiv()]}
        stocks={[mockStock]}
        onDelete={onDelete}
        onUpdate={jest.fn()}
      />,
    );

    const deleteBtns = screen.getAllByRole('button', { name: 'Delete dividend record' });
    fireEvent.click(deleteBtns[0]);
    expect(onDelete).toHaveBeenCalledWith('d1');
  });

  test('enters edit mode and saves with recomputed amount', async () => {
    const onUpdate = jest.fn().mockResolvedValue(undefined);
    render(
      <DividendLog
        dividends={[makeDiv()]}
        stocks={[mockStock]}
        onDelete={jest.fn()}
        onUpdate={onUpdate}
      />,
    );

    // Enter edit mode (both desktop and mobile have this button; click the first)
    const editBtns = screen.getAllByRole('button', { name: 'Edit dividend record' });
    fireEvent.click(editBtns[0]);

    // Modify qty and rate (desktop inputs, unique via aria-label)
    const qtyInput = screen.getByLabelText('Qty');
    const rateInput = screen.getByLabelText('Rate');
    fireEvent.change(qtyInput, { target: { value: '2000' } });
    fireEvent.change(rateInput, { target: { value: '3' } });

    // Click Save (both desktop and mobile Save buttons exist; click any)
    const saveButtons = screen.getAllByRole('button', { name: 'Save' });
    fireEvent.click(saveButtons[0]);

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledTimes(1);
    });

    expect(onUpdate).toHaveBeenCalledWith(
      'd1',
      expect.objectContaining({
        qty: 2000,
        rate: 3,
        amount: 6000,
      }),
    );
  });

// ----------------------------------------------------------
// Type badge
// ----------------------------------------------------------

  test('renders stock type badge', () => {
    render(
      <DividendLog
        dividends={[makeDiv({ type: 'stock' })]}
        stocks={[mockStock]}
        onDelete={jest.fn()}
        onUpdate={jest.fn()}
      />,
    );

    // "Stock" badge appears (once in desktop table, once in mobile card)
    const stockBadges = screen.getAllByText('Stock');
    expect(stockBadges.length).toBeGreaterThan(0);

    // "Cash" badge must not appear
    expect(screen.queryByText('Cash')).toBeNull();
  });
});
