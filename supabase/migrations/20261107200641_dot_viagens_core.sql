-- DOT Viagens: esquema inicial (clientes, OTP, sessões, câmbio, pesquisas,
-- reservas, passageiros, pagamentos, SMS e auditoria).
--
-- Todo o acesso passa pelo Worker com a chave secreta (service_role).
-- RLS activo sem políticas: as roles anon e authenticated não lêem nem escrevem nada.
-- Aplicar uma única vez (MCP apply_migration ou SQL Editor do Supabase).

create extension if not exists pg_cron with schema pg_catalog;
-- Como no guia de instalação do Supabase Cron.
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create sequence public.booking_ref_seq;

-- Referência legível DOT-AAMMDD-00001. Passa a 6 ou mais dígitos sem cortar números.
create function public.next_booking_reference() returns text
language plpgsql volatile set search_path = '' as $$
declare
  n bigint := nextval('public.booking_ref_seq');
begin
  return 'DOT-' || to_char(now() at time zone 'Africa/Luanda', 'YYMMDD') || '-' || lpad(n::text, greatest(5, length(n::text)), '0');
end
$$;

-- Clientes e administradores (role = 'admin'). Telefone angolano de 9 dígitos, sem +244.
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique check (phone ~ '^9[0-9]{8}$'),
  name text check (char_length(name) <= 120),
  email text check (char_length(email) <= 160),
  role text not null default 'customer' check (role in ('customer', 'admin')),
  blocked boolean not null default false,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

-- Códigos OTP: só o HMAC do código é guardado. Expiram em 5 minutos, 5 tentativas.
create table public.otp_codes (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  purpose text not null default 'login' check (purpose in ('login', 'checkout', 'admin')),
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  ip_hash text,
  created_at timestamptz not null default now()
);
create index otp_codes_phone_created_idx on public.otp_codes (phone, created_at desc);
create index otp_codes_ip_created_idx on public.otp_codes (ip_hash, created_at desc);

-- Sessões por cookie HttpOnly: guarda-se o SHA-256 do token, nunca o token.
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  token_hash text not null unique,
  user_agent text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sessions_customer_idx on public.sessions (customer_id);

-- Câmbio do dia: 1 BRL = rate Kz. Vale sempre o registo mais recente.
create table public.exchange_rates (
  id bigint generated always as identity primary key,
  base text not null default 'BRL',
  quote text not null default 'AOA',
  rate numeric(14, 4) not null check (rate > 0),
  effective_date date not null default ((now() at time zone 'Africa/Luanda')::date),
  note text,
  created_by uuid references public.customers (id) on delete set null,
  created_at timestamptz not null default now()
);
create index exchange_rates_created_idx on public.exchange_rates (created_at desc);

-- Pesquisas para o painel em tempo real. Guardadas 7 dias (limpeza horária abaixo).
create table public.search_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  origin text not null,
  destination text not null,
  departure_date date not null,
  return_date date,
  passengers integer not null,
  kind text,
  has_token boolean not null default false,
  cached boolean not null default false,
  status text not null check (status in ('ok', 'empty', 'error')),
  offers_count integer,
  min_price_brl numeric(12, 2),
  error_code text,
  duration_ms integer,
  visitor text,
  session_id text,
  country text,
  customer_id uuid references public.customers (id) on delete set null
);
create index search_logs_created_idx on public.search_logs (created_at desc);
create index search_logs_route_idx on public.search_logs (origin, destination, created_at desc);

-- Reservas. A venda é gravada antes de qualquer chamada à Wiza (lei 1 do guia).
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default public.next_booking_reference(),
  customer_id uuid not null references public.customers (id),
  status text not null default 'pending_payment' check (status in ('pending_payment', 'paid', 'payment_failed', 'expired', 'ticketed', 'cancelled', 'refunded')),
  needs_review boolean not null default false,
  contact_name text not null,
  contact_phone text not null,
  contact_email text not null,
  trip_type text not null check (trip_type in ('oneway', 'return')),
  origin text not null,
  destination text not null,
  departure_date date not null,
  return_date date,
  passengers_count integer not null check (passengers_count between 1 and 9),
  itinerary jsonb not null,
  price_brl numeric(12, 2) not null,
  exchange_rate numeric(14, 4) not null,
  amount_aoa bigint not null check (amount_aoa >= 100),
  invoice_nif text,
  invoice_name text,
  payment_attempts integer not null default 0,
  wiza_reference_id text,
  wiza_payment_id text,
  -- Cobranças anteriores da mesma reserva: uma referência antiga ainda pode ser paga no ATM.
  wiza_previous_ids text[] not null default '{}'::text[],
  wiza_paid_payment_id text,
  wiza_nonce text,
  wiza_hosted_url text,
  wiza_status text,
  wiza_status_code text,
  wiza_service text,
  wiza_atm_entity text,
  wiza_atm_reference text,
  wiza_created_at timestamptz,
  wiza_checked_at timestamptz,
  wiza_window_closed boolean not null default false,
  paid_at timestamptz,
  vero_customer_id text,
  vero_invoice_id text,
  vero_invoice_number text,
  vero_pdf_url text,
  vero_agt_status text,
  vero_error text,
  invoiced_at timestamptz,
  ticket_pnr text,
  ticket_numbers text,
  ticket_notes text,
  ticketed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  admin_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index bookings_customer_idx on public.bookings (customer_id, created_at desc);
