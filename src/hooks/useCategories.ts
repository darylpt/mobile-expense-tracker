// ============================================================
// useCategories - Hook for managing categories
// Fetches from IndexedDB and provides filtering by transaction type.
// ============================================================

'use client';

import { useState, useEffect, useCallback } from 'react';
import type { Category, TransactionType } from '@/types';
import {
  getAllCategories,
  addCategory as addCategoryToDB,
  updateCategory as updateCategoryToDB,
  deleteCategory as deleteCategoryFromDB,
} from '@/lib/idb';
import { generateId } from '@/lib/utils';

export function useCategories() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await getAllCategories();
      setCategories(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load categories';
      setError(message);
      console.error('[useCategories] Error loading categories:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Get categories filtered by transaction type */
  const getCategoriesByType = useCallback(
    (type: TransactionType): Category[] => {
      return categories.filter((c) => c.type === type);
    },
    [categories]
  );

  const addCategory = useCallback(async (category: Omit<Category, 'id'>): Promise<string> => {
    const id = generateId();
    try {
      await addCategoryToDB({ ...category, id });
      await refresh();
      return id;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add category';
      setError(message);
      throw new Error(message);
    }
  }, [refresh]);

  const updateCategory = useCallback(async (category: Category): Promise<void> => {
    try {
      await updateCategoryToDB(category);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update category';
      setError(message);
      throw new Error(message);
    }
  }, [refresh]);

  const deleteCategory = useCallback(async (id: string): Promise<void> => {
    try {
      await deleteCategoryFromDB(id);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete category';
      setError(message);
      throw new Error(message);
    }
  }, [refresh]);

  return {
    categories,
    isLoading,
    error,
    getCategoriesByType,
    refreshCategories: refresh,
    addCategory,
    updateCategory,
    deleteCategory,
  };
}
