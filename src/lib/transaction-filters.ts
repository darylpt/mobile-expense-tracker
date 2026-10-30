export const FILTERS_STORAGE_KEY = 'transactions_filters';

export function filterQuery(query: string): string {
  const source = new URLSearchParams(query);
  const filters = new URLSearchParams();
  for (const key of ['month', 'type', 'account', 'cat', 'q']) {
    const value = source.get(key);
    if (value) filters.set(key, value);
  }
  return filters.toString();
}
