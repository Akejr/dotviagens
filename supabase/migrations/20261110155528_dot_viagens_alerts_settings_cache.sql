-- DOT Viagens: avisos de preço por SMS, taxa DOT alterável no painel, cache partilhado das
-- pesquisas de voos e pausa automática quando a cota da SerpApi acaba.

-- 1. Definições alteradas no painel (taxa DOT) e estado partilhado por todos os servidores
--    (pausa das consultas à SerpApi depois de um erro de limite).
create table public.app_settings (
  key text primary key check (key ~ '^[a-z_]{2,40}$'),
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.customers (id) on delete set null
);
insert into public.app_settings (key, value) values ('markup_bp', '1100'::jsonb);

-- 2. Cache partilhado das pesquisas de voos: o resultado que uma instância obteve serve todas
--    as outras (e todos os visitantes) durante 25 minutos. As ofertas valem 30 minutos na compra.
create table public.flight_cache (
  cache_key text primary key check (char_length(cache_key) = 64),
  data jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index flight_cache_expires_idx on public.flight_cache (expires_at);

-- 3. Avisos de preço: o cliente pede um SMS quando o preço de uma pesquisa (rota, datas e
--    adultos) baixar. O preço é seguido com as pesquisas que outros visitantes fazem para a
--    mesma viagem, sem consultas extra. No máximo 2 SMS por aviso.
create table public.price_alerts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'done', 'expired', 'cancelled')),
  origin text not null check (origin ~ '^[A-Z]{3}$'),
  destination text not null check (destination ~ '^[A-Z]{3}$'),
  origin_name text check (char_length(origin_name) <= 40),
  destination_name text check (char_length(destination_name) <= 40),
  departure_date date not null,
  return_date date,
  passengers integer not null check (passengers between 1 and 4),
  baseline_brl numeric(12, 2) not null check (baseline_brl > 0),
  baseline_kz bigint not null check (baseline_kz > 0),
  last_price_kz bigint,
  lowest_price_kz bigint,
  last_seen_at timestamptz,
  checks integer not null default 0,
  alerts_sent integer not null default 0 check (alerts_sent between 0 and 2),
  first_alert_kz bigint,
  first_alert_at timestamptz,
  second_alert_kz bigint,
  second_alert_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index price_alerts_match_idx on public.price_alerts (origin, destination, departure_date, passengers) where status = 'active';
create index price_alerts_customer_idx on public.price_alerts (customer_id, created_at desc);
create index price_alerts_updated_idx on public.price_alerts (updated_at desc);
create trigger price_alerts_touch before update on public.price_alerts
  for each row execute function public.touch_updated_at();

alter table public.app_settings enable row level security;
alter table public.flight_cache enable row level security;
alter table public.price_alerts enable row level security;
revoke all on table public.app_settings, public.flight_cache, public.price_alerts from public, anon, authenticated;
grant select, insert, update, delete on table public.app_settings, public.flight_cache, public.price_alerts to service_role;

-- Limpeza de hora a hora: pesquisas guardadas expiradas e avisos de viagens que já partiram.
select cron.schedule('dot-purge-flight-cache', '41 * * * *',
  $$delete from public.flight_cache where expires_at < now() - interval '1 hour'$$);
select cron.schedule('dot-expire-price-alerts', '47 * * * *',
  $$update public.price_alerts set status = 'expired' where status = 'active' and departure_date < (now() at time zone 'Africa/Luanda')::date$$);

-- Estado leve do painel: também avisos, taxa DOT e pausa da SerpApi.
create or replace function public.admin_live_state() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'searches', (select coalesce(max(id), 0) from public.search_logs),
    'bookings', (select count(*) || ':' || coalesce(max(updated_at)::text, '') from public.bookings),
    'payments', (select coalesce(max(id), 0) from public.payment_events),
    'customers', (select count(*) || ':' || coalesce(max(updated_at)::text, '') from public.customers),
    'sms', (select count(*) || ':' || coalesce(max(updated_at)::text, '') from public.sms_messages),
    'audit', (select coalesce(max(id), 0) from public.admin_audit),
    'rates', (select coalesce(max(id), 0) from public.exchange_rates),
    'pricing', (select coalesce(max(updated_at)::text, '') from public.app_settings where key = 'markup_bp'),
    'alerts', (select count(*) || ':' || coalesce(max(updated_at)::text, '') from public.price_alerts),
    'provider_pause', (select value from public.app_settings where key = 'provider_pause'),
    'awaiting_ticket', (select count(*) from public.bookings where status = 'paid'),
    'needs_review', (select count(*) from public.bookings where needs_review),
    'last_paid', (select jsonb_build_object('reference', reference, 'amount_aoa', amount_aoa, 'paid_at', paid_at)
                    from public.bookings where paid_at is not null order by paid_at desc limit 1),
    'last_booking', (select jsonb_build_object('reference', reference, 'amount_aoa', amount_aoa, 'created_at', created_at, 'contact_name', contact_name)
                       from public.bookings order by created_at desc limit 1)
  );
$$;
