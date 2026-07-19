'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/common/Button';
import { HoldingsTable } from '@/components/stocks/HoldingsTable';
import { TransactionLog } from '@/components/stocks/TransactionLog';
import { DividendLog } from '@/components/stocks/DividendLog';
import { StockTransactionForm } from '@/components/forms/StockTransactionForm';
import { DividendForm } from '@/components/forms/DividendForm';
import { PortfolioSummaryCard } from '@/components/summary/PortfolioSummaryCard';
import { useStocks } from '@/hooks/useStocks';
import { getAllStockTransactions, addStockTransaction, deleteStockTransaction, updateStockTransaction } from '@/lib/idb';
import { getAllDividends, addDividend, deleteDividend, updateDividend } from '@/lib/idb';
import { refreshAllPrices } from '@/lib/stock-prices';
import { computeHoldings, type HoldingsResult } from '@/lib/holdings';
import { ManageTickers } from '@/components/stocks/ManageTickers';
import type { StockTransaction, Dividend } from '@/types';

type Section = 'holdings' | 'transactions' | 'dividends';

export default function StocksPage() {
  const { stocks, isLoading: stocksLoading, refreshStocks, addStock, updateStock, deleteStock, moveStockTo } = useStocks();
  const [transactions, setTransactions] = useState<StockTransaction[]>([]);
  const [dividends, setDividends] = useState<Dividend[]>([]);
  const [holdings, setHoldings] = useState<HoldingsResult | null>(null);
  const [activeSection, setActiveSection] = useState<Section>('holdings');
  const [showTxForm, setShowTxForm] = useState(false);
  const [showDivForm, setShowDivForm] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [priceMsg, setPriceMsg] = useState<string | null>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ponytail: load initial data once stocks are ready
  useEffect(() => {
    if (stocksLoading) return;
    (async () => {
      const [txs, divs] = await Promise.all([
        getAllStockTransactions(),
        getAllDividends(),
      ]);
      if (!mountedRef.current) return;
      setTransactions(txs);
      setDividends(divs);
      const result = computeHoldings(stocks, txs, divs);
      setHoldings(result);
      setDataLoading(false);
    })();
  }, [stocksLoading, stocks]);

  const reloadData = useCallback(async () => {
    const [txs, divs] = await Promise.all([
      getAllStockTransactions(),
      getAllDividends(),
    ]);
    if (!mountedRef.current) return;
    setTransactions(txs);
    setDividends(divs);
    const result = computeHoldings(stocks, txs, divs);
    setHoldings(result);
  }, [stocks]);

  const handleRefreshPrices = async () => {
    setRefreshing(true);
    setPriceMsg(null);
    try {
      const results = await refreshAllPrices();
      const failed = results.filter(r => r.price === null);
      if (results.length === 0) {
        setPriceMsg('No stocks to refresh. Add a stock first.');
      } else if (failed.length === results.length) {
        setPriceMsg('Could not fetch any prices. Check your connection or try again later.');
      } else if (failed.length > 0) {
        setPriceMsg(`Prices updated, but ${failed.length} ticker(s) failed: ${failed.map(f => f.ticker).join(', ')}`);
      } else {
        setPriceMsg('All prices updated.');
      }
      await refreshStocks();
      await reloadData();
    } catch {
      setPriceMsg('Price refresh failed.');
    } finally {
      setRefreshing(false);
    }
  };

  const handleAddTx = async (tx: Omit<StockTransaction, 'id' | 'createdAt' | 'updatedAt'>) => {
    await addStockTransaction(tx);
    setShowTxForm(false);
    await reloadData();
  };

  const handleDeleteTx = async (id: string) => {
    if (!window.confirm('Delete this transaction?')) return;
    await deleteStockTransaction(id);
    await reloadData();
  };

  const handleAddDiv = async (d: Omit<Dividend, 'id' | 'createdAt' | 'updatedAt'>) => {
    await addDividend(d);
    setShowDivForm(false);
    await reloadData();
  };

  const handleDeleteDiv = async (id: string) => {
    if (!window.confirm('Delete this dividend record?')) return;
    await deleteDividend(id);
    await reloadData();
  };

  const handleUpdateTx = async (id: string, updates: Partial<StockTransaction>) => {
    await updateStockTransaction(id, updates);
    await reloadData();
  };

  const handleUpdateDiv = async (id: string, updates: Partial<Dividend>) => {
    await updateDividend(id, updates);
    await reloadData();
  };

  const isLoading = stocksLoading || dataLoading;
  const hasStocks = stocks.length > 0;

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <Header title="Stocks" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-20 pt-6 sm:px-6 sm:pb-0 sm:pt-8">
        {isLoading ? (
          <div className="py-12 text-center text-sm text-zinc-400">Loading…</div>
        ) : !hasStocks ? (
          /* Empty state — show manage tickers inline */
          <div className="space-y-6">
            <p className="text-center text-sm text-zinc-500 dark:text-zinc-400">No stocks configured yet.</p>
            <ManageTickers stocks={stocks} onAdd={addStock} onUpdate={updateStock} onDelete={deleteStock} onMoveTo={moveStockTo} />
          </div>
        ) : (
          <div className="space-y-6">
            {/* ── Price refresh bar ── */}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleRefreshPrices}
                disabled={refreshing}
                isLoading={refreshing}
              >
                {refreshing ? 'Refreshing…' : 'Refresh Prices'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowManage(!showManage)}>
                {showManage ? 'Close' : 'Manage Tickers'}
              </Button>
              {priceMsg && (
                <p className="text-sm text-zinc-600 dark:text-zinc-400">{priceMsg}</p>
              )}
            </div>

            {showManage && (
              <ManageTickers
                stocks={stocks}
                onAdd={addStock}
                onUpdate={updateStock}
                onDelete={deleteStock}
                onMoveTo={moveStockTo}
              />
            )}

            {/* ── Portfolio summary card ── */}
            <PortfolioSummaryCard />

            {/* ── Section tabs ── */}
            <div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-700">
              {(['holdings', 'transactions', 'dividends'] as Section[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setActiveSection(s)}
                  className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${
                    activeSection === s
                      ? 'border-b-2 border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                      : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>

            {/* ── Section content ── */}
            {activeSection === 'holdings' && holdings && (
              <HoldingsTable holdings={holdings} stocks={stocks} />
            )}

            {activeSection === 'transactions' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                    Transactions
                  </h2>
                  <Button variant="primary" size="sm" onClick={() => setShowTxForm(!showTxForm)}>
                    {showTxForm ? 'Cancel' : '+ Add Transaction'}
                  </Button>
                </div>
                {showTxForm && (
                  <StockTransactionForm stocks={stocks} onSubmit={handleAddTx} />
                )}
                <TransactionLog
                  transactions={transactions}
                  stocks={stocks}
                  onDelete={handleDeleteTx}
                  onUpdate={handleUpdateTx}
                />
              </div>
            )}

            {activeSection === 'dividends' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                    Dividends
                  </h2>
                  <Button variant="primary" size="sm" onClick={() => setShowDivForm(!showDivForm)}>
                    {showDivForm ? 'Cancel' : '+ Add Dividend'}
                  </Button>
                </div>
                {showDivForm && (
                  <DividendForm stocks={stocks} onSubmit={handleAddDiv} />
                )}
                <DividendLog
                  dividends={dividends}
                  stocks={stocks}
                  onDelete={handleDeleteDiv}
                  onUpdate={handleUpdateDiv}
                />
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
