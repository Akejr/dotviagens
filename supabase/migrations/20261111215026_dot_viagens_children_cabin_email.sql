-- 12/11/2026: crianças e classes na pesquisa, tipo de cada passageiro e e-mails da compra (Resend).

-- As pesquisas guardam as crianças e a classe: os preços reais por cima do calendário e os avisos
-- de preço só usam pesquisas de adultos em económica.
alter table public.search_logs add column children integer not null default 0 check (children between 0 and 9);
alter table public.search_logs add column cabin text not null default 'economy' check (cabin in ('economy', 'premium_economy', 'business', 'first'));

-- Adulto (12 anos ou mais na data da viagem) ou criança (2 a 11).
alter table public.booking_passengers add column passenger_type text not null default 'adult' check (passenger_type in ('adult', 'child'));

-- E-mails enviados pela Resend (confirmação ao cliente com a factura, aviso de compra ao admin).
create table public.email_messages (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  provider_id text,
  to_address text not null,
  purpose text,
  booking_id uuid references public.bookings (id) on delete set null,
  status text,
  with_invoice boolean not null default false,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index email_messages_booking_idx on public.email_messages (booking_id);
create trigger email_messages_touch before update on public.email_messages
  for each row execute function public.touch_updated_at();

alter table public.email_messages enable row level security;
revoke all on table public.email_messages from anon, authenticated;
grant select, insert, update, delete on table public.email_messages to service_role;
