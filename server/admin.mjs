// Admin API (/api/admin/*). Every route requires a session with role = 'admin';
// every change is written to admin_audit.

import { HttpError, json, readJson, assertSameOrigin, cleanText, isoDate } from './http.mjs';
import { db, hasSupabase, searchTerm } from './supabase.mjs';
import { requireAdmin, forgetSessionsOf, adminPhones } from './auth.mjs';
import { hasAi, DEFAULT_MODEL } from './ai.mjs';
import { currentRate, currentMarkup, forgetRate, luandaToday, validMarkup, MAX_MARKUP_BP } from './rates.mjs';
import { providerAccount, pausedUntil, resumeProvider } from './provider.mjs';
import { searchApiOn, providerName } from './searchapi.mjs';
import { hasSms, smsBalance, smsStatus, smsText } from './sms.mjs';
import { hasWiza } from './wiza.mjs';
import { hasVero, isVeroSandbox } from './vero.mjs';
import { sendAndRecord } from './notify.mjs';
import { syncPayment, confirmPayment, issueBookingInvoice, refreshInvoiceStatus, runSweep, logEvent, sendLateInvoice, REFERENCE, STATUS_LABEL } from './bookings.mjs';
import { hasEmail } from './emails.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(Object.keys(STATUS_LABEL));
const nowIso = () => new Date().toISOString();
let balanceCache = { value: null, until: 0 };

// Whole kwanzas typed in the panel: "270 000", "270.000", "270000 Kz", "-15 000" (a loss).
// Empty clears the value (null); anything else that is not a number is undefined.
export function parseKz(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && Number.isSafeInteger(Math.round(value)) ? Math.round(value) : undefined;
  const text = String(value).replace(/kz|aoa/gi, '').replace(/\s/g, '');
  if (!text) return null;
  if (!/^-?\d[\d.,]*$/.test(text)) return undefined;
  const number = text.includes(',') ? Math.round(Number(text.replace(/\./g, '').replace(',', '.'))) : Number(text.replace(/\./g, ''));
  return Number.isSafeInteger(number) ? number : undefined;
}

async function audit(store, session, action, target, details = null) {
  await store.insert('admin_audit', { admin_id: session.customer.id, action, target, details }, { returning: false })
    .catch(error => console.error('audit not saved:', error.message));
}

const integrations = env => ({
  supabase: hasSupabase(env),
  search: searchApiOn(env) || Boolean(env.SERPAPI_KEY),
  searchProvider: providerName(env),
  sms: hasSms(env),
  email: hasEmail(env),
  ai: hasAi(env),
  aiModel: hasAi(env) ? (env.AI_MODEL || DEFAULT_MODEL) : null,
  payments: hasWiza(env),
  invoices: hasVero(env),
  invoicesSandbox: isVeroSandbox(env),
  offerSigning: String(env.OFFER_SECRET || '').length >= 16,
  auth: String(env.AUTH_SECRET || '').length >= 16,
  cron: String(env.CRON_SECRET || '').length >= 16,
  publicBaseUrl: env.PUBLIC_BASE_URL || null,
  bootstrapAdmins: adminPhones(env).size,
});

async function cachedBalance(env, deps) {
  if (!hasSms(env)) return null;
  if (balanceCache.until > Date.now()) return balanceCache.value;
  const value = await smsBalance(env, deps).catch(() => null);
  balanceCache = { value, until: Date.now() + 60000 };
  return value;
}

const pageParams = url => ({
  limit: Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 25)),
  offset: Math.max(0, Number(url.searchParams.get('offset')) || 0),
});

// Light state polled by the dashboard every few seconds: counters and last-change marks
// per topic, so each screen reloads only when its data changed.
export async function live(request, env, ctx, deps) {
  await requireAdmin(request, env, deps);
  const state = await db(env, deps.fetcher).rpc('admin_live_state');
  return json({ state, serverTime: nowIso() });
}

