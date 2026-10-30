import React from 'react';
import { fireEvent, render, screen, waitFor, type RenderResult } from '@testing-library/react';
import { TransactionList } from './TransactionList';
import { FILTERS_STORAGE_KEY } from '@/lib/transaction-filters';
import { getCurrentMonthYear } from '@/lib/utils';
import type { Transaction } from '@/types';

const mockUseTransactionContext = jest.fn();
const mockUseAuth = jest.fn();
let mockSearchParams = new URLSearchParams();
let mockSearchFromLocation = false;

beforeEach(() => {
  mockSearchParams = new URLSearchParams();
  mockSearchFromLocation = false;
  mockUseTransactionContext.mockReset();
  mockUseAuth.mockReset();
  mockUseAuth.mockReturnValue({ state: 'disabled' });
  localStorage.clear();
  window.history.replaceState(null, '', '/transactions');
});

afterEach(() => {
  jest.restoreAllMocks();
});

jest.mock('@/context/TransactionContext', () => ({
  useTransactionContext: () => mockUseTransactionContext(),
  formatAmount: (amount: number) => `₱${amount.toFixed(2)}`,
}));

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchFromLocation
    ? new URLSearchParams(window.location.search)
    : mockSearchParams,
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

function flushZeroDelayTimer(): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, 0));
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
    const navigate = window.history.replaceState.bind(window.history);
    const replaceState = jest.spyOn(window.history, 'replaceState');
    navigate(null, '', '/transactions?q=food');
    mockSearchParams = new URLSearchParams('q=food');
    mockUseTransactionContext.mockReturnValue(contextValue(makeTransactions(3)));
    const { rerender } = render(<TransactionList />);

    expect(inputValues()).toEqual(['food', 'food']);

    const [mobileInput] = screen.getAllByLabelText('Search transactions');
    fireEvent.change(mobileInput, { target: { value: 'coffee' } });

    expect(inputValues()).toEqual(['coffee', 'coffee']);
    expect(replaceState).not.toHaveBeenCalled();

    fireEvent.keyDown(mobileInput, { key: 'Enter' });
    expect(replaceState).toHaveBeenCalledWith(null, '', '?q=coffee');
    expect(inputValues()).toEqual(['coffee', 'coffee']);

    replaceState.mockClear();
    navigate(null, '', '/transactions?q=rent');
    mockSearchParams = new URLSearchParams('q=rent');
    rerender(<TransactionList />);

    expect(inputValues()).toEqual(['rent', 'rent']);
    expect(replaceState).not.toHaveBeenCalled();

    navigate(null, '', '/transactions');
    mockSearchParams = new URLSearchParams();
    rerender(<TransactionList />);

    expect(inputValues()).toEqual(['', '']);

    const [emptyInput] = screen.getAllByLabelText('Search transactions');
    fireEvent.change(emptyInput, { target: { value: 'taxi' } });
    expect(inputValues()).toEqual(['taxi', 'taxi']);
    expect(replaceState).not.toHaveBeenCalled();

    fireEvent.blur(emptyInput, { target: { value: 'taxi' } });
    expect(replaceState).toHaveBeenCalledWith(null, '', '?q=taxi');
  });
});

function HistorySyncHarness({ children }: { children: React.ReactNode }) {
  const [, forceRender] = React.useReducer((n: number) => n + 1, 0);

  React.useLayoutEffect(() => {
    const original = window.history.replaceState;
    const patched: History['replaceState'] = (data, unused, url) => {
      original.call(window.history, data, unused, url);
      forceRender();
    };
    window.history.replaceState = patched;
    return () => {
      window.history.replaceState = original;
    };
  }, []);

  return <>{children}</>;
}

describe('TransactionList filter restore under StrictMode', () => {
  function inputValues(): string[] {
    return screen.getAllByLabelText('Search transactions').map(input => {
      if (!(input instanceof HTMLInputElement)) {
        throw new Error('Expected the "Search transactions" control to be an input element');
      }
      return input.value;
    });
  }

  test('restores the saved query, mirror, and search draft after history sync', async () => {
    const saved = 'type=expense&q=row';
    localStorage.setItem(FILTERS_STORAGE_KEY, saved);
    mockUseTransactionContext.mockReturnValue(contextValue(makeTransactions(3)));
    mockSearchFromLocation = true;

    const view = render(
      <React.StrictMode>
        <HistorySyncHarness>
          <TransactionList />
        </HistorySyncHarness>
      </React.StrictMode>
    );

    await waitFor(() => {
      expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe(saved);
      expect(inputValues()).toEqual(['row', 'row']);
    });
    expect(window.location.search).toBe(`?${saved}`);
    expect(screen.getByText('Showing 3 of 3 transactions')).toBeTruthy();

    view.unmount();
  });

  test('reflects the saved filter in the controls while router params are still stale', async () => {
    const saved = 'type=income%2Ctransaction';
    localStorage.setItem(FILTERS_STORAGE_KEY, saved);
    mockUseTransactionContext.mockReturnValue(contextValue(makeTransactions(3)));

    render(
      <React.StrictMode>
        <TransactionList />
      </React.StrictMode>
    );

    await waitFor(() => {
      const expected = { Expense: 'false', Income: 'true', Transfer: 'true' };
      for (const [name, pressed] of Object.entries(expected)) {
        for (const chip of screen.getAllByRole('button', { name })) {
          expect(chip.getAttribute('aria-pressed')).toBe(pressed);
        }
      }
    });
    expect(window.location.search).toBe(`?${saved}`);
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe(saved);
  });
});

