-- Apply after the existing stock-transfer function. This preserves its atomic
-- inventory update and adds a server-side record for rejected offline moves.
create table if not exists public.stock_transfer_conflicts (
  client_id uuid primary key,
  reference text not null,
  source_bin text not null,
  destination_bin text not null,
  items jsonb not null,
  reason text not null,
  detected_at timestamptz not null default now()
);

alter table public.stock_transfer_conflicts enable row level security;
revoke all on public.stock_transfer_conflicts from anon;

create or replace function public.submit_stock_transfer_v2(
  p_client_id uuid,
  p_reference text,
  p_source_bin text,
  p_destination_bin text,
  p_items jsonb,
  p_completed_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text;
begin
  begin
    perform public.submit_stock_transfer(
      p_client_id, p_reference, p_source_bin, p_destination_bin,
      p_items, p_completed_at
    );
  exception
    when sqlstate 'P0001' or sqlstate '23503' or sqlstate '23514' or sqlstate '22023' then
      v_reason := left(sqlerrm, 500);
      insert into public.stock_transfer_conflicts
        (client_id, reference, source_bin, destination_bin, items, reason)
      values
        (p_client_id, p_reference, p_source_bin, p_destination_bin, p_items, v_reason)
      on conflict (client_id) do update
        set reason = excluded.reason, detected_at = now();
      return jsonb_build_object('status', 'conflict', 'reason', v_reason);
  end;
  return jsonb_build_object('status', 'synced');
end;
$$;

revoke all on function public.submit_stock_transfer_v2(uuid, text, text, text, jsonb, timestamptz) from public;
grant execute on function public.submit_stock_transfer_v2(uuid, text, text, text, jsonb, timestamptz) to anon;
