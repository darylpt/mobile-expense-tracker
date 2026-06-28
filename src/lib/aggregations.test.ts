// ============================================================
// aggregations.test.ts — Pure-function tests for the aggregation helpers
// ============================================================

import {
  calculateAccountBalances,
  calculateIncomeBreakdown,
  calculateExpenseBreakdown,
} from './aggregations';
import type { Transaction, Account, MonthYear } from '@/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACCOUNTS: Account[] = [
  { id: 'gotyme', name: 'GoTyme', startingBalance: 0 },
  { id: 'cash', name: 'Cash', startingBalance: 0 },
  { id: 'gcash', name: 'Gcash', startingBalance: 0 },
  { id: 'landbank', name: 'Landbank', startingBalance: 0 },
  { id: 'dragonfi', name: 'DragonFi', startingBalance: 0 },
];

/**
 * Build a transaction quickly without repeating defaults.
 */
function tx(overrides: Partial<Transaction> & { date: string; type: Transaction['type']; amount: number }): Transaction {
  return {
    id: `tx-${Math.random().toString(36).slice(2, 8)}`,
    category: 'Other',
    fromAccount: null,
    toAccount: null,
    description: '',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const JUNE_2026: MonthYear = { month: 5, year: 2026 };
const MAY_2026: MonthYear = { month: 4, year: 2026 };

// ---------------------------------------------------------------------------
// calculateAccountBalances
// ---------------------------------------------------------------------------

describe('calculateAccountBalances', () => {
  it('shows all accounts even with no activity and zero starting balances', () => {
    const result = calculateAccountBalances([], [], ACCOUNTS, JUNE_2026);
    // All accounts included + TOTAL row. Sorted by name: BPI BanKo, Cash, DragonFi, Gcash, GoTyme, Landbank
    expect(result).toHaveLength(ACCOUNTS.length + 1);
    const total = result.find((r) => r.accountId === 'TOTAL');
    expect(total).toMatchObject({
      accountId: 'TOTAL',
      startingBalance: 0,
      inflow: 0,
      outflow: 0,
      endingBalance: 0,
    });
  });

  it('includes accounts with non-zero starting balance even with no activity', () => {
    const accts: Account[] = [
      { id: 'gotyme', name: 'GoTyme', startingBalance: 5000 },
      { id: 'cash', name: 'Cash', startingBalance: 0 },
    ];
    const result = calculateAccountBalances([], [], accts, JUNE_2026);
    // All accounts shown regardless of starting balance — user decides what to keep via Settings
    expect(result).toHaveLength(3); // Cash, GoTyme, TOTAL
    expect(result[0].accountId).toBe('cash');
    expect(result[1].accountId).toBe('gotyme');
    expect(result[1].startingBalance).toBe(5000);
    expect(result[1].inflow).toBe(0);
    expect(result[1].outflow).toBe(0);
    expect(result[1].endingBalance).toBe(5000);
    // TOTAL
    expect(result[2].startingBalance).toBe(5000);
  });

  it('computes starting balance from prior period transactions', () => {
    // One prior income to GoTyme (before June)
    const priorTxs: Transaction[] = [
      tx({ date: '2026-05-01', type: 'income', amount: 10000, toAccount: 'gotyme' }),
    ];
    const currentTxs: Transaction[] = [];
    const result = calculateAccountBalances(currentTxs, priorTxs, ACCOUNTS, JUNE_2026);

    const gotyme = result.find((r) => r.accountId === 'gotyme');
    expect(gotyme).toBeDefined();
    expect(gotyme!.startingBalance).toBe(10000); // 0 + 10000 prior
    expect(gotyme!.inflow).toBe(0);
    expect(gotyme!.outflow).toBe(0);
    expect(gotyme!.endingBalance).toBe(10000);
  });

  it('computes prior net correctly for multiple transaction types', () => {
    const priorTxs: Transaction[] = [
      // May income → GoTyme
      tx({ date: '2026-05-01', type: 'income', amount: 45000, toAccount: 'gotyme' }),
      // May expense from cash
      tx({ date: '2026-05-02', type: 'expense', amount: 500, fromAccount: 'cash' }),
      // May expense from GoTyme to DragonFi (Savings/Investment style)
      tx({ date: '2026-05-15', type: 'expense', amount: 1500, fromAccount: 'gotyme', toAccount: 'dragonfi' }),
      // May internal transfer GoTyme → Landbank
      tx({ date: '2026-05-30', type: 'transaction', amount: 5000, fromAccount: 'gotyme', toAccount: 'landbank' }),
    ];

    const result = calculateAccountBalances([], priorTxs, ACCOUNTS, JUNE_2026);

    // GoTyme: +45000 (income) -1500 (expense from) -5000 (transfer from) = 38500
    const gotyme = result.find((r) => r.accountId === 'gotyme');
    expect(gotyme!.startingBalance).toBe(38500);

    // Cash: -500 (expense from)
    const cash = result.find((r) => r.accountId === 'cash');
    expect(cash!.startingBalance).toBe(-500);

    // DragonFi: +1500 (expense to)
    const df = result.find((r) => r.accountId === 'dragonfi');
    expect(df!.startingBalance).toBe(1500);

    // Landbank: +5000 (transfer to)
    const lb = result.find((r) => r.accountId === 'landbank');
    expect(lb!.startingBalance).toBe(5000);
  });

  it('computes inflow and outflow for current month', () => {
    const currentTxs: Transaction[] = [
      tx({ date: '2026-06-01', type: 'income', amount: 45000, toAccount: 'gotyme' }),
      tx({ date: '2026-06-02', type: 'expense', amount: 200, fromAccount: 'gcash' }),
      tx({ date: '2026-06-05', type: 'expense', amount: 1500, fromAccount: 'gotyme', toAccount: 'dragonfi' }),
      tx({ date: '2026-06-10', type: 'transaction', amount: 3000, fromAccount: 'gotyme', toAccount: 'landbank' }),
    ];

    const result = calculateAccountBalances(currentTxs, [], ACCOUNTS, JUNE_2026);

    const gotyme = result.find((r) => r.accountId === 'gotyme');
    // inflow: 45000 (income) ; outflow: 1500 (expense from) + 3000 (transfer from) = 4500
    // starting: 0, ending: 0 + 45000 - 4500 = 40500
    expect(gotyme!.inflow).toBe(45000);
    expect(gotyme!.outflow).toBe(4500);
    expect(gotyme!.endingBalance).toBe(40500);

    const gcash = result.find((r) => r.accountId === 'gcash');
    expect(gcash!.outflow).toBe(200);
    expect(gcash!.endingBalance).toBe(-200);

    const dragonfi = result.find((r) => r.accountId === 'dragonfi');
    expect(dragonfi!.inflow).toBe(1500); // expense toAccount
    expect(dragonfi!.endingBalance).toBe(1500);

    const landbank = result.find((r) => r.accountId === 'landbank');
    expect(landbank!.inflow).toBe(3000); // transfer toAccount
  });

  it('computes correct ending balance = starting + inflow - outflow with prior + current', () => {
    const priorTxs: Transaction[] = [
      tx({ date: '2026-05-01', type: 'income', amount: 45000, toAccount: 'gotyme' }),
    ];
    const currentTxs: Transaction[] = [
      tx({ date: '2026-06-01', type: 'income', amount: 5000, toAccount: 'gotyme' }),
      tx({ date: '2026-06-02', type: 'expense', amount: 1000, fromAccount: 'gotyme' }),
    ];

    const result = calculateAccountBalances(currentTxs, priorTxs, ACCOUNTS, JUNE_2026);
    const gotyme = result.find((r) => r.accountId === 'gotyme');
    expect(gotyme!.startingBalance).toBe(45000); // prior income
    expect(gotyme!.inflow).toBe(5000);            // current income
    expect(gotyme!.outflow).toBe(1000);           // current expense
    expect(gotyme!.endingBalance).toBe(49000);    // 45000 + 5000 - 1000
  });

  it('TOTAL row sums all columns', () => {
    const currentTxs: Transaction[] = [
      tx({ date: '2026-06-01', type: 'income', amount: 45000, toAccount: 'gotyme' }),
      tx({ date: '2026-06-02', type: 'expense', amount: 200, fromAccount: 'gcash' }),
    ];

    const result = calculateAccountBalances(currentTxs, [], ACCOUNTS, JUNE_2026);
    const total = result.find((r) => r.accountId === 'TOTAL')!;

    const nonTotal = result.filter((r) => r.accountId !== 'TOTAL');
    const sumStart = nonTotal.reduce((s, r) => s + r.startingBalance, 0);
    const sumIn = nonTotal.reduce((s, r) => s + r.inflow, 0);
    const sumOut = nonTotal.reduce((s, r) => s + r.outflow, 0);

    expect(total.startingBalance).toBe(sumStart);
    expect(total.inflow).toBe(sumIn);
    expect(total.outflow).toBe(sumOut);
    expect(total.endingBalance).toBe(sumStart + sumIn - sumOut);
  });
});

// ---------------------------------------------------------------------------
// calculateIncomeBreakdown
// ---------------------------------------------------------------------------

describe('calculateIncomeBreakdown', () => {
  it('returns only Total row when no income transactions', () => {
    const txs: Transaction[] = [
      tx({ date: '2026-06-01', type: 'expense', amount: 200, fromAccount: 'cash' }),
    ];
    const result = calculateIncomeBreakdown(txs);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('Total');
    expect(result[0].amount).toBe(0);
    expect(result[0].percentage).toBe(100);
  });

  it('groups by category and computes percentages', () => {
    const txs: Transaction[] = [
      tx({ date: '2026-06-01', type: 'income', amount: 45000, category: 'Paycheck', toAccount: 'gotyme' }),
      tx({ date: '2026-06-15', type: 'income', amount: 5000, category: 'Bonus', toAccount: 'gotyme' }),
    ];

    const result = calculateIncomeBreakdown(txs);
    // Two category rows + total
    expect(result).toHaveLength(3);

    const paycheck = result.find((r) => r.category === 'Paycheck')!;
    expect(paycheck.amount).toBe(45000);
    expect(paycheck.percentage).toBeCloseTo(90, 1);

    const bonus = result.find((r) => r.category === 'Bonus')!;
    expect(bonus.amount).toBe(5000);
    expect(bonus.percentage).toBeCloseTo(10, 1);

    const total = result.find((r) => r.category === 'Total')!;
    expect(total.amount).toBe(50000);
    expect(total.percentage).toBe(100);
  });

  it('handles single income category', () => {
    const txs: Transaction[] = [
      tx({ date: '2026-06-01', type: 'income', amount: 1000, category: 'Paycheck', toAccount: 'gotyme' }),
    ];
    const result = calculateIncomeBreakdown(txs);
    expect(result).toHaveLength(2);
    expect(result[0].percentage).toBe(100);
  });

  it('sorts by amount descending', () => {
    const txs: Transaction[] = [
      tx({ date: '2026-06-01', type: 'income', amount: 1000, category: 'Small', toAccount: 'gotyme' }),
      tx({ date: '2026-06-01', type: 'income', amount: 5000, category: 'Large', toAccount: 'gotyme' }),
      tx({ date: '2026-06-01', type: 'income', amount: 2000, category: 'Medium', toAccount: 'gotyme' }),
    ];
    const result = calculateIncomeBreakdown(txs);
    // Category rows (before Total)
    const cats = result.filter((r) => r.category !== 'Total');
    expect(cats[0].category).toBe('Large');
    expect(cats[1].category).toBe('Medium');
    expect(cats[2].category).toBe('Small');
  });
});

// ---------------------------------------------------------------------------
// calculateExpenseBreakdown
// ---------------------------------------------------------------------------

describe('calculateExpenseBreakdown', () => {
  it('returns only Total row when no expense transactions', () => {
    const txs: Transaction[] = [
      tx({ date: '2026-06-01', type: 'income', amount: 1000, toAccount: 'gotyme' }),
    ];
    const result = calculateExpenseBreakdown(txs);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('Total');
    expect(result[0].amount).toBe(0);
  });

  it('groups by category and computes planned / difference / percentage', () => {
    const budgets = { Food: 3000, Transportation: 2000 };

    const txs: Transaction[] = [
      tx({ date: '2026-06-02', type: 'expense', amount: 1500, category: 'Food', fromAccount: 'cash' }),
      tx({ date: '2026-06-05', type: 'expense', amount: 500, category: 'Transportation', fromAccount: 'cash' }),
    ];

    const result = calculateExpenseBreakdown(txs, budgets);
    expect(result).toHaveLength(3);

    const food = result.find((r) => r.category === 'Food')!;
    expect(food.planned).toBe(3000);
    expect(food.amount).toBe(1500);
    expect(food.difference).toBe(1500); // 3000 - 1500 = under budget
    expect(food.percentage).toBeCloseTo(75, 1);

    const transport = result.find((r) => r.category === 'Transportation')!;
    expect(transport.planned).toBe(2000);
    expect(transport.amount).toBe(500);
    expect(transport.difference).toBe(1500);

    const total = result.find((r) => r.category === 'Total')!;
    expect(total.planned).toBe(5000);
    expect(total.amount).toBe(2000);
    expect(total.difference).toBe(3000);
    expect(total.percentage).toBe(100);
  });

  it('handles budget target not set (defaults to 0)', () => {
    const txs: Transaction[] = [
      tx({ date: '2026-06-02', type: 'expense', amount: 500, category: 'Food', fromAccount: 'cash' }),
    ];
    const result = calculateExpenseBreakdown(txs, {});
    expect(result[0].planned).toBe(0);
    expect(result[0].difference).toBe(-500); // over budget by 500
  });

  it('shows negative difference when over budget', () => {
    const txs: Transaction[] = [
      tx({ date: '2026-06-02', type: 'expense', amount: 800, category: 'Food', fromAccount: 'cash' }),
    ];
    const result = calculateExpenseBreakdown(txs, { Food: 500 });
    expect(result[0].difference).toBe(-300);
  });

  it('sorts by amount descending', () => {
    const txs: Transaction[] = [
      tx({ date: '2026-06-01', type: 'expense', amount: 100, category: 'Small', fromAccount: 'cash' }),
      tx({ date: '2026-06-01', type: 'expense', amount: 500, category: 'Large', fromAccount: 'cash' }),
    ];
    const result = calculateExpenseBreakdown(txs);
    const cats = result.filter((r) => r.category !== 'Total');
    expect(cats[0].category).toBe('Large');
    expect(cats[1].category).toBe('Small');
  });
});
