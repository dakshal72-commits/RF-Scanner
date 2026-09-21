-- Warehouse master data used by the RF scanner validation workflow.
create table if not exists public.bins (
  id text primary key,
  zone text not null,
  description text,
  active boolean not null default true
);

create table if not exists public.items (
  sku text primary key,
  description text not null,
  unit text not null default 'EA',
  active boolean not null default true
);

create table if not exists public.inventory (
  bin_id text not null references public.bins(id),
  sku text not null references public.items(sku),
  quantity integer not null default 0 check (quantity >= 0),
  primary key (bin_id, sku)
);

create table if not exists public.stock_transfers (
  client_id uuid primary key,
  reference text not null,
  source_bin text not null references public.bins(id),
  destination_bin text not null references public.bins(id),
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  completed_at timestamptz not null,
  received_at timestamptz not null default now()
);

alter table public.bins enable row level security;
alter table public.items enable row level security;
alter table public.inventory enable row level security;
alter table public.stock_transfers enable row level security;
grant insert on public.stock_transfers to anon;

create or replace function public.submit_stock_transfer(
  p_client_id uuid,
  p_reference text,
  p_source_bin text,
  p_destination_bin text,
  p_items jsonb,
  p_completed_at timestamptz
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
  v_available integer;
begin
  if p_source_bin = p_destination_bin or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Invalid stock transfer';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text, 0));
  if exists (select 1 from public.stock_transfers where client_id = p_client_id) then
    return;
  end if;

  insert into public.stock_transfers (client_id, reference, source_bin, destination_bin, items, completed_at)
  values (p_client_id, p_reference, p_source_bin, p_destination_bin, p_items, p_completed_at);

  for v_item in
    select moved.sku, sum(moved.quantity)::integer as quantity
    from jsonb_to_recordset(p_items) as moved(sku text, quantity integer)
    group by moved.sku
  loop
    if v_item.sku is null or v_item.quantity is null or v_item.quantity < 1 then
      raise exception 'Invalid item quantity';
    end if;

    select inv.quantity into v_available
    from public.inventory as inv
    where inv.bin_id = p_source_bin and inv.sku = v_item.sku
    for update;

    if v_available is null or v_available < v_item.quantity then
      raise exception 'Insufficient inventory for SKU % in bin %', v_item.sku, p_source_bin;
    end if;

    update public.inventory as inv
    set quantity = inv.quantity - v_item.quantity
    where inv.bin_id = p_source_bin and inv.sku = v_item.sku;

    insert into public.inventory (bin_id, sku, quantity)
    values (p_destination_bin, v_item.sku, v_item.quantity)
    on conflict (bin_id, sku) do update
    set quantity = public.inventory.quantity + excluded.quantity;
  end loop;
end;
$$;

revoke all on function public.submit_stock_transfer(uuid, text, text, text, jsonb, timestamptz) from public;
grant execute on function public.submit_stock_transfer(uuid, text, text, text, jsonb, timestamptz) to anon;
revoke insert on public.stock_transfers from anon;

drop policy if exists "Public can read active bins" on public.bins;
create policy "Public can read active bins" on public.bins
  for select to anon using (active = true);
drop policy if exists "Public can read active items" on public.items;
create policy "Public can read active items" on public.items
  for select to anon using (active = true);
drop policy if exists "Public can read inventory" on public.inventory;
create policy "Public can read inventory" on public.inventory
  for select to anon using (true);
drop policy if exists "Scanners can submit transfers" on public.stock_transfers;
create policy "Scanners can submit transfers" on public.stock_transfers
  for insert to anon with check (
    source_bin <> destination_bin
    and jsonb_array_length(items) > 0
  );

insert into public.bins (id, zone, description) values
  ('A01.01.A03', 'A01', 'Small parts rack A03'),
  ('A01.01.A04', 'A01', 'Small parts rack A04'),
  ('A01.02.A01', 'A01', 'Reserve storage A01'),
  ('B01.04.A02', 'B01', 'Forward pick A02'),
  ('B01.04.A03', 'B01', 'Forward pick A03'),
  ('C01.01.B01', 'C01', 'Bulk storage B01')
on conflict (id) do update set zone = excluded.zone, description = excluded.description, active = true;

insert into public.items (sku, description, unit) values
  ('ABR10', '10 mm abrasive roll', 'EA'),
  ('BWV12', 'BWV12', 'EA'),
  ('BLT25', '25 mm warehouse belt', 'EA'),
  ('BOX12', '12 inch shipping carton', 'EA'),
  ('GLV-M', 'Work gloves medium', 'PAIR'),
  ('TAPE48', '48 mm packing tape', 'ROLL'),
  ('TOTE-BL', 'Blue storage tote', 'EA')
on conflict (sku) do update set description = excluded.description, unit = excluded.unit, active = true;

insert into public.inventory (bin_id, sku, quantity) values
  ('A01.01.A03', 'ABR10', 40),
  ('A01.01.A03', 'BWV12', 1000),
  ('A01.01.A03', 'BLT25', 18),
  ('A01.01.A03', 'GLV-M', 30),
  ('A01.01.A04', 'TAPE48', 72),
  ('A01.02.A01', 'BOX12', 120),
  ('B01.04.A02', 'ABR10', 12),
  ('B01.04.A03', 'TOTE-BL', 24),
  ('C01.01.B01', 'BOX12', 300)
on conflict (bin_id, sku) do update set quantity = excluded.quantity;
