-- 13/11/2026: avisos de preco sem limite de SMS (sempre que o preco baixa face ao ultimo aviso)
-- e avisos com a data da ida passada apagados (antes passavam a 'expired').
alter table public.price_alerts add column last_alert_kz bigint;
alter table public.price_alerts add column last_alert_at timestamptz;
update public.price_alerts set last_alert_kz = coalesce(second_alert_kz, first_alert_kz), last_alert_at = coalesce(second_alert_at, first_alert_at) where alerts_sent > 0 and last_alert_kz is null;
update public.price_alerts set status = 'active' where status = 'done' and departure_date >= (now() at time zone 'Africa/Luanda')::date;
select cron.unschedule(jobid) from cron.job where jobname = 'dot-expire-price-alerts';
select cron.schedule('dot-delete-past-price-alerts', '47 * * * *',
  $$delete from public.price_alerts where departure_date < (now() at time zone 'Africa/Luanda')::date$$);
delete from public.price_alerts where departure_date < (now() at time zone 'Africa/Luanda')::date;