-- RSMF Cerâmica — Bloco 3
-- Execute uma vez no Supabase SQL Editor antes de publicar o novo Worker.

alter table public.orders add column if not exists customer_email text;
alter table public.orders add column if not exists items jsonb not null default '[]'::jsonb;
alter table public.orders add column if not exists paid_at timestamptz;
alter table public.orders add column if not exists stock_processed_at timestamptz;

create or replace function public.rsmf_confirm_paid_order(
  p_order_id bigint,
  p_charge_id text default null,
  p_paid_at timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_item jsonb;
  v_qty integer;
  v_product_id text;
  v_name text;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Pedido % não encontrado', p_order_id; end if;

  -- Idempotência: webhook repetido não baixa estoque novamente.
  if v_order.stock_processed_at is not null then
    update public.orders set payment_status='PAID', order_status='pago', paid_at=coalesce(paid_at,p_paid_at) where id=p_order_id;
    return jsonb_build_object('ok',true,'already_processed',true);
  end if;

  if jsonb_typeof(v_order.items) <> 'array' or jsonb_array_length(v_order.items)=0 then
    raise exception 'Pedido % não possui itens para baixa de estoque', p_order_id;
  end if;

  for v_item in select value from jsonb_array_elements(v_order.items)
  loop
    v_product_id := v_item->>'product_id';
    v_qty := greatest(1, coalesce((v_item->>'quantity')::integer,1));
    v_name := coalesce(v_item->>'name',v_product_id);

    update public.products
       set stock = stock - v_qty,
           status = case when stock - v_qty <= 0 then 'sold' else status end,
           updated_at = now()
     where id::text = v_product_id
       and status = 'available'
       and stock >= v_qty;

    if not found then raise exception 'Estoque insuficiente ou produto indisponível: %', v_name; end if;
  end loop;

  update public.orders
     set payment_status='PAID', order_status='pago', paid_at=coalesce(p_paid_at,now()), stock_processed_at=now(), pagbank_charge_id=coalesce(p_charge_id,pagbank_charge_id)
   where id=p_order_id;

  return jsonb_build_object('ok',true,'already_processed',false);
end;
$$;

revoke all on function public.rsmf_confirm_paid_order(bigint,text,timestamptz) from public;
grant execute on function public.rsmf_confirm_paid_order(bigint,text,timestamptz) to service_role;


-- O painel administrativo usa uma sessão autenticada do Supabase.
alter table public.orders enable row level security;
drop policy if exists "RSMF admin le pedidos" on public.orders;
create policy "RSMF admin le pedidos" on public.orders for select to authenticated using (true);