export async function overview(request, env, ctx, deps) {
  await requireAdmin(request, env, deps);
  const store = db(env, deps.fetcher);
  const [stats, rate, sms, markup, serp, paused] = await Promise.all([
    store.rpc('admin_overview'),
    currentRate(env, deps, { fresh: true }).catch(() => null),
    cachedBalance(env, deps),
    currentMarkup(env, deps, { fresh: true }),
    providerAccount(env, deps),
    pausedUntil(env, deps).catch(() => 0),
  ]);
  return json({
    stats, rate, sms, serp,
    provider: { pausedUntil: paused ? new Date(paused).toISOString() : null },
    pricing: { markupBp: markup.markupBp },
    today: luandaToday(), integrations: integrations(env), serverTime: nowIso(),
  });
}

export async function listRates(request, env, ctx, deps) {
  await requireAdmin(request, env, deps);
  const [rows, markup] = await Promise.all([
    db(env, deps.fetcher).select('exchange_rates', {
      select: 'id,rate,effective_date,note,created_at,creator:customers(name,phone)',
      order: 'created_at.desc',
      limit: 60,
    }),
    currentMarkup(env, deps, { fresh: true }),
  ]);
  return json({ rows, today: luandaToday(), pricing: markup });
}

// DOT fee on top of the converted price: "11", "11,5" or "12.25" (%), 0% to 50%.
export async function setMarkup(request, env, ctx, deps) {
  assertSameOrigin(request);
  const session = await requireAdmin(request, env, deps);
  const body = await readJson(request, 2000);
  const percent = Number(String(body.markupPercent ?? '').replace('%', '').replace(',', '.').trim());
  const markupBp = Math.round(percent * 100);
  if (!Number.isFinite(percent) || String(body.markupPercent ?? '').trim() === '' || !validMarkup(markupBp)) {
    throw new HttpError(400, `Indica a taxa em percentagem, de 0 a ${MAX_MARKUP_BP / 100} (por exemplo 11 ou 11,5).`, 'INVALID_MARKUP');
  }
  const store = db(env, deps.fetcher);
  const before = await currentMarkup(env, deps, { fresh: true });
  await store.upsert('app_settings', [{ key: 'markup_bp', value: markupBp, updated_at: nowIso(), updated_by: session.customer.id }], 'key');
  forgetRate();
  await audit(store, session, 'pricing.markup', `${markupBp / 100}%`, { from: before.markupBp, to: markupBp });
  return json({ pricing: await currentMarkup(env, deps, { fresh: true }) });
}

// Ends the pause of SerpApi calls (for example after renewing the plan).
export async function resumeSearches(request, env, ctx, deps) {
  assertSameOrigin(request);
  const session = await requireAdmin(request, env, deps);
  await resumeProvider(env, deps);
  await audit(db(env, deps.fetcher), session, 'provider.resume', 'serpapi');
  return json({ ok: true });
}

export async function addRate(request, env, ctx, deps) {
  assertSameOrigin(request);
  const session = await requireAdmin(request, env, deps);
  const body = await readJson(request, 2000);
  const rate = Math.round(Number(String(body.rate ?? '').replace(',', '.')) * 10000) / 10000;
  if (!(rate >= 1 && rate <= 100000)) throw new HttpError(400, 'Indica quantos kwanzas vale 1 real (por exemplo 165,50).', 'INVALID_RATE');
  const effectiveDate = isoDate(body.effectiveDate) ? body.effectiveDate : luandaToday();
  const note = cleanText(body.note, 140) || null;
  const store = db(env, deps.fetcher);
  const [row] = await store.insert('exchange_rates', { rate, effective_date: effectiveDate, note, created_by: session.customer.id });
  forgetRate();
  await audit(store, session, 'rate.set', String(rate), { effectiveDate, note });
  return json({ rate: row }, 201);
}