describe('TransactionList filter mirror auth gate', () => {
  test.each(['loading', 'unauthenticated'] as const)(
    '%s filter clicks update the URL without touching the mirror',
    (state) => {
      localStorage.setItem(FILTERS_STORAGE_KEY, 'q=private');
      mockUseAuth.mockReturnValue({ state });
      mockUseTransactionContext.mockReturnValue(contextValue(makeTransactions(3)));
      render(<TransactionList />);

      const [expenseChip] = screen.getAllByRole('button', { name: 'Expense' });
      fireEvent.click(expenseChip);

      expect(window.location.search).toBe('?type=income%2Ctransaction');
      expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe('q=private');
    }
  );

  test('an auth transition to unauthenticated does not write the current query back', () => {
    window.history.replaceState(null, '', '/transactions?q=private');
    mockSearchParams = new URLSearchParams('q=private');
    mockUseTransactionContext.mockReturnValue(contextValue(makeTransactions(3)));
    mockUseAuth.mockReturnValue({ state: 'disabled' });
    const view = render(<TransactionList />);
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe('q=private');

    localStorage.removeItem(FILTERS_STORAGE_KEY);
    mockUseAuth.mockReturnValue({ state: 'unauthenticated' });
    view.rerender(<TransactionList />);

    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBeNull();
    expect(window.location.search).toBe('?q=private');
  });
});

describe('TransactionList filter mirror identity switch', () => {
  const restored = 'q=row';

  function renderAsUserA() {
    localStorage.setItem(FILTERS_STORAGE_KEY, restored);
    mockUseAuth.mockReturnValue({ state: 'authenticated', user: { id: 'user-a' } });
    mockUseTransactionContext.mockReturnValue(contextValue(makeTransactions(3)));
    return render(<TransactionList />);
  }

  function switchToUserB() {
    localStorage.removeItem(FILTERS_STORAGE_KEY);
    mockUseAuth.mockReturnValue({ state: 'authenticated', user: { id: 'user-b' } });
    mockSearchParams = new URLSearchParams(restored);
  }

  test('a restored query is not written back when the identity switches as the router catches up', () => {
    const view = renderAsUserA();
    expect(window.location.search).toBe(`?${restored}`);

    switchToUserB();
    view.rerender(<TransactionList />);

    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBeNull();
    expect(window.location.search).toBe(`?${restored}`);
  });

  test('a settled restore is not written back when the identity switches afterwards', () => {
    const view = renderAsUserA();

    mockSearchParams = new URLSearchParams(restored);
    view.rerender(<TransactionList />);
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe(restored);

    switchToUserB();
    view.rerender(<TransactionList />);

    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBeNull();
  });

  test('a new explicit URL after the identity switch becomes the new user\'s mirror', () => {
    const view = renderAsUserA();

    switchToUserB();
    view.rerender(<TransactionList />);
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBeNull();

    mockSearchParams = new URLSearchParams('q=coffee');
    window.history.replaceState(null, '', '/transactions?q=coffee');
    view.rerender(<TransactionList />);

    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe('q=coffee');
  });

  test('a filter action after the identity switch becomes the new user\'s mirror', () => {
    mockSearchFromLocation = true;
    const view = renderAsUserA();
    expect(window.location.search).toBe(`?${restored}`);

    switchToUserB();
    view.rerender(<TransactionList />);
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBeNull();

    const [expenseChip] = screen.getAllByRole('button', { name: 'Expense' });
    fireEvent.click(expenseChip);

    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe('type=income%2Ctransaction&q=row');
    expect(window.location.search).toBe('?q=row&type=income%2Ctransaction');
  });
});

