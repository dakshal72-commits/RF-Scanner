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

alter table public.bins enable row level security;
alter table public.items enable row level security;
alter table public.inventory enable row level security;

drop policy if exists "Public can read active bins" on public.bins;
create policy "Public can read active bins" on public.bins
  for select to anon using (active = true);
drop policy if exists "Public can read active items" on public.items;
create policy "Public can read active items" on public.items
  for select to anon using (active = true);
drop policy if exists "Public can read inventory" on public.inventory;
create policy "Public can read inventory" on public.inventory
  for select to anon using (true);

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
  ('BLT25', '25 mm warehouse belt', 'EA'),
  ('BOX12', '12 inch shipping carton', 'EA'),
  ('GLV-M', 'Work gloves medium', 'PAIR'),
  ('TAPE48', '48 mm packing tape', 'ROLL'),
  ('TOTE-BL', 'Blue storage tote', 'EA')
on conflict (sku) do update set description = excluded.description, unit = excluded.unit, active = true;

insert into public.inventory (bin_id, sku, quantity) values
  ('A01.01.A03', 'ABR10', 40),
  ('A01.01.A03', 'BLT25', 18),
  ('A01.01.A03', 'GLV-M', 30),
  ('A01.01.A04', 'TAPE48', 72),
  ('A01.02.A01', 'BOX12', 120),
  ('B01.04.A02', 'ABR10', 12),
  ('B01.04.A03', 'TOTE-BL', 24),
  ('C01.01.B01', 'BOX12', 300)
on conflict (bin_id, sku) do update set quantity = excluded.quantity;
