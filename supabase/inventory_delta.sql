-- Run once after schema.sql. A serialized version clock makes each page of
-- changes safe to apply, even when warehouse transactions commit concurrently.
begin;

create table if not exists public.inventory_sync_clock (
  id integer primary key check (id = 1),
  version bigint not null
);
alter table public.inventory_sync_clock enable row level security;
insert into public.inventory_sync_clock (id, version) values (1, 0)
on conflict (id) do nothing;

create table if not exists public.inventory_changes (
  version bigint primary key,
  kind text not null check (kind in ('bin', 'item', 'inventory')),
  record_key text not null,
  payload jsonb,
  changed_at timestamptz not null default now()
);
create index if not exists inventory_changes_changed_at_idx on public.inventory_changes (changed_at);
alter table public.inventory_changes enable row level security;
grant select on public.inventory_changes to anon;
drop policy if exists "Scanners can read inventory changes" on public.inventory_changes;
create policy "Scanners can read inventory changes" on public.inventory_changes
  for select to anon using (true);

create or replace function public.record_inventory_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_version bigint;
  v_kind text;
  v_key text;
  v_payload jsonb;
begin
  if tg_table_name = 'bins' then
    v_kind := 'bin';
    v_key := coalesce(new.id, old.id);
    v_payload := case when tg_op = 'DELETE' or not new.active then null else jsonb_build_object('id', new.id) end;
  elsif tg_table_name = 'items' then
    v_kind := 'item';
    v_key := coalesce(new.sku, old.sku);
    v_payload := case when tg_op = 'DELETE' or not new.active then null else jsonb_build_object('sku', new.sku, 'description', new.description, 'unit', new.unit) end;
  else
    v_kind := 'inventory';
    v_key := coalesce(new.bin_id, old.bin_id) || '|' || coalesce(new.sku, old.sku);
    v_payload := case when tg_op = 'DELETE' then null else jsonb_build_object('bin_id', new.bin_id, 'sku', new.sku, 'quantity', new.quantity) end;
  end if;
  update public.inventory_sync_clock set version = version + 1 where id = 1 returning version into v_version;
  insert into public.inventory_changes (version, kind, record_key, payload)
  values (v_version, v_kind, v_key, v_payload);
  return coalesce(new, old);
end;
$$;

drop trigger if exists bins_inventory_change on public.bins;
create trigger bins_inventory_change after insert or update or delete on public.bins
  for each row execute function public.record_inventory_change();
drop trigger if exists items_inventory_change on public.items;
create trigger items_inventory_change after insert or update or delete on public.items
  for each row execute function public.record_inventory_change();
drop trigger if exists stock_inventory_change on public.inventory;
create trigger stock_inventory_change after insert or update or delete on public.inventory
  for each row execute function public.record_inventory_change();

-- Seed the log for first-time scanners. Existing change entries are retained
-- if this migration is rerun.
do $$
declare
  v_start bigint;
  v_count bigint;
begin
  if not exists (select 1 from public.inventory_changes) then
    select version into v_start from public.inventory_sync_clock where id = 1 for update;
    with seed as (
      select 'bin'::text kind, id record_key, jsonb_build_object('id', id) payload
      from public.bins where active
      union all
      select 'item', sku, jsonb_build_object('sku', sku, 'description', description, 'unit', unit)
      from public.items where active
      union all
      select 'inventory', bin_id || '|' || sku,
        jsonb_build_object('bin_id', bin_id, 'sku', sku, 'quantity', quantity)
      from public.inventory
    ), numbered as (
      select row_number() over (order by kind, record_key) + v_start version, kind, record_key, payload
      from seed
    )
    insert into public.inventory_changes (version, kind, record_key, payload)
    select version, kind, record_key, payload from numbered;
    get diagnostics v_count = row_count;
    update public.inventory_sync_clock set version = v_start + v_count where id = 1;
  end if;
end;
$$;
commit;
