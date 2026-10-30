-- ============================================================
-- Migration 007: Dataset replacement generations and write fence
--
-- CSV import replaces the six managed ledger tables as one snapshot.
-- A per-user generation makes that replacement authoritative:
--
--   1. dataset_generations holds the current generation per user.
--   2. Each managed row carries dataset_generation.
--   3. A trigger silently drops writes from an older generation, so a
--      queued or in-flight write from before a replacement cannot
--      resurrect superseded rows.
--   4. replace_user_dataset() applies a whole snapshot atomically:
--      it soft-deletes rows missing from the snapshot (never hard
--      deletes), upserts the snapshot rows, and bumps the generation.
--
-- Idempotent retry: the RPC records the snapshot UUID. Replaying the
-- same snapshot returns the already-applied generation and writes
-- nothing. A different snapshot at an equal or older generation is
-- reported as a conflict, which the client surfaces to the user.
--
-- balance_snapshots is intentionally untouched. Accounts are only
-- soft-deleted, so the existing ON DELETE CASCADE never fires.
-- ============================================================

CREATE TABLE dataset_generations (
  user_id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  generation       BIGINT NOT NULL DEFAULT 0,
  last_snapshot_id UUID,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE dataset_generations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dataset_generations_select" ON dataset_generations
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "dataset_generations_insert" ON dataset_generations;
DROP POLICY IF EXISTS "dataset_generations_update" ON dataset_generations;

ALTER TABLE accounts
  ADD COLUMN dataset_generation BIGINT NOT NULL DEFAULT 0;
ALTER TABLE categories
  ADD COLUMN dataset_generation BIGINT NOT NULL DEFAULT 0;
ALTER TABLE transactions
  ADD COLUMN dataset_generation BIGINT NOT NULL DEFAULT 0;
ALTER TABLE cash_denominations
  ADD COLUMN dataset_generation BIGINT NOT NULL DEFAULT 0;
ALTER TABLE payouts
  ADD COLUMN dataset_generation BIGINT NOT NULL DEFAULT 0;
ALTER TABLE budget_targets
  ADD COLUMN dataset_generation BIGINT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION enforce_dataset_generation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  current_generation BIGINT;
BEGIN
  SELECT generation INTO current_generation
  FROM dataset_generations
  WHERE user_id = NEW.user_id;

  IF current_generation IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.dataset_generation IS DISTINCT FROM current_generation THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_accounts_dataset_fence
  BEFORE INSERT OR UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION enforce_dataset_generation();
CREATE TRIGGER trg_categories_dataset_fence
  BEFORE INSERT OR UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION enforce_dataset_generation();
CREATE TRIGGER trg_transactions_dataset_fence
  BEFORE INSERT OR UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION enforce_dataset_generation();
CREATE TRIGGER trg_cash_denominations_dataset_fence
  BEFORE INSERT OR UPDATE ON cash_denominations
  FOR EACH ROW EXECUTE FUNCTION enforce_dataset_generation();
CREATE TRIGGER trg_payouts_dataset_fence
  BEFORE INSERT OR UPDATE ON payouts
  FOR EACH ROW EXECUTE FUNCTION enforce_dataset_generation();
CREATE TRIGGER trg_budget_targets_dataset_fence
  BEFORE INSERT OR UPDATE ON budget_targets
  FOR EACH ROW EXECUTE FUNCTION enforce_dataset_generation();

-- PostgREST upserts only SET columns present in the payload, so an old client
-- that omits dataset_generation keeps the OLD value on conflict. An exact-match
-- trigger alone cannot distinguish that from a current client. Authenticated
-- clients therefore read managed rows directly but write only through
-- apply_managed_write() or replace_user_dataset(), which require the generation.
DROP POLICY IF EXISTS "accounts_insert" ON accounts;
DROP POLICY IF EXISTS "accounts_update" ON accounts;
DROP POLICY IF EXISTS "accounts_delete" ON accounts;
DROP POLICY IF EXISTS "categories_insert" ON categories;
DROP POLICY IF EXISTS "categories_update" ON categories;
DROP POLICY IF EXISTS "categories_delete" ON categories;
DROP POLICY IF EXISTS "transactions_insert" ON transactions;
DROP POLICY IF EXISTS "transactions_update" ON transactions;
DROP POLICY IF EXISTS "transactions_delete" ON transactions;
DROP POLICY IF EXISTS "cash_denominations_insert" ON cash_denominations;
DROP POLICY IF EXISTS "cash_denominations_update" ON cash_denominations;
DROP POLICY IF EXISTS "cash_denominations_delete" ON cash_denominations;
DROP POLICY IF EXISTS "payouts_insert" ON payouts;
DROP POLICY IF EXISTS "payouts_update" ON payouts;
DROP POLICY IF EXISTS "payouts_delete" ON payouts;
DROP POLICY IF EXISTS "budget_targets_insert" ON budget_targets;
DROP POLICY IF EXISTS "budget_targets_update" ON budget_targets;
DROP POLICY IF EXISTS "budget_targets_delete" ON budget_targets;

CREATE OR REPLACE FUNCTION apply_managed_write(
  p_generation BIGINT,
  p_store TEXT,
  p_operation TEXT,
  p_record_id UUID,
  p_record JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_current BIGINT;
  r JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'apply_managed_write requires an authenticated user';
  END IF;
  IF p_generation IS NULL OR p_operation NOT IN ('create', 'update', 'delete') THEN
    RAISE EXCEPTION 'apply_managed_write requires a generation and a valid operation';
  END IF;
  IF p_store NOT IN (
    'accounts', 'categories', 'transactions', 'cash_denominations',
    'payouts', 'budget_targets'
  ) THEN
    RAISE EXCEPTION 'apply_managed_write does not manage store %', p_store;
  END IF;

  -- Lock a real row even before the first replacement has created it, so a
  -- first write and a first replacement serialize: writer-first makes the
  -- replacement follow, replacement-first makes this writer return conflict.
  INSERT INTO dataset_generations (user_id, generation)
  VALUES (v_user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT generation INTO v_current
  FROM dataset_generations
  WHERE user_id = v_user_id
  FOR UPDATE;

  IF v_current IS NULL THEN
    v_current := 0;
  END IF;

  IF p_generation IS DISTINCT FROM v_current THEN
    RETURN jsonb_build_object('status', 'conflict', 'generation', v_current);
  END IF;

  IF p_operation = 'delete' THEN
    IF p_store = 'accounts' THEN
      UPDATE accounts SET deleted_at = clock_timestamp(),
        updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond'),
        dataset_generation = p_generation
      WHERE id = p_record_id AND user_id = v_user_id;
    ELSIF p_store = 'categories' THEN
      UPDATE categories SET deleted_at = clock_timestamp(),
        updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond'),
        dataset_generation = p_generation
      WHERE id = p_record_id AND user_id = v_user_id;
    ELSIF p_store = 'transactions' THEN
      UPDATE transactions SET deleted_at = clock_timestamp(),
        updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond'),
        dataset_generation = p_generation
      WHERE id = p_record_id AND user_id = v_user_id;
    ELSIF p_store = 'cash_denominations' THEN
      UPDATE cash_denominations SET deleted_at = clock_timestamp(),
        dataset_generation = p_generation
      WHERE id = p_record_id AND user_id = v_user_id;
    ELSIF p_store = 'payouts' THEN
      UPDATE payouts SET deleted_at = clock_timestamp(),
        updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond'),
        dataset_generation = p_generation
      WHERE id = p_record_id AND user_id = v_user_id;
    ELSE
      UPDATE budget_targets SET deleted_at = clock_timestamp(),
        updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond'),
        dataset_generation = p_generation
      WHERE id = p_record_id AND user_id = v_user_id;
    END IF;
    RETURN jsonb_build_object('status', 'applied', 'generation', p_generation);
  END IF;

  -- Creates and updates carry the client's record timestamp. The upsert below
  -- writes that timestamp instead of server time so the LWW trigger sees the
  -- real ordering and skips a queued change older than the stored row;
  -- clock_timestamp() is only the fallback when the record has no updated_at.
  -- Server time here would always beat OLD.updated_at and let stale queued
  -- changes overwrite newer records.
  r := COALESCE(p_record, '{}'::jsonb) || jsonb_build_object(
    'id', p_record_id,
    'user_id', v_user_id,
    'dataset_generation', p_generation,
    'deleted_at', NULL
  );

  IF p_store = 'accounts' THEN
    INSERT INTO accounts (
      id, name, starting_balance, sort_order, created_at, updated_at,
      deleted_at, user_id, dataset_generation
    )
    SELECT x.id, x.name, COALESCE(x.starting_balance, 0), x.sort_order,
      COALESCE(x.created_at, clock_timestamp()), COALESCE(x.updated_at, clock_timestamp()),
      NULL, v_user_id, p_generation
    FROM jsonb_populate_record(NULL::accounts, r) AS x
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, starting_balance = EXCLUDED.starting_balance,
      sort_order = EXCLUDED.sort_order, created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      deleted_at = NULL, user_id = EXCLUDED.user_id,
      dataset_generation = EXCLUDED.dataset_generation
    WHERE accounts.user_id = v_user_id;
  ELSIF p_store = 'categories' THEN
    INSERT INTO categories (
      id, name, type, sort_order, created_at, updated_at,
      deleted_at, user_id, dataset_generation
    )
    SELECT x.id, x.name, x.type, x.sort_order,
      COALESCE(x.created_at, clock_timestamp()), COALESCE(x.updated_at, clock_timestamp()),
      NULL, v_user_id, p_generation
    FROM jsonb_populate_record(NULL::categories, r) AS x
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, type = EXCLUDED.type,
      sort_order = EXCLUDED.sort_order, created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      deleted_at = NULL, user_id = EXCLUDED.user_id,
      dataset_generation = EXCLUDED.dataset_generation
    WHERE categories.user_id = v_user_id;
  ELSIF p_store = 'transactions' THEN
    INSERT INTO transactions (
      id, amount, date, type, category, from_account, to_account,
      description, created_at, updated_at, deleted_at, user_id,
      dataset_generation
    )
    SELECT x.id, x.amount, x.date, x.type, x.category, x.from_account, x.to_account,
      x.description, COALESCE(x.created_at, clock_timestamp()), COALESCE(x.updated_at, clock_timestamp()),
      NULL, v_user_id, p_generation
    FROM jsonb_populate_record(NULL::transactions, r) AS x
    ON CONFLICT (id) DO UPDATE SET
      amount = EXCLUDED.amount, date = EXCLUDED.date, type = EXCLUDED.type,
      category = EXCLUDED.category, from_account = EXCLUDED.from_account,
      to_account = EXCLUDED.to_account, description = EXCLUDED.description,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      deleted_at = NULL, user_id = EXCLUDED.user_id,
      dataset_generation = EXCLUDED.dataset_generation
    WHERE transactions.user_id = v_user_id;
  ELSIF p_store = 'cash_denominations' THEN
    INSERT INTO cash_denominations (
      id, date, denomination, count, created_at, deleted_at,
      user_id, dataset_generation
    )
    SELECT x.id, x.date, x.denomination, x.count,
      COALESCE(x.created_at, clock_timestamp()), NULL, v_user_id, p_generation
    FROM jsonb_populate_record(NULL::cash_denominations, r) AS x
    ON CONFLICT (id) DO UPDATE SET
      date = EXCLUDED.date, denomination = EXCLUDED.denomination,
      count = EXCLUDED.count, created_at = EXCLUDED.created_at,
      deleted_at = NULL, user_id = EXCLUDED.user_id,
      dataset_generation = EXCLUDED.dataset_generation
    WHERE cash_denominations.user_id = v_user_id;
  ELSIF p_store = 'payouts' THEN
    INSERT INTO payouts (
      id, date, total_amount, split_mode, splits, savings_sub_split,
      created_at, updated_at, deleted_at, user_id, dataset_generation
    )
    SELECT x.id, x.date, x.total_amount, x.split_mode,
      COALESCE(x.splits, '[]'::jsonb), x.savings_sub_split,
      COALESCE(x.created_at, clock_timestamp()), COALESCE(x.updated_at, clock_timestamp()),
      NULL, v_user_id, p_generation
    FROM jsonb_populate_record(NULL::payouts, r) AS x
    ON CONFLICT (id) DO UPDATE SET
      date = EXCLUDED.date, total_amount = EXCLUDED.total_amount,
      split_mode = EXCLUDED.split_mode, splits = EXCLUDED.splits,
      savings_sub_split = EXCLUDED.savings_sub_split,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      deleted_at = NULL, user_id = EXCLUDED.user_id,
      dataset_generation = EXCLUDED.dataset_generation
    WHERE payouts.user_id = v_user_id;
  ELSE
    INSERT INTO budget_targets (
      id, category, month, amount, created_at, updated_at,
      deleted_at, user_id, dataset_generation
    )
    SELECT x.id, x.category, x.month, x.amount,
      COALESCE(x.created_at, clock_timestamp()), COALESCE(x.updated_at, clock_timestamp()),
      NULL, v_user_id, p_generation
    FROM jsonb_populate_record(NULL::budget_targets, r) AS x
    ON CONFLICT (id) DO UPDATE SET
      category = EXCLUDED.category, month = EXCLUDED.month,
      amount = EXCLUDED.amount, created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      deleted_at = NULL, user_id = EXCLUDED.user_id,
      dataset_generation = EXCLUDED.dataset_generation
    WHERE budget_targets.user_id = v_user_id;
  END IF;

  RETURN jsonb_build_object('status', 'applied', 'generation', p_generation);
END;
$$;

GRANT EXECUTE ON FUNCTION apply_managed_write(
  BIGINT, TEXT, TEXT, UUID, JSONB
) TO authenticated;

CREATE OR REPLACE FUNCTION replace_user_dataset(
  p_snapshot_id UUID,
  p_generation BIGINT,
  p_accounts JSONB,
  p_categories JSONB,
  p_transactions JSONB,
  p_cash_denominations JSONB,
  p_payouts JSONB,
  p_budget_targets JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_current BIGINT;
  v_last_snapshot UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'replace_user_dataset requires an authenticated user';
  END IF;
  IF p_snapshot_id IS NULL OR p_generation IS NULL OR p_generation < 1 THEN
    RAISE EXCEPTION 'replace_user_dataset requires a snapshot id and a positive generation';
  END IF;

  INSERT INTO dataset_generations (user_id, generation)
  VALUES (v_user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT generation, last_snapshot_id
    INTO v_current, v_last_snapshot
  FROM dataset_generations
  WHERE user_id = v_user_id
  FOR UPDATE;

  IF v_last_snapshot = p_snapshot_id THEN
    RETURN jsonb_build_object(
      'status', 'applied',
      'generation', v_current,
      'already_applied', true
    );
  END IF;

  IF p_generation <= v_current THEN
    RETURN jsonb_build_object('status', 'conflict', 'generation', v_current);
  END IF;

  UPDATE dataset_generations
  SET generation = p_generation,
      last_snapshot_id = p_snapshot_id,
      updated_at = clock_timestamp()
  WHERE user_id = v_user_id;

  UPDATE accounts
  SET deleted_at = clock_timestamp(),
      updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond'),
      dataset_generation = p_generation
  WHERE user_id = v_user_id AND deleted_at IS NULL;

  UPDATE categories
  SET deleted_at = clock_timestamp(),
      updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond'),
      dataset_generation = p_generation
  WHERE user_id = v_user_id AND deleted_at IS NULL;

  UPDATE transactions
  SET deleted_at = clock_timestamp(),
      updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond'),
      dataset_generation = p_generation
  WHERE user_id = v_user_id AND deleted_at IS NULL;

  UPDATE cash_denominations
  SET deleted_at = clock_timestamp(),
      dataset_generation = p_generation
  WHERE user_id = v_user_id AND deleted_at IS NULL;

  UPDATE payouts
  SET deleted_at = clock_timestamp(),
      updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond'),
      dataset_generation = p_generation
  WHERE user_id = v_user_id AND deleted_at IS NULL;

  UPDATE budget_targets
  SET deleted_at = clock_timestamp(),
      updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond'),
      dataset_generation = p_generation
  WHERE user_id = v_user_id AND deleted_at IS NULL;

  INSERT INTO accounts (
    id, name, starting_balance, sort_order, created_at, updated_at,
    deleted_at, user_id, dataset_generation
  )
  SELECT
    x.id, x.name, COALESCE(x.starting_balance, 0), x.sort_order,
    COALESCE(x.created_at, clock_timestamp()), clock_timestamp(),
    NULL, v_user_id, p_generation
  FROM jsonb_to_recordset(COALESCE(p_accounts, '[]'::jsonb)) AS x(
    id UUID, name TEXT, starting_balance DOUBLE PRECISION,
    sort_order INTEGER, created_at TIMESTAMPTZ
  )
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    starting_balance = EXCLUDED.starting_balance,
    sort_order = EXCLUDED.sort_order,
    created_at = EXCLUDED.created_at,
    updated_at = GREATEST(clock_timestamp(), accounts.updated_at + interval '1 microsecond'),
    deleted_at = NULL,
    user_id = EXCLUDED.user_id,
    dataset_generation = EXCLUDED.dataset_generation
  WHERE accounts.user_id = v_user_id;

  INSERT INTO categories (
    id, name, type, sort_order, created_at, updated_at,
    deleted_at, user_id, dataset_generation
  )
  SELECT
    x.id, x.name, x.type, x.sort_order,
    COALESCE(x.created_at, clock_timestamp()), clock_timestamp(),
    NULL, v_user_id, p_generation
  FROM jsonb_to_recordset(COALESCE(p_categories, '[]'::jsonb)) AS x(
    id UUID, name TEXT, type TEXT, sort_order INTEGER, created_at TIMESTAMPTZ
  )
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    type = EXCLUDED.type,
    sort_order = EXCLUDED.sort_order,
    created_at = EXCLUDED.created_at,
    updated_at = GREATEST(clock_timestamp(), categories.updated_at + interval '1 microsecond'),
    deleted_at = NULL,
    user_id = EXCLUDED.user_id,
    dataset_generation = EXCLUDED.dataset_generation
  WHERE categories.user_id = v_user_id;

  INSERT INTO cash_denominations (
    id, date, denomination, count, created_at, deleted_at,
    user_id, dataset_generation
  )
  SELECT
    x.id, x.date, x.denomination, x.count,
    COALESCE(x.created_at, clock_timestamp()), NULL, v_user_id, p_generation
  FROM jsonb_to_recordset(COALESCE(p_cash_denominations, '[]'::jsonb)) AS x(
    id UUID, date DATE, denomination DOUBLE PRECISION,
    count INTEGER, created_at TIMESTAMPTZ
  )
  ON CONFLICT (id) DO UPDATE SET
    date = EXCLUDED.date,
    denomination = EXCLUDED.denomination,
    count = EXCLUDED.count,
    created_at = EXCLUDED.created_at,
    deleted_at = NULL,
    user_id = EXCLUDED.user_id,
    dataset_generation = EXCLUDED.dataset_generation
  WHERE cash_denominations.user_id = v_user_id;

  INSERT INTO payouts (
    id, date, total_amount, split_mode, splits, savings_sub_split,
    created_at, updated_at, deleted_at, user_id, dataset_generation
  )
  SELECT
    x.id, x.date, x.total_amount, x.split_mode,
    COALESCE(x.splits, '[]'::jsonb), x.savings_sub_split,
    COALESCE(x.created_at, clock_timestamp()), clock_timestamp(),
    NULL, v_user_id, p_generation
  FROM jsonb_to_recordset(COALESCE(p_payouts, '[]'::jsonb)) AS x(
    id UUID, date DATE, total_amount DOUBLE PRECISION, split_mode TEXT,
    splits JSONB, savings_sub_split JSONB, created_at TIMESTAMPTZ
  )
  ON CONFLICT (id) DO UPDATE SET
    date = EXCLUDED.date,
    total_amount = EXCLUDED.total_amount,
    split_mode = EXCLUDED.split_mode,
    splits = EXCLUDED.splits,
    savings_sub_split = EXCLUDED.savings_sub_split,
    created_at = EXCLUDED.created_at,
    updated_at = GREATEST(clock_timestamp(), payouts.updated_at + interval '1 microsecond'),
    deleted_at = NULL,
    user_id = EXCLUDED.user_id,
    dataset_generation = EXCLUDED.dataset_generation
  WHERE payouts.user_id = v_user_id;

  INSERT INTO budget_targets (
    id, category, month, amount, created_at, updated_at,
    deleted_at, user_id, dataset_generation
  )
  SELECT
    x.id, x.category, x.month, x.amount,
    COALESCE(x.created_at, clock_timestamp()), clock_timestamp(),
    NULL, v_user_id, p_generation
  FROM jsonb_to_recordset(COALESCE(p_budget_targets, '[]'::jsonb)) AS x(
    id UUID, category TEXT, month TEXT, amount DOUBLE PRECISION,
    created_at TIMESTAMPTZ
  )
  ON CONFLICT (id) DO UPDATE SET
    category = EXCLUDED.category,
    month = EXCLUDED.month,
    amount = EXCLUDED.amount,
    created_at = EXCLUDED.created_at,
    updated_at = GREATEST(clock_timestamp(), budget_targets.updated_at + interval '1 microsecond'),
    deleted_at = NULL,
    user_id = EXCLUDED.user_id,
    dataset_generation = EXCLUDED.dataset_generation
  WHERE budget_targets.user_id = v_user_id;

  INSERT INTO transactions (
    id, amount, date, type, category, from_account, to_account,
    description, created_at, updated_at, deleted_at, user_id,
    dataset_generation
  )
  SELECT
    x.id, x.amount, x.date, x.type, x.category, x.from_account, x.to_account,
    x.description, COALESCE(x.created_at, clock_timestamp()), clock_timestamp(),
    NULL, v_user_id, p_generation
  FROM jsonb_to_recordset(COALESCE(p_transactions, '[]'::jsonb)) AS x(
    id UUID, amount DOUBLE PRECISION, date DATE, type TEXT, category TEXT,
    from_account UUID, to_account UUID, description TEXT, created_at TIMESTAMPTZ
  )
  ON CONFLICT (id) DO UPDATE SET
    amount = EXCLUDED.amount,
    date = EXCLUDED.date,
    type = EXCLUDED.type,
    category = EXCLUDED.category,
    from_account = EXCLUDED.from_account,
    to_account = EXCLUDED.to_account,
    description = EXCLUDED.description,
    created_at = EXCLUDED.created_at,
    updated_at = GREATEST(clock_timestamp(), transactions.updated_at + interval '1 microsecond'),
    deleted_at = NULL,
    user_id = EXCLUDED.user_id,
    dataset_generation = EXCLUDED.dataset_generation
  WHERE transactions.user_id = v_user_id;

  RETURN jsonb_build_object('status', 'applied', 'generation', p_generation);
END;
$$;

GRANT EXECUTE ON FUNCTION replace_user_dataset(
  UUID, BIGINT, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB
) TO authenticated;

NOTIFY pgrst, 'reload schema';