create index bookings_status_idx on public.bookings (status, created_at desc);
create unique index bookings_wiza_payment_idx on public.bookings (wiza_payment_id) where wiza_payment_id is not null;
create index bookings_wiza_reference_idx on public.bookings (wiza_reference_id);
create index bookings_wiza_previous_idx on public.bookings using gin (wiza_previous_ids);

-- Passageiros com os dados que a companhia aérea pede.
create table public.booking_passengers (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  position integer not null,
  title text not null check (title in ('MR', 'MS')),
  given_names text not null,
  surname text not null,
  birth_date date not null,
  nationality text not null check (nationality ~ '^[A-Z]{2}$'),
  document_type text not null default 'passport',
  document_number text not null,
  document_country text not null check (document_country ~ '^[A-Z]{2}$'),
  document_expiry date not null,
  created_at timestamptz not null default now(),
  unique (booking_id, position)
);
create index booking_passengers_booking_idx on public.booking_passengers (booking_id);

-- Histórico de cada pagamento: criação, consultas, callbacks e confirmações.
create table public.payment_events (
  id bigint generated always as identity primary key,
  booking_id uuid references public.bookings (id) on delete cascade,
  source text not null,
  outcome text,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index payment_events_booking_idx on public.payment_events (booking_id, id desc);

-- SMS enviados pela Nsangu (o texto das OTP nunca é guardado).
create table public.sms_messages (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  provider_id text,
  phone text not null,
  category text not null check (category in ('OTP', 'TRANSACTIONAL')),
  purpose text,
  booking_id uuid references public.bookings (id) on delete set null,
  status text,
  sender text,
  segments integer,
  failure_code text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sms_messages_created_idx on public.sms_messages (created_at desc);
create index sms_messages_booking_idx on public.sms_messages (booking_id);

-- Quem fez o quê no painel.
create table public.admin_audit (
  id bigint generated always as identity primary key,
  admin_id uuid references public.customers (id) on delete set null,
  action text not null,
  target text,
  details jsonb,
  created_at timestamptz not null default now()
);
create index admin_audit_target_idx on public.admin_audit (target, id desc);

create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create trigger bookings_touch before update on public.bookings
  for each row execute function public.touch_updated_at();
create trigger sms_messages_touch before update on public.sms_messages
  for each row execute function public.touch_updated_at();

-- Verificação atómica do OTP: bloqueia a linha, conta tentativas e consome o código.
create function public.verify_otp(p_phone text, p_code_hash text) returns text
language plpgsql set search_path = '' as $$
declare
  r public.otp_codes%rowtype;
begin
  select * into r from public.otp_codes
   where phone = p_phone and consumed_at is null
   order by created_at desc
   limit 1
   for update;
  if not found then return 'missing'; end if;
  if r.expires_at < now() then return 'expired'; end if;
  if r.attempts >= 5 then return 'locked'; end if;
  if r.code_hash = p_code_hash then
    update public.otp_codes set consumed_at = now() where id = r.id;
    return 'ok';
  end if;
  update public.otp_codes set attempts = attempts + 1 where id = r.id;
  return case when r.attempts + 1 >= 5 then 'locked' else 'invalid' end;
end
$$;

-- Números do painel (dia civil de Luanda).
create function public.admin_overview() returns jsonb
language sql stable set search_path = '' as $$
  with t as (
    select (date_trunc('day', now() at time zone 'Africa/Luanda') at time zone 'Africa/Luanda') as today
  )
  select jsonb_build_object(
    'searches_today', (select count(*) from public.search_logs s, t where s.created_at >= t.today),
    'searches_hour', (select count(*) from public.search_logs where created_at >= now() - interval '1 hour'),
    'searches_7d', (select count(*) from public.search_logs),
    'visitors_today', (select count(distinct visitor) from public.search_logs s, t where s.created_at >= t.today),
    'bookings_by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) as n from public.bookings group by status) b), '{}'::jsonb),
    'bookings_today', (select count(*) from public.bookings b, t where b.created_at >= t.today),
    'paid_today', (select count(*) from public.bookings b, t where b.paid_at >= t.today and b.status in ('paid', 'ticketed')),
    'revenue_today', (select coalesce(sum(amount_aoa), 0) from public.bookings b, t where b.paid_at >= t.today and b.status in ('paid', 'ticketed')),
    'revenue_30d', (select coalesce(sum(amount_aoa), 0) from public.bookings where paid_at >= now() - interval '30 days' and status in ('paid', 'ticketed')),
    'revenue_total', (select coalesce(sum(amount_aoa), 0) from public.bookings where status in ('paid', 'ticketed')),
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

-- Estatísticas das pesquisas (no máximo 7 dias, o período guardado).
create function public.admin_search_stats(p_days integer default 7) returns jsonb
language sql stable set search_path = '' as $$
  with recent as (
    select * from public.search_logs
     where created_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 7)))
  )
  select jsonb_build_object(
    'total', (select count(*) from recent),
    'visitors', (select count(distinct visitor) from recent),
    'errors', (select count(*) from recent where status = 'error'),
    'empty', (select count(*) from recent where status = 'empty'),
    'cached', (select count(*) from recent where cached),
    'top_routes', coalesce((
      select jsonb_agg(r order by r.n desc) from (
        select origin, destination, count(*) as n, count(distinct visitor) as visitors, min(min_price_brl) as min_price_brl
          from recent
         where kind is null or kind not in ('prefetch', 'return-prefetch')
         group by origin, destination
         order by count(*) desc
         limit 10
      ) r
    ), '[]'::jsonb),
    'per_day', coalesce((
      select jsonb_agg(d order by d.day) from (
        select (created_at at time zone 'Africa/Luanda')::date as day, count(*) as n
          from recent group by 1
      ) d
    ), '[]'::jsonb)
  );