// One row per customer search ("journey"): the neighbour dates, returns and
// prefetches it triggered are grouped. Provider calls are listed by searchCalls.
export async function searches(request, env, ctx, deps) {
  await requireAdmin(request, env, deps);
  const url = new URL(request.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));
  const store = db(env, deps.fetcher);
  const [journeys, stats] = await Promise.all([
    store.rpc('admin_search_journeys', { p_limit: limit }),
    url.searchParams.get('stats') === '1' ? store.rpc('admin_search_stats', { p_days: 7 }) : null,
  ]);
  const { markupBp } = await currentMarkup(env, deps);
  return json({ journeys: journeys || [], stats, pricing: { markupBp } });
}

const JOURNEY_KEY = /^[A-Za-z0-9|:-]{3,120}$/;

export async function searchCalls(request, env, ctx, deps) {
  await requireAdmin(request, env, deps);
  const key = new URL(request.url).searchParams.get('key') || '';
  if (!JOURNEY_KEY.test(key)) throw new HttpError(400, 'Pesquisa inválida.', 'INVALID_KEY');
  // Rows without a journey key are shown as "id:<row id>".
  const single = key.match(/^id:(\d{1,18})$/);
  const rows = await db(env, deps.fetcher).select('search_logs', {
    select: 'id,created_at,departure_date,return_date,kind,has_token,cached,status,offers_count,min_price_brl,error_code,duration_ms',
    ...(single ? { id: `eq.${single[1]}` } : { journey_key: `eq.${key}` }),
    order: 'id.asc',
    limit: 200,
  });
  return json({ rows });
}

export async function listBookings(request, env, ctx, deps) {
  await requireAdmin(request, env, deps);
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const term = searchTerm(url.searchParams.get('q'));
  const params = {
    select: 'id,reference,status,needs_review,created_at,paid_at,contact_name,contact_phone,contact_email,trip_type,origin,destination,departure_date,return_date,passengers_count,amount_aoa,profit_aoa,imported,channel,payment_method,wiza_status,wiza_service,wiza_status_code,vero_invoice_number,vero_agt_status,vero_error,ticket_pnr',
    order: 'created_at.desc',
    ...pageParams(url),
  };
  if (STATUSES.has(status)) params.status = `eq.${status}`;
  if (status === 'review') params.needs_review = 'is.true';
  // Paid sales whose profit the team has not entered yet.
  if (status === 'no_profit') Object.assign(params, { status: 'in.(paid,ticketed)', profit_aoa: 'is.null' });
  // Quoted values: e-mails contain dots, a reserved character in PostgREST logic filters.
  if (term) params.or = `(reference.ilike."*${term}*",contact_phone.ilike."*${term}*",contact_name.ilike."*${term}*",contact_email.ilike."*${term}*")`;
  const { rows, total } = await db(env, deps.fetcher).selectCount('bookings', params);
  return json({ rows, total });
}

async function loadBooking(store, reference) {
  if (!REFERENCE.test(reference || '')) throw new HttpError(404, 'Reserva não encontrada.', 'NOT_FOUND');
  const booking = await store.one('bookings', { select: '*,booking_passengers(*),customer:customers(id,name,phone,email,role,created_at)', reference: `eq.${reference}` });
  if (!booking) throw new HttpError(404, 'Reserva não encontrada.', 'NOT_FOUND');
  booking.booking_passengers = (booking.booking_passengers || []).sort((a, b) => a.position - b.position);
  return booking;
}

async function bookingPayload(store, reference, env) {
  const booking = await loadBooking(store, reference);
  const [events, sms, auditRows, emails] = await Promise.all([
    store.select('payment_events', { select: '*', booking_id: `eq.${booking.id}`, order: 'id.desc', limit: 100 }),
    store.select('sms_messages', { select: '*', booking_id: `eq.${booking.id}`, order: 'created_at.desc', limit: 50 }),
    store.select('admin_audit', { select: '*,admin:customers(name,phone)', target: `eq.${booking.reference}`, order: 'id.desc', limit: 50 }),
    store.select('email_messages', { select: '*', booking_id: `eq.${booking.id}`, order: 'created_at.desc', limit: 20 }).catch(() => []),
  ]);
  return { booking, events, sms, emails, audit: auditRows, statusLabel: STATUS_LABEL[booking.status], invoicesSandbox: isVeroSandbox(env) };
}

