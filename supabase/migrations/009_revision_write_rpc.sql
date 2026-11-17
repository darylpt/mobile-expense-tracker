-- ============================================================
-- Migration 009: transactional revision writes for non-managed stores
--
-- ACTIVATION ORDER: deploy the client that feature-detects this RPC first
-- (0.19.x, inert while the function is absent), then apply this migration.
-- Applying it activates the revision protocol for stocks, stock_transactions,
-- dividends and balance_snapshots. Managed stores keep `apply_managed_write`
-- and its dataset-generation fence; adopting them is a later gate.
--
-- Requires 008_record_revisions.sql (the `revision` columns and bump trigger).
--
-- What this adds, and why:
--   * one RPC that checks `expected_revision`, performs the mutation and records
--     an idempotency receipt in the SAME transaction — a crash or a lost response
--     cannot leave a write applied without its receipt, or a receipt without its
--     write;
--   * replay with the same operation id returns the original result instead of
--     applying twice, and reusing an id for a different request is an error;
--   * the table is chosen from a whitelist, never from caller text.
--
-- Deliberately NOT included: closing the direct PostgREST insert/update policies.
-- Deployed clients still write directly; that cutover is a separate compatibility
-- gate.
-- ============================================================

create table if not exists sync_operation_receipts (
  user_id      uuid        not null references auth.users(id) on delete cascade,
  operation_id text        not null,
  store        text        not null,
  record_id    text        not null,
  operation    text        not null,
  result       jsonb       not null,
  created_at   timestamptz not null default now(),
  primary key (user_id, operation_id)
);

alter table sync_operation_receipts enable row level security;

drop policy if exists sync_operation_receipts_select on sync_operation_receipts;
create policy sync_operation_receipts_select on sync_operation_receipts
  for select using (auth.uid() = user_id);

-- No insert/update/delete policies: receipts are written only by the RPC below.

create or replace function apply_revision_write(
  p_store text,
  p_operation text,
  p_record_id text,
  p_expected_revision bigint,
  p_record jsonb,
  p_operation_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_table text;
  v_receipt jsonb;
  v_revision bigint;
  v_other bigint;
  v_set text;
  v_columns text;
begin
  if v_user is null then
    raise exception 'apply_revision_write requires an authenticated user';
  end if;

  v_table := case p_store
    when 'stocks' then 'stocks'
    when 'stock_transactions' then 'stock_transactions'
    when 'dividends' then 'dividends'
    when 'balance_snapshots' then 'balance_snapshots'
    else null
  end;
  if v_table is null then
    raise exception 'apply_revision_write does not serve store %', p_store;
  end if;
  if p_operation not in ('create', 'update', 'delete') then
    raise exception 'apply_revision_write got unsupported operation %', p_operation;
  end if;
  if p_operation_id is null or length(p_operation_id) = 0 then
    raise exception 'apply_revision_write needs an operation id';
  end if;

  -- Replay: same operation id, same request, same answer.
  select result into v_receipt
    from sync_operation_receipts
   where user_id = v_user and operation_id = p_operation_id;
  if found then
    if (v_receipt->>'store') is distinct from p_store
       or (v_receipt->>'record_id') is distinct from p_record_id
       or (v_receipt->>'operation') is distinct from p_operation then
      raise exception 'operation id % was already used for a different request', p_operation_id;
    end if;
    return v_receipt || jsonb_build_object('status', 'replayed');
  end if;

  if p_operation = 'create' then
    begin
      execute format(
        'insert into %I select * from jsonb_populate_record(null::%I, $1) returning revision',
        v_table, v_table
      ) into v_revision using p_record;
    exception when unique_violation then
      execute format('select revision from %I where id = $1 and user_id = $2', v_table)
        into v_other using p_record_id, v_user;
      return jsonb_build_object('status', 'conflict', 'revision', v_other);
    end;

  elsif p_operation = 'update' then
    select string_agg(
             format('%I = ($1->>%L)::%s', column_name, column_name, data_type), ', '
           )
      into v_set
      from information_schema.columns
     where table_schema = 'public'
       and table_name = v_table
       and column_name not in ('id', 'user_id', 'revision', 'created_at', 'updated_at');

    if v_set is null then
      raise exception 'apply_revision_write found no writable columns for %', p_store;
    end if;

    execute format(
      'update %I set %s, updated_at = now() where id = $2 and user_id = $3 and revision = $4 returning revision',
      v_table, v_set
    ) into v_revision using p_record, p_record_id, v_user, p_expected_revision;

    if v_revision is null then
      execute format('select revision from %I where id = $1 and user_id = $2', v_table)
        into v_other using p_record_id, v_user;
      return jsonb_build_object('status', 'conflict', 'revision', v_other);
    end if;

  else -- delete: soft delete pinned to the expected revision
    execute format(
      'update %I set deleted_at = now(), updated_at = now()
        where id = $1 and user_id = $2 and revision = $3 returning revision',
      v_table
    ) into v_revision using p_record_id, v_user, p_expected_revision;

    if v_revision is null then
      execute format(
        'select revision from %I where id = $1 and user_id = $2 and deleted_at is not null',
        v_table
      ) into v_other using p_record_id, v_user;
      if v_other is not null then
        -- Another client already deleted it: the request is satisfied.
        v_revision := v_other;
      else
        execute format('select revision from %I where id = $1 and user_id = $2', v_table)
          into v_other using p_record_id, v_user;
        return jsonb_build_object('status', 'conflict', 'revision', v_other);
      end if;
    end if;
  end if;

  insert into sync_operation_receipts (user_id, operation_id, store, record_id, operation, result)
  values (
    v_user, p_operation_id, p_store, p_record_id, p_operation,
    jsonb_build_object('status', 'applied', 'revision', v_revision)
  );

  return jsonb_build_object('status', 'applied', 'revision', v_revision);
end;
$$;

revoke all on function apply_revision_write(text, text, text, bigint, jsonb, text) from public;
grant execute on function apply_revision_write(text, text, text, bigint, jsonb, text) to authenticated;

-- Rollback (manual):
-- drop function if exists apply_revision_write(text, text, text, bigint, jsonb, text);
-- drop table if exists sync_operation_receipts;
