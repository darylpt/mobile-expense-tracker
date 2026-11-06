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
  moveCategoryTo as moveCategoryToInDB,
} from '@/lib/idb';
import { useTransactionContext } from '@/context/TransactionContext';


export function useCategories() {
  const { isScopeVerified } = useTransactionContext();
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isScopeVerified) {
      setCategories([]);
      setIsLoading(false);
      return;
    }
    let mounted = true;
    getAllCategories()
      .then((data) => { if (mounted) setCategories(data); })
      .catch((err) => {
        const message = err instanceof Error ? err.message : 'Failed to load categories';
        if (mounted) setError(message);
        console.error('[useCategories] Error loading categories:', err);
      })
      .finally(() => { if (mounted) setIsLoading(false); });
    return () => { mounted = false; };
  }, [isScopeVerified]);

  const refresh = useCallback(async () => {
    if (!isScopeVerified) return;
    try {
      setError(null);
      const data = await getAllCategories();
      setCategories(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load categories';
      setError(message);
      console.error('[useCategories] Error loading categories:', err);
    }
  }, [isScopeVerified]);

  /** Get categories filtered by transaction type */
  const getCategoriesByType = useCallback(
    (type: TransactionType): Category[] => {
      return categories.filter((c) => c.type === type);
    },
    [categories]
  );

  const addCategory = useCallback(async (category: Omit<Category, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> => {
    try {
      if (!isScopeVerified) throw new Error('Local data is locked to another account');
      const id = await addCategoryToDB(category);
      await refresh();
      return id;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add category';
      setError(message);
      throw new Error(message);
    }
  }, [isScopeVerified, refresh]);

  const updateCategory = useCallback(async (category: Partial<Category> & Pick<Category, 'id'>): Promise<void> => {
    try {
      if (!isScopeVerified) throw new Error('Local data is locked to another account');
      await updateCategoryToDB(category);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update category';
      setError(message);
      throw new Error(message);
    }
  }, [isScopeVerified, refresh]);

  const deleteCategory = useCallback(async (id: string): Promise<void> => {
    try {
      if (!isScopeVerified) throw new Error('Local data is locked to another account');
      await deleteCategoryFromDB(id);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete category';
      setError(message);
      throw new Error(message);
    }
  }, [isScopeVerified, refresh]);

  const moveCategoryTo = useCallback(async (id: string, targetIndex: number): Promise<void> => {
    try {
      if (!isScopeVerified) throw new Error('Local data is locked to another account');
      await moveCategoryToInDB(id, targetIndex);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reorder categories';
      setError(message);
    }
  }, [isScopeVerified, refresh]);

  return {
    categories,
    isLoading,
    error,
    getCategoriesByType,
    refreshCategories: refresh,
    addCategory,
    updateCategory,
    deleteCategory,
    moveCategoryTo,
  };
}
