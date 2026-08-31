import { normalizeDividendRecord } from './dividends';
import { preparePayloadForRemote } from './sync';

describe('dividend sync compatibility', () => {
  test('normalizes a legacy remote row into a complete local dividend', () => {
    const normalized = normalizeDividendRecord({
      id: 'd-legacy',
      stock_id: 'stock-1',
      date: '2026-07-15',
      type: 'cash',
      amount: 500,
      shares_received: null,
      notes: 'legacy import',
      created_at: '2026-07-16T00:00:00.000Z',
      updated_at: '2026-07-16T00:00:00.000Z',
    });

    expect(normalized).toEqual(expect.objectContaining({
      id: 'd-legacy',
      stockId: 'stock-1',
      exDate: '2026-07-15',
      payDate: '2026-07-15',
      qty: 0,
      rate: 0,
      amount: 500,
      fee: 0,
      dividendYield: null,
      sharesReceived: null,
      notes: 'legacy import',
    }));
    expect(normalized.createdAt).toBe(Date.parse('2026-07-16T00:00:00.000Z'));
  });

  test('sends expanded dividends with legacy date and amount columns', () => {
    const payload = preparePayloadForRemote({
      id: 'd-new',
      stockId: 'stock-1',
      exDate: '2026-08-01',
      payDate: '2026-08-15',
      type: 'cash',
      qty: 100,
      rate: 2.5,
      amount: 250,
      fee: 25,
      dividendYield: 3.2,
      sharesReceived: null,
      notes: null,
      createdAt: Date.parse('2026-08-02T00:00:00.000Z'),
      updatedAt: Date.parse('2026-08-02T00:00:00.000Z'),
    });

    expect(payload).toEqual(expect.objectContaining({
      date: '2026-08-01',
      amount: 250,
      ex_date: '2026-08-01',
      pay_date: '2026-08-15',
      qty: 100,
      rate: 2.5,
      fee: 25,
      dividend_yield: 3.2,
      shares_received: null,
    }));
  });
});
