-- ============================================================
-- Migration 008: Server-managed record revisions and operation receipts
--
-- PHASE 3B FOUNDATION. The deployed client does not read or write anything
-- this migration adds; applying it is safe on its own and changes no current
-- behavior. Client adoption (sending `expected_revision`, recording receipts)
-- is a separate change that must not ship before this is applied.
--
-- Why: today an update is "last write wins" on `updated_at`, and a retried
-- request is indistinguishable from a new one. A revision column gives every
-- row a server-owned compare-and-set token; the receipt table makes a retried
-- operation idempotent because the server, not the client, decides whether it
-- already ran.
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

-- ── 2. Bump the revision on every update ─────────────────────
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

-- ── 3. Operation receipts: one row per applied client operation ──
create table if not exists sync_receipts (
  user_id      uuid        not null references auth.users(id) on delete cascade,
  operation_id text        not null,
  store        text        not null,
  record_id    text        not null,
  applied_at   timestamptz not null default now(),
  primary key (user_id, operation_id)
);

alter table sync_receipts enable row level security;

drop policy if exists sync_receipts_select on sync_receipts;
create policy sync_receipts_select on sync_receipts
  for select using (auth.uid() = user_id);

drop policy if exists sync_receipts_insert on sync_receipts;
create policy sync_receipts_insert on sync_receipts
  for insert with check (auth.uid() = user_id);

-- Receipts are append-only from the client's point of view; deletion happens
-- only through the FK cascade when the account is removed.

-- ── 4. Rollback (manual) ─────────────────────────────────────
-- drop table if exists sync_receipts;
-- drop trigger if exists <table>_bump_revision on <table>;  -- one per table
-- drop function if exists bump_record_revision();
-- alter table <table> drop column if exists revision;       -- one per table
