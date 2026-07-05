-- ============================================================
-- Migration 002: User Data Isolation
--
-- 1. TRUNCATE all 6 data tables (wipes shared data)
-- 2. ADD COLUMN user_id UUID NOT NULL on each
-- 3. Index each table on user_id
-- 4. Drop old auth.role()-based RLS policies
-- 5. Create per-user RLS policies (auth.uid() = user_id)
-- ============================================================

-- ============================================================
-- 1. TRUNCATE — wipe existing shared data
-- Order respects foreign keys: transactions first, then accounts
-- ============================================================

TRUNCATE TABLE transactions CASCADE;
TRUNCATE TABLE cash_denominations CASCADE;
TRUNCATE TABLE payouts CASCADE;
TRUNCATE TABLE budget_targets CASCADE;
TRUNCATE TABLE categories CASCADE;
TRUNCATE TABLE accounts CASCADE;

-- ============================================================
-- 2. ADD COLUMN user_id on each table
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE categories
  ADD COLUMN user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE transactions
  ADD COLUMN user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE cash_denominations
  ADD COLUMN user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE payouts
  ADD COLUMN user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE budget_targets
  ADD COLUMN user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;

-- ============================================================
-- 3. Index each table on user_id
-- ============================================================

CREATE INDEX idx_accounts_user_id ON accounts(user_id);
CREATE INDEX idx_categories_user_id ON categories(user_id);
CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_cash_denominations_user_id ON cash_denominations(user_id);
CREATE INDEX idx_payouts_user_id ON payouts(user_id);
CREATE INDEX idx_budget_targets_user_id ON budget_targets(user_id);

-- ============================================================
-- 4. Drop old auth.role()-based policies
-- ============================================================

DROP POLICY IF EXISTS "accounts_select" ON accounts;
DROP POLICY IF EXISTS "accounts_insert" ON accounts;
DROP POLICY IF EXISTS "accounts_update" ON accounts;
DROP POLICY IF EXISTS "accounts_delete" ON accounts;

DROP POLICY IF EXISTS "categories_select" ON categories;
DROP POLICY IF EXISTS "categories_insert" ON categories;
DROP POLICY IF EXISTS "categories_update" ON categories;
DROP POLICY IF EXISTS "categories_delete" ON categories;

DROP POLICY IF EXISTS "transactions_select" ON transactions;
DROP POLICY IF EXISTS "transactions_insert" ON transactions;
DROP POLICY IF EXISTS "transactions_update" ON transactions;
DROP POLICY IF EXISTS "transactions_delete" ON transactions;

DROP POLICY IF EXISTS "cash_denominations_select" ON cash_denominations;
DROP POLICY IF EXISTS "cash_denominations_insert" ON cash_denominations;
DROP POLICY IF EXISTS "cash_denominations_update" ON cash_denominations;
DROP POLICY IF EXISTS "cash_denominations_delete" ON cash_denominations;

DROP POLICY IF EXISTS "payouts_select" ON payouts;
DROP POLICY IF EXISTS "payouts_insert" ON payouts;
DROP POLICY IF EXISTS "payouts_update" ON payouts;
DROP POLICY IF EXISTS "payouts_delete" ON payouts;

DROP POLICY IF EXISTS "budget_targets_select" ON budget_targets;
DROP POLICY IF EXISTS "budget_targets_insert" ON budget_targets;
DROP POLICY IF EXISTS "budget_targets_update" ON budget_targets;
DROP POLICY IF EXISTS "budget_targets_delete" ON budget_targets;

-- ============================================================
-- 5. Create per-user RLS policies
-- ============================================================

-- Accounts
CREATE POLICY "accounts_select" ON accounts
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "accounts_insert" ON accounts
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "accounts_update" ON accounts
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "accounts_delete" ON accounts
  FOR DELETE USING (auth.uid() = user_id);

-- Categories
CREATE POLICY "categories_select" ON categories
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "categories_insert" ON categories
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "categories_update" ON categories
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "categories_delete" ON categories
  FOR DELETE USING (auth.uid() = user_id);

-- Transactions
CREATE POLICY "transactions_select" ON transactions
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "transactions_insert" ON transactions
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "transactions_update" ON transactions
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "transactions_delete" ON transactions
  FOR DELETE USING (auth.uid() = user_id);

-- Cash Denominations
CREATE POLICY "cash_denominations_select" ON cash_denominations
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "cash_denominations_insert" ON cash_denominations
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "cash_denominations_update" ON cash_denominations
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "cash_denominations_delete" ON cash_denominations
  FOR DELETE USING (auth.uid() = user_id);

-- Payouts
CREATE POLICY "payouts_select" ON payouts
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "payouts_insert" ON payouts
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "payouts_update" ON payouts
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "payouts_delete" ON payouts
  FOR DELETE USING (auth.uid() = user_id);

-- Budget Targets
CREATE POLICY "budget_targets_select" ON budget_targets
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "budget_targets_insert" ON budget_targets
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "budget_targets_update" ON budget_targets
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "budget_targets_delete" ON budget_targets
  FOR DELETE USING (auth.uid() = user_id);
