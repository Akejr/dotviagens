-- DOT Viagens: forma de pagamento escolhida na compra.
-- 'wiza'   = Multicaixa Express ou referência, na página segura da Wiza (confirmação automática);
-- 'manual' = pagamento combinado com a equipa DOT no WhatsApp (confirmado à mão no painel).
alter table public.bookings
  add column payment_method text not null default 'wiza' check (payment_method in ('wiza', 'manual'));
