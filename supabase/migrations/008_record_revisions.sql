-- ============================================================
-- Migration 008: server-owned record revisions
--
-- PHASE 3B FOUNDATION — APPLY ONLY AFTER the metadata-stripping client is
-- deployed. This migration adds a `revision` column to every synced table, and
-- a pulled row then carries it into the local record. Clients built before
-- commit "fix(sync): prove ownership and server revisions before
-- acknowledging" echo unknown columns back in their payloads and compare them
-- during acknowledgement, so they would report false conflicts once this is
-- applied. Deploy order: client first, migration second.
--
-- Applying it does not change how writes are validated: the existing
-- `prevent_older_update()` timestamp rule still runs, and writes are still
-- last-write-wins. A revision column is a precondition for a future
-- compare-and-set protocol, not that protocol.
--
-- Deliberately NOT included:
--   * an operation-receipt table — receipts are only trustworthy when written
--     in the same server transaction as the mutation, so they belong with the
--     transactional RPC, not with a schema-only change;
--   * any change to RLS or to the managed-write RPC.
-- ============================================================

-- ── 1. Revision column on every synced table ─────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'accounts', 'categories', 'transactions', 'cash_denominations',
    'payouts', 'budget_targets', 'balance_snapshots',
    'stocks', 'stock_transactions', 'dividends'
  ]
  loop
    execute format(
      'alter table %I add column if not exists revision bigint not null default 1',
      t
    );
    execute format(
      'create index if not exists %I on %I (user_id, revision)',
      t || '_user_revision_idx', t
    );
  end loop;
end $$;

-- ── 2. Bump the revision on every applied update ─────────────
-- Same-kind triggers run alphabetically: `<table>_bump_revision` runs before the
-- existing `trg_*` timestamp/LWW triggers. If one of those returns NULL the
-- update is discarded and the increment goes with it, so the stored revision
-- never advances for a write the server rejected.
create or replace function bump_record_revision()
returns trigger
language plpgsql
as $$
begin
  new.revision := old.revision + 1;
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'accounts', 'categories', 'transactions', 'cash_denominations',
    'payouts', 'budget_targets', 'balance_snapshots',
    'stocks', 'stock_transactions', 'dividends'
  ]
  loop
    execute format('drop trigger if exists %I on %I', t || '_bump_revision', t);
    execute format(
      'create trigger %I before update on %I for each row execute function bump_record_revision()',
      t || '_bump_revision', t
    );
  end loop;
end $$;

-- ── 3. Rollback (manual) ─────────────────────────────────────
-- drop trigger if exists <table>_bump_revision on <table>;  -- one per table
-- drop function if exists bump_record_revision();
-- alter table <table> drop column if exists revision;       -- one per table
