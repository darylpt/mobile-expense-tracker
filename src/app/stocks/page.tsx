'use client';

import React, { useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/common/Button';
import { HoldingsTable } from '@/components/stocks/HoldingsTable';
import { TransactionLog } from '@/components/stocks/TransactionLog';
import { DividendLog } from '@/components/stocks/DividendLog';
import { StockTransactionForm } from '@/components/forms/StockTransactionForm';
import { DividendForm } from '@/components/forms/DividendForm';
import { PortfolioSummaryCard } from '@/components/summary/PortfolioSummaryCard';
import { useStocks } from '@/hooks/useStocks';
import { useTransactionContext } from '@/context/TransactionContext';
import { useAuth } from '@/context/AuthContext';
import { getAuthGeneration } from '@/lib/auth-scope';
import { getAllStockTransactions, addStockTransaction, deleteStockTransaction, updateStockTransaction } from '@/lib/idb';
import { getAllDividends, addDividend, deleteDividend, updateDividend } from '@/lib/idb';
import { refreshAllPrices } from '@/lib/stock-prices';
import { computeHoldings, type HoldingsResult } from '@/lib/holdings';
import { ManageTickers } from '@/components/stocks/ManageTickers';
import { formatCurrency } from '@/lib/utils';
import type { StockTransaction, Dividend } from '@/types';

type Section = 'holdings' | 'transactions' | 'dividends';

/** Identity of one page scope instance. Shape is irrelevant; only identity is. */
interface StocksPageScopeToken {
  readonly kind: 'stocks-page-scope';
}

interface StocksPageBucket {
  /** Auth descriptor this bucket belongs to. */
  readonly key: string;
  /** Unique per scope instance; never reused across transitions. */
  readonly token: StocksPageScopeToken;
  readonly transactions: StockTransaction[];
  readonly dividends: Dividend[];
  readonly holdings: HoldingsResult | null;
  readonly isLoading: boolean;
  readonly refreshing: boolean;
  /** Ticker-bearing copy result; never survives a scope transition. */
  readonly priceMsg: string | null;
}

type StocksPagePatch = Partial<
  Pick<
    StocksPageBucket,
    'transactions' | 'dividends' | 'holdings' | 'isLoading' | 'refreshing' | 'priceMsg'
  >
>;

/**
 * True only while work captured under `token`/`generation` is still the live
 * scope. Every async continuation and retained callback shares this fence.
 */
function isScopeCurrent(
  token: StocksPageScopeToken,
  generation: number,
  liveToken: StocksPageScopeToken,
): boolean {
  return getAuthGeneration() === generation && liveToken === token;
}

export default function StocksPage() {
  const { stocks, isLoading: stocksLoading, refreshStocks, addStock, updateStock, deleteStock, moveStockTo } = useStocks();
  const { isScopeVerified } = useTransactionContext();
  const { state: authState, user, authGeneration = 0 } = useAuth();
  const [activeSection, setActiveSection] = useState<Section>('holdings');
  const [showTxForm, setShowTxForm] = useState(false);
  const [showDivForm, setShowDivForm] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const userId = user?.id ?? '';
  // IndexedDB is readable only once the provider verified local ownership.
  // Disabled (no Supabase) mode is local-only, so verification alone owns it.
  const canReadLocalData =
    isScopeVerified &&
    (authState === 'disabled' ||
      (authState === 'authenticated' && userId !== ''));

  // Identity + ownership descriptor for this render. Generation advances on
  // every identity transition; the marker distinguishes verification flips.
  const scopeKey = `${authState}\u0000${userId}\u0000${authGeneration}\u0000${
    isScopeVerified ? 'verified' : 'locked'
  }`;

  const [bucketState, setBucketState] = useState<StocksPageBucket>(() => ({
    key: scopeKey,
    token: { kind: 'stocks-page-scope' },
    transactions: [],
    dividends: [],
    holdings: null,
    isLoading: canReadLocalData,
    refreshing: false,
    priceMsg: null,
  }));

  // Descriptor change: reset during render and return the safe empty/locked
  // bucket for this very render. No previous-scope row, loading flag, or
  // ticker message is ever observable, even before the passive load effect
  // runs. A fresh token means old continuations cannot regain authority if
  // the descriptor later becomes equal again (A verified -> locked -> A
  // verified).
  let bucket = bucketState;
  if (bucketState.key !== scopeKey) {
    bucket = {
      key: scopeKey,
      token: { kind: 'stocks-page-scope' },
      transactions: [],
      dividends: [],
      holdings: null,
      isLoading: canReadLocalData,
      refreshing: false,
      priceMsg: null,
    };
    setBucketState(bucket);
  }
  const scopeToken = bucket.token;
  const { transactions, dividends, holdings, priceMsg } = bucket;

  // Latest committed scope token, readable from async continuations.
  const scopeTokenRef = useRef(scopeToken);
  useLayoutEffect(() => {
    scopeTokenRef.current = scopeToken;
  }, [scopeToken]);

  // A publication is applied only while its bucket is still the live one.
  const updateBucket = useCallback(
    (token: StocksPageScopeToken, patch: StocksPagePatch) => {
      setBucketState((previous) =>
        previous.token === token ? { ...previous, ...patch } : previous,
      );
    },
    [],
  );

  // ponytail: load initial data once stocks are ready. No local read starts
  // while the scope is locked or the stocks hook is still loading.
  useEffect(() => {
    if (!canReadLocalData || stocksLoading) return;

    const token = scopeToken;
    const generation = authGeneration;
    let cancelled = false;
    const isCurrent = () =>
      !cancelled &&
      mountedRef.current &&
      isScopeCurrent(token, generation, scopeTokenRef.current);

    Promise.all([getAllStockTransactions(), getAllDividends()])
      .then(([txs, divs]) => {
        if (!isCurrent()) return;
        updateBucket(token, {
          transactions: txs,
          dividends: divs,
          holdings: computeHoldings(stocks, txs, divs),
          isLoading: false,
        });
      })
      .catch(() => {
        if (!isCurrent()) return;
        updateBucket(token, { isLoading: false });
      });

    return () => {
      cancelled = true;
    };
  }, [stocksLoading, stocks, canReadLocalData, scopeToken, authGeneration, updateBucket]);

  const reloadData = useCallback(async () => {
    if (!canReadLocalData) return;

    const token = scopeToken;
    const generation = authGeneration;
    const isCurrent = () =>
      mountedRef.current &&
      isScopeCurrent(token, generation, scopeTokenRef.current);
    if (!isCurrent()) return;

    const [txs, divs] = await Promise.all([
      getAllStockTransactions(),
      getAllDividends(),
    ]);
    if (!isCurrent()) return;
    updateBucket(token, {
      transactions: txs,
      dividends: divs,
      holdings: computeHoldings(stocks, txs, divs),
    });
  }, [stocks, canReadLocalData, scopeToken, authGeneration, updateBucket]);

  // Reload from IDB after a background sync pulls fresh remote data. The
  // retained handler is fenced so a transition that has not rerendered yet
  // still cannot read or publish for the old scope.
  useEffect(() => {
    const handler = () => {
      if (!canReadLocalData) return;
      if (!isScopeCurrent(scopeToken, authGeneration, scopeTokenRef.current)) {
        return;
      }
      refreshStocks();
      reloadData();
    };
    window.addEventListener('sync-complete', handler);
    return () => window.removeEventListener('sync-complete', handler);
  }, [refreshStocks, reloadData, canReadLocalData, scopeToken, authGeneration]);


  const handleRefreshPrices = async () => {
    if (!canReadLocalData) return;
    const token = scopeToken;
    const generation = authGeneration;
    const isCurrent = () =>
      mountedRef.current &&
      isScopeCurrent(token, generation, scopeTokenRef.current);
    if (!isCurrent()) return;

    updateBucket(token, { refreshing: true, priceMsg: null });
    try {
      const results = await refreshAllPrices(isCurrent);
      if (!isCurrent()) return;
      const failed = results.filter(r => r.price === null);
      let message: string;
      if (results.length === 0) {
        message = 'No stocks to refresh. Add a stock first.';
      } else if (failed.length === results.length) {
        message = 'Could not fetch any prices. Check your connection or try again later.';
      } else if (failed.length > 0) {
        message = `Prices updated, but ${failed.length} ticker(s) failed: ${failed.map(f => f.ticker).join(', ')}`;
      } else {
        message = 'All prices updated.';
      }
      updateBucket(token, { priceMsg: message });
      await refreshStocks();
      if (!isCurrent()) return;
      await reloadData();
    } catch {
      if (isCurrent()) updateBucket(token, { priceMsg: 'Price refresh failed.' });
    } finally {
      if (isCurrent()) updateBucket(token, { refreshing: false });
    }
  };

  const handleAddTx = async (tx: Omit<StockTransaction, 'id' | 'createdAt' | 'updatedAt'>) => {
    if (!canReadLocalData) return;
    const token = scopeToken;
    const generation = authGeneration;
    const isCurrent = () =>
      mountedRef.current &&
      isScopeCurrent(token, generation, scopeTokenRef.current);
    if (!isCurrent()) return;
    await addStockTransaction(tx);
    if (!isCurrent()) return;
    setShowTxForm(false);
    await reloadData();
  };

  const handleDeleteTx = async (id: string) => {
    if (!canReadLocalData || !window.confirm('Delete this transaction?')) return;
    const token = scopeToken;
    const generation = authGeneration;
    const isCurrent = () =>
      mountedRef.current &&
      isScopeCurrent(token, generation, scopeTokenRef.current);
    if (!isCurrent()) return;
    await deleteStockTransaction(id);
    if (!isCurrent()) return;
    await reloadData();
  };

  const handleAddDiv = async (d: Omit<Dividend, 'id' | 'createdAt' | 'updatedAt'>) => {
    if (!canReadLocalData) return;
    const token = scopeToken;
    const generation = authGeneration;
    const isCurrent = () =>
      mountedRef.current &&
      isScopeCurrent(token, generation, scopeTokenRef.current);
    if (!isCurrent()) return;
    await addDividend(d);
    if (!isCurrent()) return;
    setShowDivForm(false);
    await reloadData();
  };

  const handleDeleteDiv = async (id: string) => {
    if (!canReadLocalData || !window.confirm('Delete this dividend record?')) return;
    const token = scopeToken;
    const generation = authGeneration;
    const isCurrent = () =>
      mountedRef.current &&
      isScopeCurrent(token, generation, scopeTokenRef.current);
    if (!isCurrent()) return;
    await deleteDividend(id);
    if (!isCurrent()) return;
    await reloadData();
  };

  const handleUpdateTx = async (id: string, updates: Partial<StockTransaction>) => {
    if (!canReadLocalData) return;
    const token = scopeToken;
    const generation = authGeneration;
    const isCurrent = () =>
      mountedRef.current &&
      isScopeCurrent(token, generation, scopeTokenRef.current);
    if (!isCurrent()) return;
    await updateStockTransaction(id, updates);
    if (!isCurrent()) return;
    await reloadData();
  };

  const handleUpdateDiv = async (id: string, updates: Partial<Dividend>) => {
    if (!canReadLocalData) return;
    const token = scopeToken;
    const generation = authGeneration;
    const isCurrent = () =>
      mountedRef.current &&
      isScopeCurrent(token, generation, scopeTokenRef.current);
    if (!isCurrent()) return;
    await updateDividend(id, updates);
    if (!isCurrent()) return;
    await reloadData();
  };

  const isLoading = stocksLoading || bucket.isLoading;
  const hasStocks = stocks.length > 0;


  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <Header title="Stocks" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-20 pt-6 sm:px-6 sm:pb-0 sm:pt-8">
        {isLoading || !canReadLocalData ? (
          <div className="py-12 text-center text-sm text-zinc-600 dark:text-zinc-400">Loading…</div>
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
                disabled={bucket.refreshing}
                isLoading={bucket.refreshing}
              >
                {bucket.refreshing ? 'Refreshing…' : 'Refresh Prices'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowManage(!showManage)}>
                {showManage ? 'Close' : 'Manage Tickers'}
              </Button>
              <button
                onClick={() => {
                  if (!holdings || !canReadLocalData) return;
                  const token = scopeToken;
                  const generation = authGeneration;
                  const isCurrent = () =>
                    mountedRef.current &&
                    isScopeCurrent(token, generation, scopeTokenRef.current);
                  if (!isCurrent()) return;
                  const lines: string[] = [
                    `My Portfolio (as of ${new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' })})`,
                    '',
                    ...holdings.holdings.map(h => {
                      const gl = h.unrealizedGainLoss;
                      const glPct = h.unrealizedGainLossPct;
                      const glStr = gl !== null
                        ? `${gl >= 0 ? '+' : ''}${formatCurrency(gl)}${glPct !== null ? ` (${glPct >= 0 ? '+' : ''}${glPct.toFixed(2)}%)` : ''}`
                        : '—';
                      const val = h.marketValue !== null ? formatCurrency(h.marketValue) : '—';
                      const hStock = stocks.find(s => s.id === h.stockId);
                      const typeLabel = hStock?.type === 'fund' ? ' [Fund]' : '';
                      return `${h.ticker}${typeLabel}  ${h.shares.toFixed(2)} shs  @ ${formatCurrency(h.avgCostPerShare)}  = ${val}  ${glStr}`;
                    }),
                    '',
                    `Total Invested:      ${formatCurrency(holdings.totalCost)}`,
                    `Total Market Value:  ${holdings.totalMarketValue !== null ? formatCurrency(holdings.totalMarketValue) : '—'}`,
                    `Total Unrealized G/L: ${holdings.totalUnrealizedGainLoss !== null ? formatCurrency(holdings.totalUnrealizedGainLoss) : '—'}`,
                    `Total Dividends:     ${formatCurrency(holdings.totalDividends)}`,
                    `Total Realized G/L:  ${formatCurrency(holdings.totalRealizedGainLoss)}`,
                  ];
                  navigator.clipboard.writeText(lines.join('\n')).then(() => {
                    if (isCurrent()) {
                      updateBucket(token, { priceMsg: 'Portfolio summary copied!' });
                    }
                  }).catch(() => {
                    if (isCurrent()) {
                      updateBucket(token, { priceMsg: 'Failed to copy' });
                    }
                  });
                }}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                title="Copy portfolio summary as text for your AI assistant"
              >
                📋 Copy Summary
              </button>
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
            <PortfolioSummaryCard holdings={holdings} />

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