export async function bookingDetail(request, env, ctx, deps) {
  await requireAdmin(request, env, deps);
  return json(await bookingPayload(db(env, deps.fetcher), deps.params[0], env));
}

export async function bookingAction(request, env, ctx, deps) {
  assertSameOrigin(request);
  const session = await requireAdmin(request, env, deps);
  const body = await readJson(request, 8000);
  const store = db(env, deps.fetcher);
  let booking = await loadBooking(store, deps.params[0]);
  const reference = booking.reference;
  const result = {};
  const auditExtra = {};
  const action = String(body.action || '');

  switch (action) {
    case 'recheck': {
      if (!booking.wiza_payment_id) throw new HttpError(409, 'Esta reserva ainda não tem pagamento iniciado.', 'NO_PAYMENT');
      booking = await syncPayment(env, store, booking, 'admin', ctx, deps);
      break;
    }
    case 'confirm_manual': {
      if (!['pending_payment', 'payment_failed', 'expired'].includes(booking.status)) throw new HttpError(409, 'Esta reserva não está à espera de pagamento.', 'INVALID_STATE');
      const note = cleanText(body.note, 300);
      if (note.length < 8) throw new HttpError(400, 'Indica a justificação (por exemplo, pagamento confirmado no painel da Wiza).', 'NOTE_REQUIRED');
      booking = await confirmPayment(env, store, booking, { code: 'manual', service: booking.wiza_service, note, by: session.customer.id }, 'admin', ctx, deps);
      break;
    }
    case 'ticket': {
      if (!['paid', 'ticketed'].includes(booking.status)) throw new HttpError(409, 'Só é possível emitir o bilhete de uma reserva paga.', 'INVALID_STATE');
      const pnr = cleanText(body.pnr, 12).toUpperCase();
      if (!/^[A-Z0-9]{5,8}$/.test(pnr)) throw new HttpError(400, 'O código da reserva (PNR) tem 5 a 8 letras ou algarismos.', 'INVALID_PNR');
      const firstTime = booking.status !== 'ticketed';
      const pnrChanged = booking.ticket_pnr && booking.ticket_pnr !== pnr;
      [booking] = await store.update('bookings', { id: `eq.${booking.id}` }, {
        status: 'ticketed',
        ticket_pnr: pnr,
        ticket_numbers: cleanText(body.ticketNumbers, 300) || null,
        ticket_notes: cleanText(body.notes, 500) || null,
        ticketed_at: booking.ticketed_at || nowIso(),
      });
      if (body.notify !== false && (firstTime || pnrChanged)) {
        await sendAndRecord(env, store, {
          phone: booking.contact_phone,
          text: smsText.ticketed(reference, pnr),
          category: 'TRANSACTIONAL',
          purpose: 'ticket_issued',
          idempotencyKey: `booking-${reference}-ticketed-${pnr}`,
          bookingId: booking.id,
        }, deps).catch(error => {
          result.smsError = error.message || 'SMS não enviado.';
        });
      }
      break;
    }
    case 'cancel': {
      if (['cancelled', 'refunded'].includes(booking.status)) throw new HttpError(409, 'Esta reserva já está cancelada.', 'INVALID_STATE');
      const reason = cleanText(body.reason, 300);
      if (reason.length < 3) throw new HttpError(400, 'Indica o motivo do cancelamento.', 'REASON_REQUIRED');
      const wasPaid = ['paid', 'ticketed'].includes(booking.status);
      [booking] = await store.update('bookings', { id: `eq.${booking.id}` }, { status: 'cancelled', cancelled_at: nowIso(), cancel_reason: reason });
      if (body.notify && wasPaid) {
        await sendAndRecord(env, store, {
          phone: booking.contact_phone,
          text: smsText.cancelled(reference),
          category: 'TRANSACTIONAL',
          purpose: 'booking_cancelled',
          idempotencyKey: `booking-${reference}-cancelled`,
          bookingId: booking.id,
        }, deps).catch(error => {
          result.smsError = error.message || 'SMS não enviado.';
        });
      }
      break;
    }
    case 'refund': {
      if (!['paid', 'ticketed', 'cancelled'].includes(booking.status)) throw new HttpError(409, 'Só reservas pagas ou canceladas podem ser marcadas como reembolsadas.', 'INVALID_STATE');
      const note = cleanText(body.note, 300);
      if (note.length < 3) throw new HttpError(400, 'Indica como foi feito o reembolso.', 'NOTE_REQUIRED');
      const notes = [booking.admin_notes, `Reembolso (${new Date().toLocaleDateString('pt-PT')}): ${note}`].filter(Boolean).join('\n');
      [booking] = await store.update('bookings', { id: `eq.${booking.id}` }, { status: 'refunded', admin_notes: notes.slice(0, 4000) });
      break;
    }
    case 'invoice': {
      if (!['paid', 'ticketed'].includes(booking.status)) throw new HttpError(409, 'A factura só é emitida depois do pagamento.', 'INVALID_STATE');
      try {
        const issued = !booking.vero_invoice_id;
        booking = booking.vero_invoice_id
          ? await refreshInvoiceStatus(env, store, booking, deps)
          : await issueBookingInvoice(env, store, booking, deps, { poll: false });
        // A first invoice for a site sale reaches the customer by e-mail (not for sales made outside).
        if (issued && booking.vero_invoice_id && !booking.imported) await sendLateInvoice(env, store, { ...booking, booking_passengers: (await loadBooking(store, reference)).booking_passengers }, deps);
      } catch (error) {
        result.invoiceError = `A factura não foi emitida (${error.code || 'erro'}).`;
      }
      break;
    }
    case 'note': {
      [booking] = await store.update('bookings', { id: `eq.${booking.id}` }, { admin_notes: cleanText(body.text, 4000) || null });
      break;
    }
    case 'clear_review': {
      [booking] = await store.update('bookings', { id: `eq.${booking.id}` }, { needs_review: false });
      break;
    }
    case 'profit': {
      // What DOT really earned (total paid minus the cost of the ticket), typed by the team
      // after buying the ticket. This, not the 11% in the price, is the profit in the panel.
      if (!['paid', 'ticketed'].includes(booking.status)) throw new HttpError(409, 'O lucro só se regista numa compra paga.', 'INVALID_STATE');
      const profit = parseKz(body.profitAoa);
      if (profit === undefined) throw new HttpError(400, 'Escreve o lucro em kwanzas, por exemplo 270 000.', 'INVALID_PROFIT');
      if (profit !== null && Math.abs(profit) > Number(booking.amount_aoa)) throw new HttpError(400, 'O lucro não pode passar do total pago pelo cliente.', 'INVALID_PROFIT');
      auditExtra.previous = booking.profit_aoa == null ? null : Number(booking.profit_aoa);
      [booking] = await store.update('bookings', { id: `eq.${booking.id}` }, { profit_aoa: profit });
      auditExtra.profitAoa = profit;
      break;
    }
    default:
      throw new HttpError(400, 'Acção desconhecida.', 'UNKNOWN_ACTION');
  }

  await audit(store, session, `booking.${action}`, reference, {
    status: booking.status,
    ...(body.pnr ? { pnr: String(body.pnr).slice(0, 12) } : {}),
    ...(body.reason ? { reason: String(body.reason).slice(0, 300) } : {}),
    ...(body.note ? { note: String(body.note).slice(0, 300) } : {}),
    ...auditExtra,
  });
  if (action === 'confirm_manual') await logEvent(store, booking.id, 'admin', 'manual_confirmation', { by: session.customer.phone });
  return json({ ...(await bookingPayload(store, reference, env)), ...result });
}

