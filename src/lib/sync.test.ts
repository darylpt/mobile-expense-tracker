import { backgroundSync } from './sync';
import { publishAuthIdentity } from './auth-scope';
import { LAST_USER_STORAGE_KEY } from './constants';

const mockGetUser = jest.fn();
const mockFrom = jest.fn();
const mockGetDB = jest.fn();
const mockEnsureUuids = jest.fn();

jest.mock('./supabase', () => ({
  supabase: {
    auth: { getUser: (...args: unknown[]) => mockGetUser(...args) },
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

jest.mock('./idb', () => ({
  getDB: (...args: unknown[]) => mockGetDB(...args),
  ensureUuids: (...args: unknown[]) => mockEnsureUuids(...args),
}));

/**
 * A genuinely empty, transaction-capable database fixture. An empty pull is an
 * authoritative snapshot that must still be merged inside a readwrite
 * transaction, so `getAllFromIndex` alone is no longer a valid empty database:
 * every object store reports no records and `transaction.done` resolves after
 * the merge commits.
 */
function makeEmptyDatabase() {
  const makeStore = () => ({
    getAll: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue(undefined),
    put: jest.fn().mockResolvedValue(undefined),
    add: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    index: () => ({
      getAll: jest.fn().mockResolvedValue([]),
    }),
  });

  return {
    getAllFromIndex: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue(undefined),
    transaction: jest.fn(() => ({
      objectStore: () => makeStore(),
      done: Promise.resolve(),
      abort: jest.fn(),
    })),
  };
}

describe('backgroundSync single-flight guard', () => {
  beforeEach(() => {
    mockGetUser.mockReset();
    mockFrom.mockReset();
    mockGetDB.mockReset();
    mockEnsureUuids.mockReset();

    localStorage.clear();
    localStorage.setItem(LAST_USER_STORAGE_KEY, 'user-1');
    publishAuthIdentity({ state: 'authenticated', userId: 'user-1' });
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: true,
    });

    mockEnsureUuids.mockResolvedValue(undefined);
    mockGetDB.mockResolvedValue(makeEmptyDatabase());
    mockFrom.mockImplementation(() => ({
      select: () => ({
        eq: () => Promise.resolve({ data: [], error: null }),
      }),
    }));
  });

  it('runs a later sync after the first auth lookup rejects', async () => {
    mockGetUser
      .mockRejectedValueOnce(new Error('auth lookup failed'))
      .mockResolvedValue({ data: { user: { id: 'user-1' } } });

    await backgroundSync().catch(() => undefined);

    expect(localStorage.getItem('last_sync_time')).toBeNull();

    await backgroundSync();

    expect(mockGetUser).toHaveBeenCalledTimes(2);
    expect(mockFrom).toHaveBeenCalledTimes(10);
    expect(localStorage.getItem('last_sync_time')).not.toBeNull();
  });
});
