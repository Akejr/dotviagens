-- DOT Viagens: taxa de serviço DOT, pesquisas agrupadas por jornada e painel em tempo real.

-- Preço final = valor convertido ao câmbio + taxa de serviço DOT (11%).
-- amount_aoa continua a ser o total cobrado na Wiza e facturado no Vero.
alter table public.bookings
  add column base_aoa bigint check (base_aoa is null or base_aoa >= 0),
  add column fee_aoa bigint not null default 0 check (fee_aoa >= 0),
  add column markup_bp integer not null default 0 check (markup_bp between 0 and 10000);

-- Clientes com updated_at: o painel vê logo novos acessos, papéis e bloqueios.
alter table public.customers add column updated_at timestamptz not null default now();
create trigger customers_touch before update on public.customers
  for each row execute function public.touch_updated_at();

-- Jornada de pesquisa: todas as consultas de uma pesquisa (datas vizinhas, voltas) partilham journey_key.
alter table public.search_logs
  add column journey_id text,
  add column journey_key text;
update public.search_logs
   set journey_key = coalesce(session_id || '|' || origin || '|' || destination || '|' || passengers, 'id:' || id)
 where journey_key is null;
create index search_logs_journey_idx on public.search_logs (journey_key, id);

create index bookings_updated_idx on public.bookings (updated_at desc);
create index bookings_paid_idx on public.bookings (paid_at desc) where paid_at is not null;
create index customers_updated_idx on public.customers (updated_at desc);
create index sms_messages_updated_idx on public.sms_messages (updated_at desc);

-- Estado leve para o painel saber o que mudou. Consultado a cada 3 segundos.
create function public.admin_live_state() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'searches', (select coalesce(max(id), 0) from public.search_logs),
    'bookings', (select count(*) || ':' || coalesce(max(updated_at)::text, '') from public.bookings),
    'payments', (select coalesce(max(id), 0) from public.payment_events),
    'customers', (select count(*) || ':' || coalesce(max(updated_at)::text, '') from public.customers),
    'sms', (select count(*) || ':' || coalesce(max(updated_at)::text, '') from public.sms_messages),
    'audit', (select coalesce(max(id), 0) from public.admin_audit),
    'rates', (select coalesce(max(id), 0) from public.exchange_rates),
    'awaiting_ticket', (select count(*) from public.bookings where status = 'paid'),
    'needs_review', (select count(*) from public.bookings where needs_review),
    'last_paid', (select jsonb_build_object('reference', reference, 'amount_aoa', amount_aoa, 'paid_at', paid_at)
                    from public.bookings where paid_at is not null order by paid_at desc limit 1),
    'last_booking', (select jsonb_build_object('reference', reference, 'amount_aoa', amount_aoa, 'created_at', created_at, 'contact_name', contact_name)
                       from public.bookings order by created_at desc limit 1)
  );
$$;

-- Uma linha por pesquisa do cliente (não por consulta ao fornecedor).
create function public.admin_search_journeys(p_limit integer default 60) returns jsonb
language sql stable set search_path = '' as $$
  with g as (
    select coalesce(journey_key, 'id:' || id) as jkey,
           max(id) as last_id,
           min(created_at) as started_at,
           max(created_at) as last_at,
           (array_agg(origin order by id))[1] as origin,
           (array_agg(destination order by id))[1] as destination,
           (array_agg(passengers order by id))[1] as passengers,
           coalesce((array_agg(departure_date order by id) filter (where kind = 'view' or kind is null))[1], min(departure_date)) as departure_date,
           (array_agg(return_date order by id) filter (where kind = 'view' or kind is null))[1] as return_date,
           bool_or(return_date is not null) as round_trip,
           count(*) as calls,
           count(*) filter (where not cached) as provider_calls,
           count(*) filter (where status = 'error') as errors,
           count(distinct departure_date) filter (where kind in ('view', 'prefetch') or kind is null) as outbound_dates,
           count(distinct return_date) filter (where kind in ('return', 'return-prefetch')) as return_dates,
           coalesce(bool_or(kind in ('return', 'return-prefetch')), false) as reached_return,
           (array_agg(departure_date order by id desc) filter (where kind in ('return', 'return-prefetch')))[1] as chosen_outbound_date,
           (array_agg(return_date order by id desc) filter (where kind = 'return'))[1] as chosen_return_date,
           min(min_price_brl) filter (where kind = 'view' or kind is null) as view_min_brl,
           min(min_price_brl) filter (where kind in ('view', 'prefetch') or kind is null) as outbound_min_brl,
           min(min_price_brl) filter (where kind in ('return', 'return-prefetch')) as return_min_brl,
           (array_agg(status order by id desc))[1] as last_status,
           (array_agg(customer_id order by id) filter (where customer_id is not null))[1] as customer_id,
           (array_agg(visitor order by id))[1] as visitor,
           (array_agg(country order by id))[1] as country
      from public.search_logs
     where kind is distinct from 'calendar'
     group by 1
     order by max(created_at) desc
     limit greatest(1, least(coalesce(p_limit, 60), 200))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', g.jkey, 'last_id', g.last_id, 'started_at', g.started_at, 'last_at', g.last_at,
           'origin', g.origin, 'destination', g.destination, 'passengers', g.passengers,
           'departure_date', g.departure_date, 'return_date', g.return_date, 'round_trip', g.round_trip,
           'calls', g.calls, 'provider_calls', g.provider_calls, 'errors', g.errors,
           'outbound_dates', g.outbound_dates, 'return_dates', g.return_dates, 'reached_return', g.reached_return,
           'chosen_outbound_date', g.chosen_outbound_date, 'chosen_return_date', g.chosen_return_date,
           'view_min_brl', g.view_min_brl, 'outbound_min_brl', g.outbound_min_brl, 'return_min_brl', g.return_min_brl,
           'last_status', g.last_status, 'visitor', g.visitor, 'country', g.country,
           'customer', case when c.id is null then null else jsonb_build_object('name', c.name, 'phone', c.phone) end
         ) order by g.last_at desc), '[]'::jsonb)
    from g
    left join public.customers c on c.id = g.customer_id;
