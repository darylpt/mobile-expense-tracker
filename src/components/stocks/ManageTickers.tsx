// ============================================================
// ManageTickers — shared stock/fund ticker management component
// Used in Settings (Stocks tab) and Stocks page (inline manage)
// ============================================================

'use client';

import { Input } from '@/components/common/Input';
import { Button } from '@/components/common/Button';
import { useState, useEffect } from 'react';
import type { Stock } from '@/types';

interface ManageTickersProps {
  stocks: Stock[];
  onAdd: (stock: Omit<Stock, 'id' | 'createdAt' | 'updatedAt'>) => Promise<string>;
  onUpdate: (stock: Partial<Stock> & Pick<Stock, 'id'>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onMoveTo: (id: string, targetIndex: number) => Promise<void>;
}

export function ManageTickers({ stocks, onAdd, onUpdate, onDelete, onMoveTo }: ManageTickersProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [deleteWarning, setDeleteWarning] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [pseStocks, setPseStocks] = useState<Array<{ symbol: string; name: string }>>(() => {
    try {
      const cached = localStorage.getItem('pse_stocks_cache');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.ts < 3_600_000) return parsed.data;
      }
    } catch { /* corrupt cache */ }
    return [];
  });
  const [showTickerDropdown, setShowTickerDropdown] = useState(false);

  useEffect(() => {
    let stale = true;
    try {
      const cached = localStorage.getItem('pse_stocks_cache');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.ts < 3_600_000) stale = false;
      }
    } catch { /* corrupt cache */ }
    if (!stale) return;

    fetch('https://phisix-api3.appspot.com/stocks.json')
      .then(r => r.json())
      .then((data: { stock: Array<{ symbol: string; name: string }> }) => {
        const mapped = data.stock.map(s => ({ symbol: s.symbol, name: s.name }));
        setPseStocks(mapped);
        localStorage.setItem('pse_stocks_cache', JSON.stringify({ data: mapped, ts: Date.now() }));
      })
      .catch(() => { /* fetch failed — dropdown won't appear */ });
  }, []);

  const startEdit = (stock: Stock) => {
    setEditingId(stock.id);
    setEditValues({ ticker: stock.ticker, name: stock.name, stockType: stock.type || 'stock' });
    setAddMode(false);
    setDeleteWarning(null);
  };

  const startAdd = () => {
    setAddMode(true);
    setEditingId(null);
    setEditValues({ ticker: '', name: '', stockType: 'stock' });
    setDeleteWarning(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValues({});
  };

  const cancelAdd = () => {
    setAddMode(false);
    setEditValues({});
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    const ticker = editValues.ticker?.trim().toUpperCase();
    const name = editValues.name?.trim();
    const stockType = editValues.stockType || 'stock';
    if (!ticker || !name) return;
    if (stockType === 'fund' ? !/^[A-Z0-9-]{2,20}$/.test(ticker) : !/^[A-Z0-9]{2,8}$/.test(ticker)) {
      setDeleteWarning(stockType === 'fund'
        ? 'Fund ticker must be 2-20 uppercase letters/numbers/dashes (e.g. BPI-EQUITY).'
        : 'Ticker must be 2-8 uppercase letters/numbers (e.g. BDO, SM, JFC).');
      return;
    }
    try {
      await onUpdate({ id: editingId, ticker, name, type: stockType as 'stock' | 'fund' });
      setEditingId(null);
      setEditValues({});
      setDeleteWarning(null);
    } catch {
      setDeleteWarning('Failed to save stock.');
    }
  };

  const handleSaveAdd = async () => {
    const ticker = editValues.ticker?.trim().toUpperCase();
    const name = editValues.name?.trim();
    const stockType = editValues.stockType || 'stock';
    if (!ticker || !name) return;
    if (stockType === 'fund' ? !/^[A-Z0-9-]{2,20}$/.test(ticker) : !/^[A-Z0-9]{2,8}$/.test(ticker)) {
      setDeleteWarning(stockType === 'fund'
        ? 'Fund ticker must be 2-20 uppercase letters/numbers/dashes (e.g. BPI-EQUITY).'
        : 'Ticker must be 2-8 uppercase letters/numbers (e.g. BDO, SM, JFC).');
      return;
    }
    const duplicate = stocks.find(s => s.ticker === ticker);
    if (duplicate) {
      setDeleteWarning(`Ticker "${ticker}" already exists.`);
      return;
    }
    try {
      await onAdd({ ticker, name, currentPrice: null, priceUpdatedAt: null, sortOrder: 0, type: stockType as 'stock' | 'fund' });
      setAddMode(false);
      setEditValues({});
      setDeleteWarning(null);
    } catch {
      setDeleteWarning('Failed to add stock.');
    }
  };

  const handleDelete = async (stock: Stock) => {
    if (!window.confirm(`Delete "${stock.ticker}" and all its transactions and dividends?`)) return;
    try {
      await onDelete(stock.id);
    } catch {
      setDeleteWarning('Failed to delete stock.');
    }
  };

  const handleDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverId(id);
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    setDragOverId(null);
    const draggedId = e.dataTransfer.getData('text/plain');
    if (!draggedId || draggedId === targetId) return;
    const targetIndex = stocks.findIndex(s => s.id === targetId);
    if (targetIndex < 0) return;
    onMoveTo(draggedId, targetIndex);
  };

  const sorted = [...stocks].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const tickerQuery = (editValues.ticker ?? '').toLowerCase();
  const filteredPseStocks = pseStocks.filter(s => s.symbol.toLowerCase().startsWith(tickerQuery)).slice(0, 8);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Stocks</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Manage your stock tickers. Add tickers here, then record buys/sells on the Stocks page.
          </p>
        </div>
        {!addMode && (
          <Button variant="primary" size="sm" onClick={startAdd}>+ Add Ticker</Button>
        )}
      </div>

      {deleteWarning && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">
          {deleteWarning}
        </p>
      )}

      {/* Add form */}
      {addMode && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-900/50 dark:bg-blue-950/30">
          <div className="mb-3">
            <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Type</label>
            <div className="mt-1 flex gap-4">
              <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="stock-type-add"
                  value="stock"
                  checked={editValues.stockType === 'stock' || !editValues.stockType}
                  onChange={() => setEditValues({ ...editValues, stockType: 'stock' })}
                  className="text-blue-600 focus:ring-blue-500"
                />
                <span className="text-zinc-800 dark:text-zinc-200">Stock</span>
              </label>
              <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="stock-type-add"
                  value="fund"
                  checked={editValues.stockType === 'fund'}
                  onChange={() => setEditValues({ ...editValues, stockType: 'fund' })}
                  className="text-blue-600 focus:ring-blue-500"
                />
                <span className="text-zinc-800 dark:text-zinc-200">Fund</span>
              </label>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="relative">
              {editValues.stockType === 'fund' ? (
                <Input
                  value={editValues.ticker ?? ''}
                  onChange={(e) => setEditValues({ ...editValues, ticker: e.target.value.toUpperCase() })}
                  placeholder="Ticker (e.g. BPI-EQUITY)"
                  className="w-36"
                  maxLength={20}
                />
              ) : (
                <>
                  <Input
                    value={editValues.ticker ?? ''}
                    onChange={(e) => setEditValues({ ...editValues, ticker: e.target.value.toUpperCase() })}
                    onFocus={() => setShowTickerDropdown(true)}
                    onBlur={() => setShowTickerDropdown(false)}
                    placeholder="Ticker (e.g. BDO)"
                    className="w-28"
                    maxLength={8}
                  />
                  {showTickerDropdown && (editValues.ticker ?? '').length >= 1 && !editValues.name && (
                    <div className="absolute left-0 top-full z-10 mt-1 w-72 rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-600 dark:bg-zinc-800">
                      {filteredPseStocks.length === 0 ? (
                        <div className="px-3 py-2 text-sm text-zinc-400">No ticker found</div>
                      ) : (
                        <div className="max-h-64 divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-700">
                          {filteredPseStocks.map(s => (
                            <button
                              key={s.symbol}
                              type="button"
                              className="flex min-h-[40px] w-full items-center px-3 py-2 text-left text-sm hover:bg-blue-50 dark:hover:bg-blue-900/20"
                              onMouseDown={e => e.preventDefault()}
                              onClick={() => {
                                setEditValues({ ...editValues, ticker: s.symbol, name: s.name });
                                setShowTickerDropdown(false);
                              }}
                            >
                              <span className="font-semibold text-zinc-900 dark:text-zinc-100">{s.symbol}</span>
                              <span className="ml-1 text-zinc-500 dark:text-zinc-400">— {s.name}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
            <Input
              value={editValues.name ?? ''}
              onChange={(e) => setEditValues({ ...editValues, name: e.target.value })}
              placeholder="Company or fund name"
              className="flex-1"
            />
            <Button variant="primary" size="sm" onClick={handleSaveAdd}>Save</Button>
            <Button variant="ghost" size="sm" onClick={cancelAdd}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Stock list */}
      {sorted.length === 0 && !addMode ? (
        <p className="py-6 text-center text-sm text-zinc-400 dark:text-zinc-500">
          No stocks yet. Add your first ticker above.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-800/50">
          <div className="divide-y divide-zinc-100 dark:divide-zinc-700">
            {sorted.map((stock) => (
              <div
                key={stock.id}
                draggable
                onDragStart={(e) => handleDragStart(e, stock.id)}
                onDragOver={(e) => handleDragOver(e, stock.id)}
                onDrop={(e) => handleDrop(e, stock.id)}
                className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                  dragOverId === stock.id ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                } ${editingId === stock.id ? 'bg-amber-50 dark:bg-amber-900/10' : ''}`}
              >
                <span className="cursor-grab text-zinc-300 dark:text-zinc-600 select-none">⠿</span>

                {editingId === stock.id ? (
                  <>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1 text-xs cursor-pointer">
                        <input
                          type="radio"
                          name="stock-type-edit"
                          value="stock"
                          checked={editValues.stockType === 'stock' || !editValues.stockType}
                          onChange={() => setEditValues({ ...editValues, stockType: 'stock' })}
                          className="text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-zinc-600 dark:text-zinc-400">Stock</span>
                      </label>
                      <label className="flex items-center gap-1 text-xs cursor-pointer">
                        <input
                          type="radio"
                          name="stock-type-edit"
                          value="fund"
                          checked={editValues.stockType === 'fund'}
                          onChange={() => setEditValues({ ...editValues, stockType: 'fund' })}
                          className="text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-zinc-600 dark:text-zinc-400">Fund</span>
                      </label>
                    </div>
                    <Input
                      value={editValues.ticker ?? stock.ticker}
                      onChange={(e) => setEditValues({ ...editValues, ticker: e.target.value.toUpperCase() })}
                      className="w-24"
                      maxLength={editValues.stockType === 'fund' ? 20 : 8}
                    />
                    <Input
                      value={editValues.name ?? stock.name}
                      onChange={(e) => setEditValues({ ...editValues, name: e.target.value })}
                      className="flex-1"
                    />
                    <Button variant="primary" size="sm" onClick={handleSaveEdit}>Save</Button>
                    <Button variant="ghost" size="sm" onClick={cancelEdit}>Cancel</Button>
                  </>
                ) : (
                  <>
                    <span className="w-20 shrink-0 rounded bg-zinc-100 px-2 py-0.5 text-center font-mono text-sm font-semibold text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300">
                      {stock.ticker}
                    </span>
                    <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                      (stock.type ?? 'stock') === 'fund'
                        ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
                        : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                    }`}>
                      {stock.type ?? 'stock'}
                    </span>
                    <span className="flex-1 text-sm text-zinc-900 dark:text-zinc-100">{stock.name}</span>
                    {stock.currentPrice !== null && (
                      <span className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                        ₱{stock.currentPrice.toFixed(2)}
                      </span>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => startEdit(stock)}>Edit</Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(stock)}>✕</Button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
