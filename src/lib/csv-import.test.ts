import { inferCategoryType, parseCsv, checkStorageQuota, type CsvRow } from './csv-import';

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

describe('parseCsv', () => {
  it('should error when From Account and To Account are the same', () => {
    const csv = [
      'Date,Amount,Description,Type,Category,From Account,To Account',
      '1/5/2026,₱100.00,Test,Transfer,Transfer,Cash,Cash',
    ].join('\n');
    const result = parseCsv(csv);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('Transfer must use different From and To accounts');
    expect(result.transactions).toHaveLength(0);
  });

  it('should pass when From Account and To Account differ', () => {
    const csv = [
      'Date,Amount,Description,Type,Category,From Account,To Account',
      '1/5/2026,₱100.00,Test,Transfer,Transfer,Cash,GoTyme',
    ].join('\n');
    const result = parseCsv(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.transactions).toHaveLength(1);
  });

  it('should be case-insensitive for account-equal check', () => {
    const csv = [
      'Date,Amount,Description,Type,Category,From Account,To Account',
      '1/5/2026,₱100.00,Test,Transfer,Transfer,cash,Cash',
    ].join('\n');
    const result = parseCsv(csv);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('Transfer must use different From and To accounts');
  });
});

describe('checkStorageQuota', () => {
  const originalStorage = navigator.storage;

  afterEach(() => {
    Object.defineProperty(navigator, 'storage', { value: originalStorage, configurable: true });
  });

  it('should return null when storage is available and usage is low', async () => {
    Object.defineProperty(navigator, 'storage', {
      value: {
        estimate: jest.fn().mockResolvedValue({ usage: 1_000_000, quota: 100_000_000 }),
      },
      configurable: true,
    });
    const warning = await checkStorageQuota(100);
    expect(warning).toBeNull();
  });

  it('should return warning when projected usage exceeds 80%', async () => {
    Object.defineProperty(navigator, 'storage', {
      value: {
        estimate: jest.fn().mockResolvedValue({ usage: 79_000_000, quota: 100_000_000 }),
      },
      configurable: true,
    });
    // 5000 records × 500 bytes = 2.5MB → 79MB + 2.5MB = 81.5% > 80%
    const warning = await checkStorageQuota(5000);
    expect(warning).toContain('nearly full');
  });

  it('should return null when navigator.storage is undefined', async () => {
    Object.defineProperty(navigator, 'storage', {
      value: undefined,
      configurable: true,
    });
    const warning = await checkStorageQuota(100);
    expect(warning).toBeNull();
  });

  it('should return null when estimate throws', async () => {
    Object.defineProperty(navigator, 'storage', {
      value: {
        estimate: jest.fn().mockRejectedValue(new Error('not supported')),
      },
      configurable: true,
    });
    const warning = await checkStorageQuota(100);
    expect(warning).toBeNull();
  });
});
