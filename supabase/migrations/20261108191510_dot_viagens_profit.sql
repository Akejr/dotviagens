-- DOT Viagens: lucro de cada venda inserido à mão no painel e vendas registadas fora do site.

-- O lucro real só se conhece depois de comprar o bilhete na companhia ou no consolidador:
-- a equipa insere-o no painel depois da compra e o painel soma esse valor como lucro.
-- A taxa de 11% continua no preço ao cliente (fee_aoa), mas deixou de contar como lucro.
-- Pode ser negativo (prejuízo); em valor absoluto nunca passa do total pago.
alter table public.bookings
  add column profit_aoa bigint,
  add column imported boolean not null default false,
  add constraint bookings_profit_aoa_check check (profit_aoa is null or abs(profit_aoa) <= amount_aoa);

comment on column public.bookings.profit_aoa is 'Lucro da venda em Kz, inserido no painel depois da compra.';
comment on column public.bookings.imported is 'Venda feita fora do site e registada à mão: sem SMS nem factura automática.';

-- Uma venda registada à mão pode não ter os dados do passaporte.
-- As compras do site continuam a exigi-los (validação em server/passengers.mjs).
alter table public.booking_passengers
  alter column birth_date drop not null,
  alter column nationality drop not null,
  alter column document_number drop not null,
  alter column document_country drop not null,
  alter column document_expiry drop not null;

-- Números do painel: vendas (total pago) e lucro inserido, em vez da taxa DOT.
create or replace function public.admin_overview() returns jsonb
language sql stable set search_path = '' as $$
  with t as (
    select (date_trunc('day', now() at time zone 'Africa/Luanda') at time zone 'Africa/Luanda') as today
  ), s as (
    select coalesce(journey_key, 'id:' || id) as jkey, created_at, visitor, cached, kind
      from public.search_logs
  ), paid as (
    select amount_aoa, profit_aoa, paid_at, imported, vero_invoice_id
      from public.bookings where status in ('paid', 'ticketed')
  )
  select jsonb_build_object(
    'searches_today', (select count(distinct jkey) from s, t where s.created_at >= t.today and s.kind is distinct from 'calendar'),
    'searches_hour', (select count(distinct jkey) from s where s.created_at >= now() - interval '1 hour' and s.kind is distinct from 'calendar'),
    'searches_7d', (select count(distinct jkey) from s where s.kind is distinct from 'calendar'),
    'provider_calls_today', (select count(*) from s, t where s.created_at >= t.today and not s.cached),
    'visitors_today', (select count(distinct visitor) from s, t where s.created_at >= t.today),
    'bookings_by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) as n from public.bookings group by status) b), '{}'::jsonb),
    'bookings_today', (select count(*) from public.bookings b, t where b.created_at >= t.today),
    'paid_today', (select count(*) from paid, t where paid.paid_at >= t.today),
    'revenue_today', (select coalesce(sum(amount_aoa), 0) from paid, t where paid.paid_at >= t.today),
    'revenue_30d', (select coalesce(sum(amount_aoa), 0) from paid where paid_at >= now() - interval '30 days'),
    'revenue_total', (select coalesce(sum(amount_aoa), 0) from paid),
    'profit_today', (select coalesce(sum(profit_aoa), 0) from paid, t where paid.paid_at >= t.today),
    'profit_30d', (select coalesce(sum(profit_aoa), 0) from paid where paid_at >= now() - interval '30 days'),
    'profit_total', (select coalesce(sum(profit_aoa), 0) from paid),
    'profit_missing', (select count(*) from paid where profit_aoa is null),
    'awaiting_ticket', (select count(*) from public.bookings where status = 'paid'),
    'pending_payment', (select count(*) from public.bookings where status = 'pending_payment'),
    'needs_review', (select count(*) from public.bookings where needs_review),
    'invoices_missing', (select count(*) from paid where vero_invoice_id is null and not imported),
    'customers_total', (select count(*) from public.customers),
    'customers_7d', (select count(*) from public.customers where created_at >= now() - interval '7 days'),
    'sms_24h', (select count(*) from public.sms_messages where created_at >= now() - interval '24 hours')
  )
  from t;
$$;
