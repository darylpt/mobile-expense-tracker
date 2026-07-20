-- ============================================================
-- Migration 005: Balance Snapshots Table
--
-- Stores per-account current balance snapshots for the
-- Available Balance reconciliation screen.
-- Synced via the outbox pattern from IndexedDB.
-- ============================================================

CREATE TABLE balance_snapshots (
  id                UUID PRIMARY KEY,
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  value             DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  use_sub_split     BOOLEAN NOT NULL DEFAULT false,
  sub_splits        JSONB DEFAULT '[]'::jsonb,
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ DEFAULT NULL
);

CREATE INDEX idx_balance_snapshots_user_id ON balance_snapshots(user_id);
CREATE INDEX idx_balance_snapshots_account_id ON balance_snapshots(account_id);

CREATE TRIGGER trg_balance_snapshots_lww
  BEFORE UPDATE ON balance_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_older_update();

ALTER TABLE balance_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "balance_snapshots_select" ON balance_snapshots FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "balance_snapshots_insert" ON balance_snapshots FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "balance_snapshots_update" ON balance_snapshots FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "balance_snapshots_delete" ON balance_snapshots FOR DELETE USING (auth.uid() = user_id);
