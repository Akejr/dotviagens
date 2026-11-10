-- DOT Viagens: cidade aproximada de cada pesquisa (geolocalização do IP feita pela Vercel ou
-- pelo Cloudflare), mostrada no painel ao lado do visitante. O IP continua a não ser guardado.

alter table public.search_logs add column city text check (char_length(city) <= 60);

-- Jornadas de pesquisa: também a cidade. País e cidade vêm da mesma consulta (a primeira com
-- cidade; as pesquisas antigas, sem cidade, mantêm o país da primeira consulta).
create or replace function public.admin_search_journeys(p_limit integer default 60) returns jsonb
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
           coalesce((array_agg(country order by id) filter (where city is not null))[1], (array_agg(country order by id))[1]) as country,
           (array_agg(city order by id) filter (where city is not null))[1] as city
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
           'last_status', g.last_status, 'visitor', g.visitor, 'country', g.country, 'city', g.city,
           'customer', case when c.id is null then null else jsonb_build_object('name', c.name, 'phone', c.phone) end
         ) order by g.last_at desc), '[]'::jsonb)
    from g
    left join public.customers c on c.id = g.customer_id;
$$;
