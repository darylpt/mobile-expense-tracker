// ============================================================
// useStocks - Hook for managing stock tickers
// Fetches from IndexedDB and provides CRUD operations.
// ============================================================

'use client';

import { useState, useEffect, useCallback } from 'react';
import type { Stock } from '@/types';
import {
  getAllStocks,
  addStock as addStockToDB,
  updateStock as updateStockToDB,
  deleteStock as deleteStockFromDB,
  moveStockTo as moveStockToInDB,
} from '@/lib/idb';

export function useStocks() {
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    getAllStocks()
      .then((data) => { if (mounted) setStocks(data); })
      .catch((err) => {
        const message = err instanceof Error ? err.message : 'Failed to load stocks';
        if (mounted) setError(message);
        console.error('[useStocks] Error loading stocks:', err);
      })
      .finally(() => { if (mounted) setIsLoading(false); });
    return () => { mounted = false; };
  }, []);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await getAllStocks();
      setStocks(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load stocks';
      setError(message);
      console.error('[useStocks] Error loading stocks:', err);
    }
  }, []);

  const addStock = useCallback(async (stock: Omit<Stock, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> => {
    try {
      const id = await addStockToDB(stock);
      await refresh();
      return id;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add stock';
      setError(message);
      throw new Error(message);
    }
  }, [refresh]);

  const updateStock = useCallback(async (stock: Partial<Stock> & Pick<Stock, 'id'>): Promise<void> => {
    try {
      await updateStockToDB(stock);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update stock';
      setError(message);
      throw new Error(message);
    }
  }, [refresh]);

  const deleteStock = useCallback(async (id: string): Promise<void> => {
    try {
      await deleteStockFromDB(id);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete stock';
      setError(message);
      throw new Error(message);
    }
  }, [refresh]);

  const moveStockTo = useCallback(async (id: string, targetIndex: number): Promise<void> => {
    try {
      await moveStockToInDB(id, targetIndex);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reorder stocks';
      setError(message);
    }
  }, [refresh]);

  return {
    stocks,
    isLoading,
    error,
    refreshStocks: refresh,
    addStock,
    updateStock,
    deleteStock,
    moveStockTo,
  };
}