$$;

-- Segurança: RLS sem políticas e sem privilégios para anon/authenticated.
-- Desde 30/10/2026 o Supabase não concede acesso automático a tabelas novas:
-- o service_role (chave secreta usada só pelo Worker) recebe aqui o mínimo necessário.
alter table public.customers enable row level security;
alter table public.otp_codes enable row level security;
alter table public.sessions enable row level security;
alter table public.exchange_rates enable row level security;
alter table public.search_logs enable row level security;
alter table public.bookings enable row level security;
alter table public.booking_passengers enable row level security;
alter table public.payment_events enable row level security;
alter table public.sms_messages enable row level security;
alter table public.admin_audit enable row level security;

revoke all on table
  public.customers, public.otp_codes, public.sessions, public.exchange_rates, public.search_logs,
  public.bookings, public.booking_passengers, public.payment_events, public.sms_messages, public.admin_audit
  from anon, authenticated;
revoke all on sequence
  public.booking_ref_seq, public.exchange_rates_id_seq, public.search_logs_id_seq,
  public.payment_events_id_seq, public.admin_audit_id_seq
  from anon, authenticated;

revoke all on function public.verify_otp(text, text) from public, anon, authenticated;
revoke all on function public.admin_overview() from public, anon, authenticated;
revoke all on function public.admin_search_stats(integer) from public, anon, authenticated;
revoke all on function public.next_booking_reference() from public, anon, authenticated;
revoke all on function public.touch_updated_at() from public, anon, authenticated;

grant usage on schema public to service_role;
grant select, insert, update, delete on table
  public.customers, public.otp_codes, public.sessions, public.exchange_rates, public.search_logs,
  public.bookings, public.booking_passengers, public.payment_events, public.sms_messages, public.admin_audit
  to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on function public.verify_otp(text, text) to service_role;
grant execute on function public.admin_overview() to service_role;
grant execute on function public.admin_search_stats(integer) to service_role;
grant execute on function public.next_booking_reference() to service_role;

-- Limpeza automática (pg_cron). Pesquisas: 7 dias. OTP: 1 dia. Sessões terminadas: 7 dias.
-- Reservas sem pagamento há 72 horas passam a 'expired' (uma referência paga depois ainda é aceite).
select cron.schedule('dot-purge-search-logs', '7 * * * *',
  $$delete from public.search_logs where created_at < now() - interval '7 days'$$);
select cron.schedule('dot-purge-otp', '17 * * * *',
  $$delete from public.otp_codes where created_at < now() - interval '1 day'$$);
select cron.schedule('dot-purge-sessions', '19 * * * *',
  $$delete from public.sessions where expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days'$$);
select cron.schedule('dot-expire-bookings', '27 * * * *',
  $$update public.bookings set status = 'expired' where status = 'pending_payment' and created_at < now() - interval '72 hours'$$);