describe('TransactionList filter mirror with a stale router query', () => {
  function renderWithQuery(query: string) {
    window.history.replaceState(null, '', `/transactions?${query}`);
    mockSearchParams = new URLSearchParams(query);
    mockUseTransactionContext.mockReturnValue(contextValue(makeTransactions(3)));
    return render(<TransactionList />);
  }

  // `useSearchParams` can lag the URL past an explicit write. A new params
  // instance models that projection re-rendering with the query it had before.
  function rerenderWithStaleQuery(view: RenderResult, query: string) {
    mockSearchParams = new URLSearchParams(query);
    view.rerender(<TransactionList />);
  }

  test('a cleared query is not restored from router params that still report it', () => {
    const view = renderWithQuery('q=food');
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe('q=food');

    const [clearSearch] = screen.getAllByRole('button', { name: 'Remove search filter' });
    fireEvent.click(clearSearch);

    expect(window.location.search).toBe('');
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBeNull();

    rerenderWithStaleQuery(view, 'q=food');

    expect(window.location.search).toBe('');
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBeNull();
  });

  test('a new filter update survives router params that still report the old query', () => {
    const view = renderWithQuery('q=food');

    const [expenseChip] = screen.getAllByRole('button', { name: 'Expense' });
    fireEvent.click(expenseChip);

    const updated = 'type=income%2Ctransaction&q=food';
    expect(window.location.search).toBe('?q=food&type=income%2Ctransaction');
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe(updated);

    rerenderWithStaleQuery(view, 'q=food');

    expect(window.location.search).toBe('?q=food&type=income%2Ctransaction');
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe(updated);
  });
});

