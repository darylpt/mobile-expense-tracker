// ============================================================
// stock-prices.test.ts — Tests for Phisix API price lookup
// ============================================================

import { fetchStockPrice } from './stock-prices';

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('fetchStockPrice', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('parses a valid Phisix response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        stocks: [{ symbol: 'BDO', price: { currency: 'PHP', amount: 148.5 } }],
      }),
    });

    const result = await fetchStockPrice('BDO');
    expect(result).toEqual({ price: 148.5, currency: 'PHP' });
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('BDO'));
  });

  it('returns null on HTTP 429 (rate limit)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
    });

    const result = await fetchStockPrice('BDO');
    expect(result).toBeNull();
  });

  it('returns null on HTTP 404 (not found)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const result = await fetchStockPrice('INVALID');
    expect(result).toBeNull();
  });

  it('returns null when response has no stock data', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ stocks: [] }),
    });

    const result = await fetchStockPrice('BDO');
    expect(result).toBeNull();
  });

  it('returns null when price is missing from response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        stocks: [{ symbol: 'BDO', price: { currency: 'PHP' } }],
      }),
    });

    const result = await fetchStockPrice('BDO');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await fetchStockPrice('BDO');
    expect(result).toBeNull();
  });

  it('uppercases the ticker', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        stocks: [{ symbol: 'BDO', price: { currency: 'PHP', amount: 148.5 } }],
      }),
    });

    await fetchStockPrice('bdo');
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('BDO'));
  });
});
