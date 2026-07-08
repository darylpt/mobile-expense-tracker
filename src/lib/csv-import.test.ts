import { inferCategoryType } from './csv-import';
import { CsvRow } from '@/types';

describe('inferCategoryType', () => {
  const mockRow = (
    category: string,
    fromAccount: string,
    toAccount: string,
    type: string,
  ): CsvRow => ({
    date: '2023-01-01',
    amount: 100,
    description: 'test',
    type,
    category,
    fromAccount,
    toAccount,
    rowNum: 1,
  });

  it('should return "transaction" when Type column is Transfer (named categories)', () => {
    const rows = [mockRow('Savings Transfer', 'A', 'B', 'Transfer')];
    expect(inferCategoryType(rows)).toBe('transaction');
  });

  it('should return "transaction" when Type column is Transfer (Cash In)', () => {
    const rows = [mockRow('Cash In', 'A', 'B', 'Transfer')];
    expect(inferCategoryType(rows)).toBe('transaction');
  });

  it('should return "transaction" when Type column is Transfer (Cash Out)', () => {
    const rows = [mockRow('Cash Out', 'A', 'B', 'Transfer')];
    expect(inferCategoryType(rows)).toBe('transaction');
  });

  it('should return "transaction" for all rows with Type=Transfer', () => {
    const rows = [
      mockRow('Transfer', 'A', 'B', 'Transfer'),
      mockRow('Withdrawal', 'C', 'D', 'Transfer'),
    ];
    expect(inferCategoryType(rows)).toBe('transaction');
  });

  it('should return "income" for all rows with Type=Income', () => {
    const rows = [
      mockRow('Salary', '', 'A', 'Income'),
      mockRow('Interest', '', 'B', 'Income'),
    ];
    expect(inferCategoryType(rows)).toBe('income');
  });

  it('should return "expense" for all rows with Type=Expense', () => {
    const rows = [
      mockRow('Food', 'A', '', 'Expense'),
      mockRow('Groceries', 'B', '', 'Expense'),
    ];
    expect(inferCategoryType(rows)).toBe('expense');
  });

  it('should fallback to account-pattern heuristic for mixed Type values', () => {
    const rows = [
      mockRow('Adjustments', '', 'A', 'Income'),   // income pattern
      mockRow('Adjustments', 'B', '', 'Expense'),    // expense pattern
    ];
    expect(inferCategoryType(rows)).toBe('expense');
  });

  it('should fallback: income wins when mixed Income + Transfer rows', () => {
    const rows = [
      mockRow('Mixed', '', 'A', 'Income'),        // income pattern
      mockRow('Mixed', 'B', 'C', 'Transfer'),     // transfer pattern
    ];
    expect(inferCategoryType(rows)).toBe('income');
  });

  it('should fallback: expense wins when mixed Expense + Transfer rows', () => {
    const rows = [
      mockRow('Mixed', 'A', '', 'Expense'),       // expense pattern
      mockRow('Mixed', 'B', 'C', 'Transfer'),     // transfer pattern
    ];
    expect(inferCategoryType(rows)).toBe('expense');
  });

  it('should return "expense" for an empty array', () => {
    const rows: CsvRow[] = [];
    expect(inferCategoryType(rows)).toBe('expense');
  });

  it('should return "transaction" for a single row with Type=Transfer', () => {
    const rows = [mockRow('Transfer', 'A', 'B', 'Transfer')];
    expect(inferCategoryType(rows)).toBe('transaction');
  });
});