describe('TransactionList filter restore settlement', () => {
  const saved = 'q=row';
  const stale = 'q=stale';

  function searchValues(): string[] {
    return screen.getAllByLabelText('Search transactions').map(input => {
      if (!(input instanceof HTMLInputElement)) {
        throw new Error('Expected the "Search transactions" control to be an input element');
      }
      return input.value;
    });
  }

  function renderRestoreWithStaleRouterQuery() {
    localStorage.setItem(FILTERS_STORAGE_KEY, saved);
    mockUseTransactionContext.mockReturnValue(contextValue(makeTransactions(3)));
    mockSearchParams = new URLSearchParams(stale);
    return render(<TransactionList />);
  }

  test('a stale nonempty router query does not settle the restore onto stale filters', () => {
    const view = renderRestoreWithStaleRouterQuery();

    expect(searchValues()).toEqual(['row', 'row']);
    expect(window.location.search).toBe(`?${saved}`);
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe(saved);

    view.rerender(<TransactionList />);

    expect(searchValues()).toEqual(['row', 'row']);
    expect(window.location.search).toBe(`?${saved}`);
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe(saved);

    mockSearchParams = new URLSearchParams(saved);
    view.rerender(<TransactionList />);

    expect(searchValues()).toEqual(['row', 'row']);
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe(saved);
  });

  test('a stale router query that matches the saved filters does not settle before the publish lands', () => {
    localStorage.setItem(FILTERS_STORAGE_KEY, saved);
    mockUseTransactionContext.mockReturnValue(contextValue(makeTransactions(3)));
    // The router projects the saved filters plus a view-only page from before,
    // while the browser URL still has no query of its own.
    mockSearchParams = new URLSearchParams(`${saved}&page=3`);
    const view = render(<TransactionList />);

    expect(window.location.search).toBe(`?${saved}`);
    expect(searchValues()).toEqual(['row', 'row']);
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe(saved);

    view.rerender(<TransactionList />);

    expect(searchValues()).toEqual(['row', 'row']);
    expect(window.location.search).toBe(`?${saved}`);
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe(saved);
  });

  test('a newer explicit URL replaces the restore instead of being overridden by it', async () => {
    const view = renderRestoreWithStaleRouterQuery();
    expect(searchValues()).toEqual(['row', 'row']);

    window.history.replaceState(null, '', '/transactions?q=coffee');
    mockSearchParams = new URLSearchParams('q=coffee');
    view.rerender(<TransactionList />);

    expect(searchValues()).toEqual(['coffee', 'coffee']);
    expect(window.location.search).toBe('?q=coffee');
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe('q=coffee');

    await flushZeroDelayTimer();

    expect(searchValues()).toEqual(['coffee', 'coffee']);
    expect(window.location.search).toBe('?q=coffee');
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe('q=coffee');
  });

  test('a newer explicit browser URL backs the controls while router params stay stale', async () => {
    const view = renderRestoreWithStaleRouterQuery();
    expect(searchValues()).toEqual(['row', 'row']);

    window.history.replaceState(null, '', '/transactions?q=coffee');
    mockSearchParams = new URLSearchParams(stale);
    view.rerender(<TransactionList />);

    expect(searchValues()).toEqual(['coffee', 'coffee']);
    expect(window.location.search).toBe('?q=coffee');
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe('q=coffee');

    await flushZeroDelayTimer();

    expect(searchValues()).toEqual(['coffee', 'coffee']);
    expect(window.location.search).toBe('?q=coffee');
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe('q=coffee');
  });

  test('a view-only browser URL supersedes the restore and drops its filters', async () => {
    const view = renderRestoreWithStaleRouterQuery();
    expect(searchValues()).toEqual(['row', 'row']);
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe(saved);

    window.history.replaceState(null, '', '/transactions?group=date&page=3');
    mockSearchParams = new URLSearchParams(stale);
    view.rerender(<TransactionList />);

    expect(searchValues()).toEqual(['', '']);
    expect(screen.getAllByRole('button', { name: 'Grouped' }).length).toBeGreaterThan(0);
    expect(window.location.search).toBe('?group=date&page=3');
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBeNull();

    await flushZeroDelayTimer();

    expect(searchValues()).toEqual(['', '']);
    expect(window.location.search).toBe('?group=date&page=3');
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBeNull();
  });

  test('a filter update after a view-only URL settles keeps its group param and drops stale router filters', () => {
    localStorage.setItem(FILTERS_STORAGE_KEY, saved);
    mockUseTransactionContext.mockReturnValue(contextValue(makeTransactions(3)));
    mockSearchParams = new URLSearchParams(stale);
    const view = render(<TransactionList />);
    expect(window.location.search).toBe(`?${saved}`);

    window.history.replaceState(null, '', '/transactions?group=date&page=3');
    view.rerender(<TransactionList />);
    expect(window.location.search).toBe('?group=date&page=3');

    // The router catches up to the query the restore published, not the one
    // the URL now carries.
    mockSearchParams = new URLSearchParams(saved);
    view.rerender(<TransactionList />);

    const [accountFilter] = screen.getAllByLabelText('Filter by account');
    fireEvent.change(accountFilter, { target: { value: 'acc-1' } });

    const params = new URLSearchParams(window.location.search);
    expect(params.has('q')).toBe(false);
    expect(params.get('group')).toBe('date');
    expect(params.get('account')).toBe('acc-1');
    expect(params.has('page')).toBe(false);
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe('account=acc-1');
  });

  test('consecutive updates keep the newer browser query after the restore drops to idle', () => {
    const view = renderRestoreWithStaleRouterQuery();
    window.history.replaceState(null, '', '/transactions?q=coffee&group=date');
    mockSearchParams = new URLSearchParams(stale);
    view.rerender(<TransactionList />);

    expect(searchValues()).toEqual(['coffee', 'coffee']);
    expect(window.location.search).toBe('?q=coffee&group=date');

    const [accountFilter] = screen.getAllByLabelText('Filter by account');
    fireEvent.change(accountFilter, { target: { value: 'acc-1' } });
    expect(searchValues()).toEqual(['coffee', 'coffee']);
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe('account=acc-1&q=coffee');

    const [categoryFilter] = screen.getAllByLabelText('Filter by category');
    fireEvent.change(categoryFilter, { target: { value: 'Food' } });

    const params = new URLSearchParams(window.location.search);
    expect(params.get('q')).toBe('coffee');
    expect(params.get('group')).toBe('date');
    expect(params.get('account')).toBe('acc-1');
    expect(params.get('cat')).toBe('Food');
    expect(searchValues()).toEqual(['coffee', 'coffee']);
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe('account=acc-1&cat=Food&q=coffee');
  });

  test('consecutive updates from idle keep the browser URL over a stale router', () => {
    mockUseTransactionContext.mockReturnValue(contextValue(makeTransactions(3)));
    mockSearchParams = new URLSearchParams(stale);
    window.history.replaceState(null, '', '/transactions?group=date');
    render(<TransactionList />);

    expect(searchValues()).toEqual(['', '']);

    const [accountFilter] = screen.getAllByLabelText('Filter by account');
    fireEvent.change(accountFilter, { target: { value: 'acc-1' } });
    expect((screen.getAllByLabelText('Filter by account')[0] as HTMLSelectElement).value).toBe('acc-1');

    const [categoryFilter] = screen.getAllByLabelText('Filter by category');
    fireEvent.change(categoryFilter, { target: { value: 'Food' } });

    const params = new URLSearchParams(window.location.search);
    expect(params.get('group')).toBe('date');
    expect(params.get('account')).toBe('acc-1');
    expect(params.get('cat')).toBe('Food');
    expect(params.has('q')).toBe(false);
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe('account=acc-1&cat=Food');
  });

  test('a stale router page does not strip the URL of a pending restore', () => {
    localStorage.setItem(FILTERS_STORAGE_KEY, saved);
    mockUseTransactionContext.mockReturnValue(contextValue(makeTransactions(3)));
    // The router still projects a page param the published restore never had.
    mockSearchParams = new URLSearchParams('page=3');
    render(<TransactionList />);

    expect(window.location.search).toBe(`?${saved}`);
    expect(searchValues()).toEqual(['row', 'row']);
    expect(localStorage.getItem(FILTERS_STORAGE_KEY)).toBe(saved);
  });
});