$$;

-- Estatísticas por jornada; consultas ao fornecedor contadas à parte (custo SerpApi).
create or replace function public.admin_search_stats(p_days integer default 7) returns jsonb
language sql stable set search_path = '' as $$
  with recent as (
    select *, coalesce(journey_key, 'id:' || id) as jkey
      from public.search_logs
     where created_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 7)))
  ), searches as (
    select * from recent where kind is distinct from 'calendar'
  )
  select jsonb_build_object(
    'journeys', (select count(distinct jkey) from searches),
    'visitors', (select count(distinct visitor) from recent),
    'calls', (select count(*) from recent),
    'provider_calls', (select count(*) from recent where not cached),
    'cached', (select count(*) from recent where cached),
    'calendar_calls', (select count(*) from recent where kind = 'calendar' and not cached),
    'errors', (select count(*) from recent where status = 'error'),
    'empty_journeys', (select count(*) from (select jkey from searches group by jkey having bool_and(status = 'empty')) e),
    'top_routes', coalesce((
      select jsonb_agg(r order by r.n desc) from (
        select origin, destination, count(distinct jkey) as n, count(distinct visitor) as visitors,
               min(min_price_brl) filter (where kind in ('view', 'prefetch') or kind is null) as min_price_brl
          from searches
         group by origin, destination
         order by count(distinct jkey) desc
         limit 10
      ) r
    ), '[]'::jsonb),
    'per_day', coalesce((
      select jsonb_agg(d order by d.day) from (
        select (created_at at time zone 'Africa/Luanda')::date as day, count(distinct jkey) as n
          from searches group by 1
      ) d
    ), '[]'::jsonb)
  );
$$;

-- Números do painel: pesquisas contadas por jornada e taxas DOT recebidas.
create or replace function public.admin_overview() returns jsonb
language sql stable set search_path = '' as $$
  with t as (
    select (date_trunc('day', now() at time zone 'Africa/Luanda') at time zone 'Africa/Luanda') as today
  ), s as (
    select coalesce(journey_key, 'id:' || id) as jkey, created_at, visitor, cached, kind
      from public.search_logs
  ), paid as (
    select amount_aoa, fee_aoa, paid_at from public.bookings where status in ('paid', 'ticketed')
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
    'fees_today', (select coalesce(sum(fee_aoa), 0) from paid, t where paid.paid_at >= t.today),
    'fees_30d', (select coalesce(sum(fee_aoa), 0) from paid where paid_at >= now() - interval '30 days'),
    'fees_total', (select coalesce(sum(fee_aoa), 0) from paid),
    'awaiting_ticket', (select count(*) from public.bookings where status = 'paid'),
    'pending_payment', (select count(*) from public.bookings where status = 'pending_payment'),
    'needs_review', (select count(*) from public.bookings where needs_review),
    'invoices_missing', (select count(*) from public.bookings where status in ('paid', 'ticketed') and vero_invoice_id is null),
    'customers_total', (select count(*) from public.customers),
    'customers_7d', (select count(*) from public.customers where created_at >= now() - interval '7 days'),
    'sms_24h', (select count(*) from public.sms_messages where created_at >= now() - interval '24 hours')
  )
  from t;
$$;

revoke all on function public.admin_live_state() from public, anon, authenticated;
revoke all on function public.admin_search_journeys(integer) from public, anon, authenticated;
grant execute on function public.admin_live_state() to service_role;
grant execute on function public.admin_search_journeys(integer) to service_role;
