// ============================================================
// stock-prices.test.ts — Tests for Yahoo Finance price lookup
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

  it('parses a valid Yahoo Finance response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        chart: {
          result: [
            {
              meta: {
                regularMarketPrice: 148.5,
                currency: 'PHP',
              },
            },
          ],
        },
      }),
    });

    const result = await fetchStockPrice('BDO');
    expect(result).toEqual({ price: 148.5, currency: 'PHP' });
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('BDO.PS'));
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

  it('returns null when response has no chart data', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ chart: { result: [] } }),
    });

    const result = await fetchStockPrice('BDO');
    expect(result).toBeNull();
  });

  it('returns null when price is missing from response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        chart: {
          result: [{ meta: { currency: 'PHP' } }],
        },
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

  it('uppercases the ticker and appends .PS', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        chart: {
          result: [{ meta: { regularMarketPrice: 10, currency: 'PHP' } }],
        },
      }),
    });

    await fetchStockPrice('bdo');
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('BDO.PS'));
  });
});
