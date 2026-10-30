import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { TransactionList } from './TransactionList';
import { getCurrentMonthYear } from '@/lib/utils';
import type { Transaction } from '@/types';

const mockUseTransactionContext = jest.fn();
const mockReplace = jest.fn();
let mockSearchParams = new URLSearchParams();

beforeEach(() => {
  mockSearchParams = new URLSearchParams();
  mockReplace.mockClear();
  mockUseTransactionContext.mockReset();
});

jest.mock('@/context/TransactionContext', () => ({
  useTransactionContext: () => mockUseTransactionContext(),
  formatAmount: (amount: number) => `₱${amount.toFixed(2)}`,
}));

jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock('@/hooks/useTransactions', () => ({
  useTransactions: () => ({ addTransaction: jest.fn(), updateTransaction: jest.fn() }),
}));

jest.mock('@/hooks/useCategories', () => ({
  useCategories: () => ({ categories: [] }),
}));

jest.mock('@/hooks/useAccounts', () => ({
  useAccounts: () => ({ accounts: [] }),
}));

function currentMonthDate(day: number): string {
  const { year, month } = getCurrentMonthYear();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function makeTransactions(count: number): Transaction[] {
  return Array.from({ length: count }, (_, i): Transaction => ({
    id: `tx-${i}`,
    amount: 10 + i,
    date: currentMonthDate(15),
    type: 'expense',
    category: 'Food',
    fromAccount: 'acc-1',
    toAccount: null,
    description: `Row ${i}`,
    createdAt: i,
    updatedAt: i,
  }));
}

function contextValue(transactions: Transaction[]) {
  return {
    transactions,
    accounts: [{ id: 'acc-1', name: 'Cash', startingBalance: 0, createdAt: 0, updatedAt: 0 }],
    categories: [],
    isLoading: false,
    error: null,
    monthYear: getCurrentMonthYear(),
    setMonthYear: jest.fn(),
    addTransaction: jest.fn(),
    updateTransaction: jest.fn(),
    deleteTransaction: jest.fn(),
    refreshTransactions: jest.fn(),
    hideAmounts: false,
    toggleHideAmounts: jest.fn(),
  };
}

describe('TransactionList Add controls', () => {
  test('opening and closing both Add controls does not re-invoke useTransactionContext', () => {
    mockUseTransactionContext.mockReturnValue(contextValue(makeTransactions(50)));
    render(<TransactionList />);

    expect(screen.getByText('Showing 50 of 50 transactions')).toBeTruthy();
    expect(mockUseTransactionContext).toHaveBeenCalledTimes(1);

    const addButtons = screen.getAllByRole('button', { name: '+ Add' });
    expect(addButtons).toHaveLength(2);

    for (const addButton of addButtons) {
      fireEvent.click(addButton);
      expect(screen.getByRole('dialog')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('dialog')).toBeNull();
    }

    expect(mockUseTransactionContext).toHaveBeenCalledTimes(1);
  });
});

describe('TransactionList search draft sync', () => {
  function inputValues(): string[] {
    return screen.getAllByLabelText('Search transactions').map(input => {
      if (!(input instanceof HTMLInputElement)) {
        throw new Error('Expected the "Search transactions" control to be an input element');
      }
      return input.value;
    });
  }

  test('starts from URL q, keeps typing local, and resets when q changes externally', () => {
    mockSearchParams = new URLSearchParams('q=food');
    mockUseTransactionContext.mockReturnValue(contextValue(makeTransactions(3)));
    const { rerender } = render(<TransactionList />);

    expect(inputValues()).toEqual(['food', 'food']);

    const [mobileInput] = screen.getAllByLabelText('Search transactions');
    fireEvent.change(mobileInput, { target: { value: 'coffee' } });

    expect(inputValues()).toEqual(['coffee', 'coffee']);
    expect(mockReplace).not.toHaveBeenCalled();

    fireEvent.keyDown(mobileInput, { key: 'Enter' });
    expect(mockReplace).toHaveBeenCalledWith('/transactions?q=coffee', { scroll: false });
    expect(inputValues()).toEqual(['coffee', 'coffee']);

    mockReplace.mockClear();
    mockSearchParams = new URLSearchParams('q=rent');
    rerender(<TransactionList />);

    expect(inputValues()).toEqual(['rent', 'rent']);
    expect(mockReplace).not.toHaveBeenCalled();

    mockSearchParams = new URLSearchParams();
    rerender(<TransactionList />);

    expect(inputValues()).toEqual(['', '']);

    const [emptyInput] = screen.getAllByLabelText('Search transactions');
    fireEvent.change(emptyInput, { target: { value: 'taxi' } });
    expect(inputValues()).toEqual(['taxi', 'taxi']);
    expect(mockReplace).not.toHaveBeenCalled();

    fireEvent.blur(emptyInput, { target: { value: 'taxi' } });
    expect(mockReplace).toHaveBeenCalledWith('/transactions?q=taxi', { scroll: false });
  });
});