export async function listCustomers(request, env, ctx, deps) {
  await requireAdmin(request, env, deps);
  const url = new URL(request.url);
  const term = searchTerm(url.searchParams.get('q'));
  const params = {
    select: 'id,phone,name,email,role,blocked,created_at,last_login_at,bookings(count)',
    order: 'created_at.desc',
    ...pageParams(url),
  };
  if (url.searchParams.get('role') === 'admin') params.role = 'eq.admin';
  if (term) params.or = `(phone.ilike."*${term}*",name.ilike."*${term}*",email.ilike."*${term}*")`;
  const { rows, total } = await db(env, deps.fetcher).selectCount('customers', params);
  return json({ rows, total });
}

export async function updateCustomer(request, env, ctx, deps) {
  assertSameOrigin(request);
  const session = await requireAdmin(request, env, deps);
  const id = deps.params[0];
  if (!UUID.test(id)) throw new HttpError(404, 'Utilizador não encontrado.', 'NOT_FOUND');
  const body = await readJson(request, 2000);
  const patch = {};
  if (body.role === 'admin' || body.role === 'customer') patch.role = body.role;
  if (typeof body.blocked === 'boolean') patch.blocked = body.blocked;
  if (!Object.keys(patch).length) throw new HttpError(400, 'Nada para alterar.', 'NOTHING_TO_UPDATE');
  if (id === session.customer.id && (patch.role === 'customer' || patch.blocked)) {
    throw new HttpError(400, 'Não podes retirar o teu próprio acesso.', 'SELF_LOCKOUT');
  }
  const store = db(env, deps.fetcher);
  const [row] = await store.update('customers', { id: `eq.${id}` }, patch);
  if (!row) throw new HttpError(404, 'Utilizador não encontrado.', 'NOT_FOUND');
  if (patch.blocked) await store.update('sessions', { customer_id: `eq.${id}`, revoked_at: 'is.null' }, { revoked_at: nowIso() });
  forgetSessionsOf(id);
  await audit(store, session, 'customer.update', row.phone, patch);
  return json({ customer: row });
}

