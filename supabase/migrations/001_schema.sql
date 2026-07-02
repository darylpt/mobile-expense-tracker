-- ============================================================
-- Migration 001: Local-First Sync Schema
-- 
-- 6 tables matching the IndexedDB stores, each with:
--   - UUID primary keys (matching front-end crypto.randomUUID())
--   - deleted_at for soft-delete sync (ghost-record prevention)
--   - updated_at for Last-Writer-Wins conflict resolution
-- 
-- LWW trigger: BEFORE UPDATE silently skips rows where the
-- incoming updated_at is older than the existing row.
-- ============================================================

-- ============================================================
-- 1. LWW Trigger Function (applied to all tables)
-- ============================================================

CREATE OR REPLACE FUNCTION prevent_older_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- If incoming row's updated_at <= existing row's updated_at, skip update
  IF NEW.updated_at <= OLD.updated_at THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================
-- 2. Accounts
-- ============================================================

CREATE TABLE accounts (
  id               UUID PRIMARY KEY,
  name             TEXT NOT NULL,
  starting_balance DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ DEFAULT NULL
);

CREATE TRIGGER trg_accounts_lww
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION prevent_older_update();

-- ============================================================
-- 3. Categories
-- ============================================================

CREATE TABLE categories (
  id         UUID PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('income', 'expense', 'transaction')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ DEFAULT NULL
);

CREATE TRIGGER trg_categories_lww
  BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION prevent_older_update();

-- ============================================================
-- 4. Transactions
-- ============================================================

CREATE TABLE transactions (
  id           UUID PRIMARY KEY,
  amount       DOUBLE PRECISION NOT NULL,
  date         DATE NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('income', 'expense', 'transaction')),
  category     TEXT NOT NULL,
  from_account UUID REFERENCES accounts(id) ON DELETE SET NULL,
  to_account   UUID REFERENCES accounts(id) ON DELETE SET NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ DEFAULT NULL
);

CREATE INDEX idx_transactions_date ON transactions(date);
CREATE INDEX idx_transactions_type ON transactions(type);

CREATE TRIGGER trg_transactions_lww
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION prevent_older_update();

-- ============================================================
-- 5. Cash Denominations
-- ============================================================

CREATE TABLE cash_denominations (
  id            UUID PRIMARY KEY,
  date          DATE NOT NULL,
  denomination  DOUBLE PRECISION NOT NULL,
  count         INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ DEFAULT NULL
  -- NOTE: no updated_at — cash snapshots are write-once; no LWW trigger needed
);

-- ============================================================
-- 6. Payouts
-- ============================================================

CREATE TABLE payouts (
  id                UUID PRIMARY KEY,
  date              DATE NOT NULL,
  total_amount      DOUBLE PRECISION NOT NULL,
  split_mode        TEXT NOT NULL CHECK (split_mode IN ('amount', 'percentage')),
  splits            JSONB NOT NULL DEFAULT '[]',
  savings_sub_split JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ DEFAULT NULL
);

CREATE TRIGGER trg_payouts_lww
  BEFORE UPDATE ON payouts
  FOR EACH ROW EXECUTE FUNCTION prevent_older_update();

-- ============================================================
-- 7. Budget Targets
-- ============================================================

CREATE TABLE budget_targets (
  id         UUID PRIMARY KEY,
  category   TEXT NOT NULL,
  month      TEXT,  -- "YYYY-MM" or NULL for global default
  amount     DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ DEFAULT NULL
);

CREATE INDEX idx_budget_targets_category ON budget_targets(category);

CREATE TRIGGER trg_budget_targets_lww
  BEFORE UPDATE ON budget_targets
  FOR EACH ROW EXECUTE FUNCTION prevent_older_update();

-- ============================================================
-- 8. Row-Level Security (Shared Ledger)
-- ============================================================
-- Exactly 2 authenticated users share all data equally.
-- RLS simply gates on auth.role() — no user_id filtering.
-- ============================================================

-- Enable RLS
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_denominations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_targets ENABLE ROW LEVEL SECURITY;

-- Accounts
CREATE POLICY "accounts_select" ON accounts FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "accounts_insert" ON accounts FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "accounts_update" ON accounts FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "accounts_delete" ON accounts FOR DELETE USING (auth.role() = 'authenticated');

-- Categories
CREATE POLICY "categories_select" ON categories FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "categories_insert" ON categories FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "categories_update" ON categories FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "categories_delete" ON categories FOR DELETE USING (auth.role() = 'authenticated');

-- Transactions
CREATE POLICY "transactions_select" ON transactions FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "transactions_insert" ON transactions FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "transactions_update" ON transactions FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "transactions_delete" ON transactions FOR DELETE USING (auth.role() = 'authenticated');

-- Cash Denominations
CREATE POLICY "cash_denominations_select" ON cash_denominations FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "cash_denominations_insert" ON cash_denominations FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "cash_denominations_update" ON cash_denominations FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "cash_denominations_delete" ON cash_denominations FOR DELETE USING (auth.role() = 'authenticated');

-- Payouts
CREATE POLICY "payouts_select" ON payouts FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "payouts_insert" ON payouts FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "payouts_update" ON payouts FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "payouts_delete" ON payouts FOR DELETE USING (auth.role() = 'authenticated');

-- Budget Targets
CREATE POLICY "budget_targets_select" ON budget_targets FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "budget_targets_insert" ON budget_targets FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "budget_targets_update" ON budget_targets FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "budget_targets_delete" ON budget_targets FOR DELETE USING (auth.role() = 'authenticated');
