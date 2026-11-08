-- DOT Viagens: cache partilhado dos preços do calendário (SerpApi Google Flights Calendar).
-- Um mês já consultado por qualquer visitante abre instantaneamente para os outros durante 6 horas.
create table public.calendar_cache (
  cache_key text primary key,
  prices jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index calendar_cache_expires_idx on public.calendar_cache (expires_at);

alter table public.calendar_cache enable row level security;
revoke all on table public.calendar_cache from public, anon, authenticated;
grant select, insert, update, delete on table public.calendar_cache to service_role;

-- Limpeza de hora a hora das entradas expiradas.
select cron.schedule('dot-purge-calendar-cache', '37 * * * *',
  $$delete from public.calendar_cache where expires_at < now() - interval '1 hour'$$);