export async function listSms(request, env, ctx, deps) {
  await requireAdmin(request, env, deps);
  const url = new URL(request.url);
  const params = { select: '*,booking:bookings(reference)', order: 'created_at.desc', ...pageParams(url) };
  const category = url.searchParams.get('category');
  if (category === 'OTP' || category === 'TRANSACTIONAL') params.category = `eq.${category}`;
  const [{ rows, total }, balance] = await Promise.all([
    db(env, deps.fetcher).selectCount('sms_messages', params),
    cachedBalance(env, deps),
  ]);
  return json({ rows, total, balance });
}

export async function refreshSms(request, env, ctx, deps) {
  assertSameOrigin(request);
  await requireAdmin(request, env, deps);
  const id = deps.params[0];
  if (!UUID.test(id)) throw new HttpError(404, 'Mensagem não encontrada.', 'NOT_FOUND');
  const store = db(env, deps.fetcher);
  const row = await store.one('sms_messages', { select: '*', id: `eq.${id}` });
  if (!row?.provider_id) throw new HttpError(409, 'Esta mensagem não chegou a ser aceite pela Nsangu.', 'NO_PROVIDER_ID');
  const message = await smsStatus(env, row.provider_id, deps).catch(error => {
    throw new HttpError(502, error.message || 'Não foi possível consultar a mensagem.', 'SMS_STATUS');
  });
  const [updated] = await store.update('sms_messages', { id: `eq.${id}` }, {
    status: message.status,
    sender: message.from ?? row.sender,
    segments: message.segments ?? row.segments,
    failure_code: message.failureCode ?? null,
  });
  return json({ sms: updated });
}

export async function listAudit(request, env, ctx, deps) {
  await requireAdmin(request, env, deps);
  const url = new URL(request.url);
  const { rows, total } = await db(env, deps.fetcher).selectCount('admin_audit', {
    select: '*,admin:customers(name,phone)',
    order: 'id.desc',
    ...pageParams(url),
  });
  return json({ rows, total });
}

export async function adminSweep(request, env, ctx, deps) {
  assertSameOrigin(request);
  const session = await requireAdmin(request, env, deps);
  const result = await runSweep(env, ctx, deps);
  await audit(db(env, deps.fetcher), session, 'system.sweep', null, result);
  return json(result);
}
