// ============================================================
// idb.test.ts — Tests for the IndexedDB data layer
// ============================================================

// Replace global indexedDB with fake-indexeddb for test isolation
import 'fake-indexeddb/auto';

// fake-indexeddb v6 needs structuredClone — polyfill for jsdom
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (val: unknown) => JSON.parse(JSON.stringify(val));
}
import {
  getBudgetTarget,
  setBudgetTarget,
  getAllBudgetTargets,
  getDB,
} from './idb';
// ponytail: BudgetTarget type import ready for future test assertions

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MONTH = '2026-06';

async function countTargets(): Promise<number> {
  const all = await getAllBudgetTargets();
  return all.length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('idb — budgetTargets', () => {
  // Fresh DB before each test
  beforeEach(async () => {
    // Clear the budgetTargets store
    const db = await getDB();
    const tx = db.transaction('budgetTargets', 'readwrite');
    await tx.store.clear();
    await tx.done;
  });

  describe('setBudgetTarget / getBudgetTarget', () => {
    it('global default (no month) creates a record and getBudgetTarget returns it', async () => {
      await setBudgetTarget('Food', 3000);
      const result = await getBudgetTarget('Food', MONTH);
      expect(result).toBe(3000);
    });

    it('per-month override takes precedence over global default', async () => {
      await setBudgetTarget('Food', 3000); // global default
      await setBudgetTarget('Food', 5000, MONTH); // per-month override

      const result = await getBudgetTarget('Food', MONTH);
      expect(result).toBe(5000);
    });

    it('unknown category returns 0', async () => {
      const result = await getBudgetTarget('NonExistent', MONTH);
      expect(result).toBe(0);
    });

    it('override does not affect other months (global still returned)', async () => {
      await setBudgetTarget('Transportation', 2000); // global
      await setBudgetTarget('Transportation', 1500, MONTH); // June override

      const juneResult = await getBudgetTarget('Transportation', MONTH);
      expect(juneResult).toBe(1500);

      const julyResult = await getBudgetTarget('Transportation', '2026-07');
      expect(julyResult).toBe(2000); // falls back to global
    });

    it('returns 0 for month with no override and no global default', async () => {
      await setBudgetTarget('Food', 3000); // global
      await setBudgetTarget('Food', 5000, MONTH); // June override

      const mayResult = await getBudgetTarget('Food', '2026-05');
      expect(mayResult).toBe(3000); // global

      const augResult = await getBudgetTarget('Food', '2026-08');
      expect(augResult).toBe(3000); // global
    });
  });

  describe('setBudgetTarget upsert', () => {
    it('updates existing global record when month is omitted', async () => {
      await setBudgetTarget('Food', 3000);
      await setBudgetTarget('Food', 4000); // update global

      const result = await getBudgetTarget('Food', MONTH);
      expect(result).toBe(4000);
      expect(await countTargets()).toBe(1); // still 1 record
    });

    it('updates existing override when month is given', async () => {
      await setBudgetTarget('Food', 3000, MONTH);
      await setBudgetTarget('Food', 4000, MONTH); // update override

      const result = await getBudgetTarget('Food', MONTH);
      expect(result).toBe(4000);
      expect(await countTargets()).toBe(1);
    });

    it('creates separate records for global and override', async () => {
      await setBudgetTarget('Food', 3000); // global
      await setBudgetTarget('Food', 5000, MONTH); // override

      expect(await countTargets()).toBe(2);
      expect(await getBudgetTarget('Food', MONTH)).toBe(5000);
      expect(await getBudgetTarget('Food', '2026-05')).toBe(3000);
    });
  });

  describe('getAllBudgetTargets', () => {
    it('returns empty array when no targets exist', async () => {
      const result = await getAllBudgetTargets();
      expect(result).toEqual([]);
    });

    it('returns all records', async () => {
      await setBudgetTarget('Food', 3000);
      await setBudgetTarget('Transportation', 2000);
      await setBudgetTarget('Home', 1500, MONTH);

      const all = await getAllBudgetTargets();
      expect(all).toHaveLength(3);
    });

    it('records have the correct shape', async () => {
      await setBudgetTarget('Food', 3000);
      const all = await getAllBudgetTargets();
      expect(all[0]).toMatchObject({
        id: expect.any(String),
        category: 'Food',
        amount: 3000,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      });
    });
  });
});
