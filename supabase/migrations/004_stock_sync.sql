-- ============================================================
-- Migration 004: Stock Portfolio Sync Tables
--
-- 3 tables matching the stock portfolio IndexedDB stores.
-- RLS uses user_id with auth.uid() for per-user isolation,
-- unlike the shared-ledger tables in 001_schema.sql.
-- ============================================================

-- ============================================================
-- 1. Stocks
-- ============================================================

CREATE TABLE stocks (
  id                UUID PRIMARY KEY,
  ticker            TEXT NOT NULL,
  type              TEXT CHECK (type IN ('stock', 'fund')),
  name              TEXT NOT NULL,
  current_price     DOUBLE PRECISION,
  price_updated_at  TIMESTAMPTZ,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ DEFAULT NULL
);

CREATE INDEX idx_stocks_user_id ON stocks(user_id);
CREATE INDEX idx_stocks_ticker ON stocks(ticker);

CREATE TRIGGER trg_stocks_lww
  BEFORE UPDATE ON stocks
  FOR EACH ROW EXECUTE FUNCTION prevent_older_update();

ALTER TABLE stocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stocks_select" ON stocks FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "stocks_insert" ON stocks FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "stocks_update" ON stocks FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "stocks_delete" ON stocks FOR DELETE USING (auth.uid() = user_id);

-- ============================================================
-- 2. Stock Transactions
-- ============================================================

CREATE TABLE stock_transactions (
  id                UUID PRIMARY KEY,
  stock_id          UUID NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  date              DATE NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('buy', 'sell')),
  shares            DOUBLE PRECISION NOT NULL,
  price_per_share   DOUBLE PRECISION NOT NULL,
  fees              DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_amount      DOUBLE PRECISION NOT NULL,
  notes             TEXT,
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ DEFAULT NULL
);

CREATE INDEX idx_stock_transactions_user_id ON stock_transactions(user_id);
CREATE INDEX idx_stock_transactions_stock_id ON stock_transactions(stock_id);
CREATE INDEX idx_stock_transactions_date ON stock_transactions(date);

CREATE TRIGGER trg_stock_transactions_lww
  BEFORE UPDATE ON stock_transactions
  FOR EACH ROW EXECUTE FUNCTION prevent_older_update();

ALTER TABLE stock_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stock_transactions_select" ON stock_transactions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "stock_transactions_insert" ON stock_transactions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "stock_transactions_update" ON stock_transactions FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "stock_transactions_delete" ON stock_transactions FOR DELETE USING (auth.uid() = user_id);

-- ============================================================
-- 3. Dividends
-- ============================================================

CREATE TABLE dividends (
  id                UUID PRIMARY KEY,
  stock_id          UUID NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  date              DATE NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('cash', 'stock')),
  amount            DOUBLE PRECISION NOT NULL,
  shares_received   DOUBLE PRECISION,
  notes             TEXT,
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ DEFAULT NULL
);

CREATE INDEX idx_dividends_user_id ON dividends(user_id);
CREATE INDEX idx_dividends_stock_id ON dividends(stock_id);
CREATE INDEX idx_dividends_date ON dividends(date);

CREATE TRIGGER trg_dividends_lww
  BEFORE UPDATE ON dividends
  FOR EACH ROW EXECUTE FUNCTION prevent_older_update();

ALTER TABLE dividends ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dividends_select" ON dividends FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "dividends_insert" ON dividends FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "dividends_update" ON dividends FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "dividends_delete" ON dividends FOR DELETE USING (auth.uid() = user_id);
