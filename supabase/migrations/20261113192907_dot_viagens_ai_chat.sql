-- 13/11/2026: compra por IA (chat). Conversas, custo e reservas feitas pela IA.
alter table public.bookings add column channel text not null default 'site' check (channel in ('site', 'ai'));

create table public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  visitor text,
  country text,
  city text,
  customer_id uuid references public.customers (id) on delete set null,
  booking_id uuid references public.bookings (id) on delete set null,
  status text not null default 'open' check (status in ('open', 'booked', 'blocked')),
  model text,
  messages jsonb not null default '[]'::jsonb,
  state jsonb not null default '{}'::jsonb,
  user_messages integer not null default 0,
  provider_searches integer not null default 0,
  calendar_lookups integer not null default 0,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ai_conversations_created_idx on public.ai_conversations (created_at desc);
create index ai_conversations_visitor_idx on public.ai_conversations (visitor, created_at desc);
create trigger ai_conversations_touch before update on public.ai_conversations
  for each row execute function public.touch_updated_at();

alter table public.ai_conversations enable row level security;
revoke all on table public.ai_conversations from anon, authenticated;
grant select, insert, update, delete on table public.ai_conversations to service_role;

-- Conversas sem compra apagadas ao fim de 90 dias.
select cron.schedule('dot-delete-old-ai-conversations', '53 3 * * *',
  $$delete from public.ai_conversations where booking_id is null and created_at < now() - interval '90 days'$$);
