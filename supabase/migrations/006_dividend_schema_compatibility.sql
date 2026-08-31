-- ============================================================
-- Migration 006: Expanded dividend fields
--
-- Keep the legacy date and amount columns required by existing clients,
-- while adding the expanded local dividend shape used by the stocks UI.
-- ============================================================

ALTER TABLE dividends
  ADD COLUMN IF NOT EXISTS ex_date DATE,
  ADD COLUMN IF NOT EXISTS pay_date DATE,
  ADD COLUMN IF NOT EXISTS qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fee DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dividend_yield DOUBLE PRECISION;

-- Legacy rows have one date; use it for both expanded date fields.
UPDATE dividends
SET
  ex_date = COALESCE(ex_date, date),
  pay_date = COALESCE(pay_date, date),
  updated_at = updated_at + INTERVAL '1 microsecond'
WHERE ex_date IS NULL OR pay_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_dividends_ex_date ON dividends(ex_date);
CREATE INDEX IF NOT EXISTS idx_dividends_pay_date ON dividends(pay_date);
