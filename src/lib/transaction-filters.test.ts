import { filterQuery } from './transaction-filters';

test('persists all five filters while excluding view and unrelated parameters', () => {
  const result = new URLSearchParams(filterQuery('month=2026-09&type=expense&account=a&cat=Food&q=private+text&group=date&page=3&extra=value'));
  expect(Object.fromEntries(result)).toEqual({ month: '2026-09', type: 'expense', account: 'a', cat: 'Food', q: 'private text' });
});

test('view-only queries and cleared filters produce no saved selection', () => {
  expect(filterQuery('page=3&group=date&q=')).toBe('');
  expect(filterQuery('')).toBe('');
});
