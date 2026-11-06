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
    mockGetDB.mockResolvedValue({
      getAllFromIndex: jest.fn().mockResolvedValue([]),
    });
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
