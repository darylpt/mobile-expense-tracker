// ============================================================
// utils.test.ts — Pure-function tests for calculateCategoryBreakdown
// ============================================================

import { calculateCategoryBreakdown } from './utils';
import { tx } from './test-utils';

describe('calculateCategoryBreakdown', () => {
  it('returns an empty array for no transactions', () => {
    expect(calculateCategoryBreakdown([])).toEqual([]);
  });

  it('computes percentage relative to same-type group total, not grand total', () => {
    const txs = [
      tx({ date: '2026-06-01', type: 'income', amount: 8000, category: 'Salary' }),
      tx({ date: '2026-06-02', type: 'income', amount: 2000, category: 'Freelance' }),
      tx({ date: '2026-06-03', type: 'expense', amount: 1000, category: 'Food' }),
    ];
    const result = calculateCategoryBreakdown(txs);
    const salary = result.find((r) => r.category === 'Salary')!;
    const freelance = result.find((r) => r.category === 'Freelance')!;
    const food = result.find((r) => r.category === 'Food')!;

    // Income total = 10000, so Salary is 80% of income (not 80% of grand total 11000)
    expect(salary.percentage).toBeCloseTo(80, 5);
    expect(freelance.percentage).toBeCloseTo(20, 5);
    // Expense total = 1000, Food is the only expense category -> 100% of expenses
    expect(food.percentage).toBeCloseTo(100, 5);
  });

  it('handles transfer ("transaction") type as its own group, separate from income/expense', () => {
    const txs = [
      tx({ date: '2026-06-01', type: 'income', amount: 5000, category: 'Salary' }),
      tx({ date: '2026-06-02', type: 'transaction', amount: 3000, category: 'Savings Transfer' }),
      tx({ date: '2026-06-03', type: 'transaction', amount: 1000, category: 'Investment Transfer' }),
    ];
    const result = calculateCategoryBreakdown(txs);
    const savings = result.find((r) => r.category === 'Savings Transfer')!;
    const investment = result.find((r) => r.category === 'Investment Transfer')!;
    const salary = result.find((r) => r.category === 'Salary')!;

    // Transfer total = 4000 -> Savings is 75% of transfers, Investment is 25%
    expect(savings.percentage).toBeCloseTo(75, 5);
    expect(investment.percentage).toBeCloseTo(25, 5);
    // Salary is the only income category -> 100% of income, unaffected by transfer amounts
    expect(salary.percentage).toBeCloseTo(100, 5);
  });

  it('returns 0% percentage for a zero-amount category without dividing by zero', () => {
    const txs = [
      tx({ date: '2026-06-01', type: 'expense', amount: 0, category: 'Zero Cat' }),
    ];
    const result = calculateCategoryBreakdown(txs);
    expect(result).toHaveLength(1);
    expect(result[0].percentage).toBe(0);
    expect(result[0].totalAmount).toBe(0);
  });

  it('does not divide by zero when a type group total is zero but percentage guard handles it', () => {
    // All amounts are zero across the board — group total is 0, guarded via `data.totalAmount > 0` check
    const txs = [
      tx({ date: '2026-06-01', type: 'expense', amount: 0, category: 'A' }),
      tx({ date: '2026-06-02', type: 'expense', amount: 0, category: 'B' }),
    ];
    const result = calculateCategoryBreakdown(txs);
    expect(result.every((r) => r.percentage === 0)).toBe(true);
    expect(result.every((r) => Number.isFinite(r.percentage))).toBe(true);
  });

  it('aggregates multiple transactions in the same category and counts them', () => {
    const txs = [
      tx({ date: '2026-06-01', type: 'expense', amount: 100, category: 'Food' }),
      tx({ date: '2026-06-02', type: 'expense', amount: 200, category: 'Food' }),
      tx({ date: '2026-06-03', type: 'expense', amount: 300, category: 'Transport' }),
    ];
    const result = calculateCategoryBreakdown(txs);
    const food = result.find((r) => r.category === 'Food')!;
    const transport = result.find((r) => r.category === 'Transport')!;

    expect(food.totalAmount).toBe(300);
    expect(food.count).toBe(2);
    expect(food.percentage).toBeCloseTo(50, 5); // 300 / 600 total expenses
    expect(transport.percentage).toBeCloseTo(50, 5);
  });

  it('sorts results by totalAmount descending', () => {
    const txs = [
      tx({ date: '2026-06-01', type: 'expense', amount: 50, category: 'Small' }),
      tx({ date: '2026-06-02', type: 'expense', amount: 500, category: 'Big' }),
      tx({ date: '2026-06-03', type: 'expense', amount: 200, category: 'Medium' }),
    ];
    const result = calculateCategoryBreakdown(txs);
    expect(result.map((r) => r.category)).toEqual(['Big', 'Medium', 'Small']);
  });

  it('percentages within a type group sum to ~100%', () => {
    const txs = [
      tx({ date: '2026-06-01', type: 'expense', amount: 333, category: 'A' }),
      tx({ date: '2026-06-02', type: 'expense', amount: 333, category: 'B' }),
      tx({ date: '2026-06-03', type: 'expense', amount: 334, category: 'C' }),
    ];
    const result = calculateCategoryBreakdown(txs);
    const sum = result.reduce((s, r) => s + r.percentage, 0);
    expect(sum).toBeCloseTo(100, 5);
  });
});
