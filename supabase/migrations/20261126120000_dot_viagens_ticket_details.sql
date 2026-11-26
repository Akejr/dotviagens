-- Dados do bilhete emitido (voos, bagagem) para o e-mail e a pagina do bilhete.
alter table public.bookings add column if not exists ticket_details jsonb;
