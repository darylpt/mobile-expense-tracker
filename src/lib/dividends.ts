// ============================================================
// dividends.ts — Remote/local dividend shape compatibility
// ============================================================

/**
 * Convert a dividend from either the legacy remote shape (date and
 * amount) or the expanded local/remote shape into the safe local shape.
 * Unknown fields are retained so sync metadata is not discarded.
 */
export function normalizeDividendRecord(record: Record<string, unknown>): Record<string, unknown> {
  const legacyDate = record.date;
  const exDate = normalizeDate(record.exDate ?? record.ex_date ?? legacyDate);
  const payDate = normalizeDate(record.payDate ?? record.pay_date ?? legacyDate ?? exDate);
  const qty = toNumber(record.qty, 0);
  const rate = toNumber(record.rate, 0);
  const amount = toNumber(record.amount, qty * rate);
  const fee = toNumber(record.fee, 0);
  const dividendYield = toNullableNumber(record.dividendYield ?? record.dividend_yield);
  const sharesReceived = toNullableNumber(record.sharesReceived ?? record.shares_received);

  return {
    ...record,
    id: record.id,
    stockId: record.stockId ?? record.stock_id,
    exDate,
    payDate,
    type: record.type === 'stock' ? 'stock' : 'cash',
    qty,
    rate,
    amount,
    fee,
    dividendYield,
    sharesReceived,
    notes: record.notes ?? null,
    createdAt: normalizeTimestamp(record.createdAt ?? record.created_at),
    updatedAt: normalizeTimestamp(record.updatedAt ?? record.updated_at),
  };
}

function normalizeDate(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString().slice(0, 10);
  }
  return '';
}

function toNumber(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : fallback;
}

function toNullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const timestamp = new Date(value).getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}
