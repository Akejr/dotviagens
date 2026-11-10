// Price alerts: a customer (phone confirmed by SMS code) asks for an SMS when the price of a
// search (route, dates and adults) drops. No extra SerpApi calls: the price is followed with
// the searches other visitors make for the same trip (checkAlerts runs after each fresh search).
// At most 2 SMS per alert:
//   1st when the price is more than 50 000 Kz below the price the customer saw;
//   2nd when it is at least 100 000 Kz below the price announced in the 1st SMS.

import { HttpError, json, readJson, assertSameOrigin, cleanText, publicOrigin } from './http.mjs';
import { db } from './supabase.mjs';
import { requireUser, requireAdmin, secret } from './auth.mjs';
import { validate } from './flights.mjs';
import { signOffer, signedQuery } from './offers.mjs';
import { currentRate, currentMarkup, priceAoa } from './rates.mjs';
import { smsText, ascii } from './sms.mjs';
import { sendAndRecord } from './notify.mjs';
import { timingSafeEqual } from './crypto.mjs';

export const FIRST_DROP_KZ = 50000;
export const SECOND_DROP_KZ = 100000;
const MAX_ACTIVE_PER_CUSTOMER = 10;
// The reference price comes from the results the customer is looking at (signed by the server).
const BASELINE_MAX_AGE_MS = 3 * 3600 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['active', 'done', 'expired', 'cancelled']);
const nowIso = () => new Date().toISOString();

// City names go into the SMS: plain letters only.
const placeName = value => ascii(cleanText(value, 40)).replace(/[^A-Za-z .'-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30) || null;
const yymmdd = iso => String(iso).slice(2, 10).replace(/-/g, '');

// Short link to the same search: /resultados?v=NBJLIS261218261228 + adults.
export const shortQuery = a => `${a.origin}${a.destination}${yymmdd(a.departure_date)}${a.return_date ? yymmdd(a.return_date) : ''}${a.passengers}`;

function linkFor(alert, base) {
  const host = String(base || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  return host ? `${host}/resultados?v=${shortQuery(alert)}` : null;
}

export const publicAlert = row => ({
  id: row.id,
  status: row.status,
  origin: row.origin,
  destination: row.destination,
  departureDate: row.departure_date,
  returnDate: row.return_date,
  passengers: row.passengers,
  baselineKz: Number(row.baseline_kz),
  alertsSent: row.alerts_sent,
  createdAt: row.created_at,
});

async function pricing(env, deps) {
  const [rate, markup] = await Promise.all([currentRate(env, deps).catch(() => null), currentMarkup(env, deps)]);
  return rate?.rate ? { rate: rate.rate, markupBp: markup.markupBp } : null;
}

const sameQuery = (a, b) => ['origin', 'destination', 'departureDate', 'returnDate', 'passengers'].every(key => (a[key] ?? null) === (b[key] ?? null));

// POST /api/alerts {query, offer: {offer, query, searchedAt}, names: {origin, destination}}
export async function createAlert(request, env, ctx, deps) {
  assertSameOrigin(request);
  const session = await requireUser(request, env, deps);
  const body = await readJson(request, 24000);
  let q;
  try {
    q = validate({ ...body.query, cabin: 'economy', stops: 0, departureToken: undefined });
  } catch (error) {
    throw new HttpError(400, error.message, 'INVALID_QUERY');
  }
  const leg = body.offer;
  if (!leg || typeof leg !== 'object' || !leg.offer || typeof leg.offer.sig !== 'string' || !leg.query || typeof leg.searchedAt !== 'string') {
    throw new HttpError(400, 'Volta a pesquisar e tenta criar o aviso novamente.', 'INVALID_OFFER');
  }
  const expected = await signOffer(secret(env, 'OFFER_SECRET'), leg.query, leg.offer, leg.searchedAt);
  const age = Date.now() - Date.parse(leg.searchedAt);
  const signed = signedQuery(leg.query);
  if (!timingSafeEqual(expected, leg.offer.sig) || signed.departureToken || !sameQuery(signed, q) || !(age > -120000)) {
    throw new HttpError(400, 'Volta a pesquisar e tenta criar o aviso novamente.', 'INVALID_OFFER');
  }
  if (age > BASELINE_MAX_AGE_MS) throw new HttpError(409, 'Os preços desta pesquisa são antigos. Actualiza a pesquisa e cria o aviso.', 'OFFER_EXPIRED');
  const amount = Number(leg.offer.amount);
  if (!(amount > 0) || leg.offer.currency !== 'BRL') throw new HttpError(400, 'Volta a pesquisar e tenta criar o aviso novamente.', 'INVALID_OFFER');

  const store = db(env, deps.fetcher);
  const prices = await pricing(env, deps);
  if (!prices) throw new HttpError(503, 'Os avisos ficam disponíveis quando o câmbio do dia estiver definido.', 'NO_RATE');

  // A signed-in customer without a name gives it in the alert form: saved in the customer record.
  const name = cleanText(body.name, 80);
  if (!session.customer.name && name.length >= 3) {
    await store.update('customers', { id: `eq.${session.customer.id}` }, { name })
      .catch(error => console.error('customer name not saved:', error.message));
  }

  // The lowest price logged for this exact search in the last hours wins over the offer sent.
  const recent = await store.select('search_logs', {
    select: 'min_price_brl',
    origin: `eq.${q.origin}`,
    destination: `eq.${q.destination}`,
    departure_date: `eq.${q.departureDate}`,
    return_date: q.returnDate ? `eq.${q.returnDate}` : 'is.null',
    passengers: `eq.${q.passengers}`,
    has_token: 'is.false',
    status: 'eq.ok',
    created_at: `gte.${new Date(Date.now() - BASELINE_MAX_AGE_MS).toISOString()}`,
    order: 'created_at.desc',
    limit: 10,
  }).catch(() => []);
  const baselineBrl = Math.min(amount, ...recent.map(row => Number(row.min_price_brl)).filter(value => value > 0));
  const baselineKz = priceAoa(baselineBrl, prices.rate, prices.markupBp).amountAoa;

  const mine = await store.select('price_alerts', { select: '*', customer_id: `eq.${session.customer.id}`, status: 'eq.active', order: 'created_at.desc', limit: 50 });
  const existing = mine.find(row => row.origin === q.origin && row.destination === q.destination && row.departure_date === q.departureDate
    && (row.return_date ?? null) === (q.returnDate ?? null) && row.passengers === q.passengers);
  if (existing) return json({ alert: publicAlert(existing), existing: true });
  if (mine.length >= MAX_ACTIVE_PER_CUSTOMER) {
    throw new HttpError(429, `Já tens ${MAX_ACTIVE_PER_CUSTOMER} avisos activos. Espera que algum termine para criar outro.`, 'ALERT_LIMIT');
  }
  const [row] = await store.insert('price_alerts', {
    customer_id: session.customer.id,
    origin: q.origin,
    destination: q.destination,
    origin_name: placeName(body.names?.origin),
    destination_name: placeName(body.names?.destination),
    departure_date: q.departureDate,
    return_date: q.returnDate,
    passengers: q.passengers,
    baseline_brl: baselineBrl,
    baseline_kz: baselineKz,
    last_price_kz: baselineKz,
    lowest_price_kz: baselineKz,
    last_seen_at: leg.searchedAt,
  });
  return json({ alert: publicAlert(row) }, 201);
}

// After a fresh search (no departure token): compares its lowest price with the active alerts
// of the same trip and sends the SMS that are due. Never throws.
export async function checkAlerts(env, q, result, deps, request) {
  try {
    if (q.departureToken || !result?.offers?.length) return 0;
    const store = db(env, deps.fetcher);
    const alerts = await store.select('price_alerts', {
      select: '*,customer:customers(phone,blocked)',
      status: 'eq.active',
      origin: `eq.${q.origin}`,
      destination: `eq.${q.destination}`,
      departure_date: `eq.${q.departureDate}`,
      return_date: q.returnDate ? `eq.${q.returnDate}` : 'is.null',
      passengers: `eq.${q.passengers}`,
      limit: 200,
    });
    if (!alerts.length) return 0;
    const prices = await pricing(env, deps);
    if (!prices) return 0;
    const minBrl = Math.min(...result.offers.map(offer => Number(offer.amount)).filter(value => value > 0));
    if (!Number.isFinite(minBrl)) return 0;
    const currentKz = priceAoa(minBrl, prices.rate, prices.markupBp).amountAoa;
    const base = request ? publicOrigin(request, env) : env.PUBLIC_BASE_URL;
    let sent = 0;
    for (const alert of alerts) {
      const seen = {
        last_price_kz: currentKz,
        last_seen_at: result.searchedAt || nowIso(),
        lowest_price_kz: Math.min(Number(alert.lowest_price_kz ?? alert.baseline_kz), currentKz),
        checks: Number(alert.checks || 0) + 1,
      };
      const first = alert.alerts_sent === 0 && Number(alert.baseline_kz) - currentKz > FIRST_DROP_KZ;
      const second = alert.alerts_sent === 1 && Number(alert.first_alert_kz) - currentKz >= SECOND_DROP_KZ;
      if (!(first || second) || alert.customer?.blocked || !alert.customer?.phone) {
        await store.update('price_alerts', { id: `eq.${alert.id}` }, seen);
        continue;
      }
      const number = alert.alerts_sent + 1;
      const fromKz = first ? Number(alert.baseline_kz) : Number(alert.first_alert_kz);
      const mark = number === 1 ? { first_alert_kz: currentKz, first_alert_at: nowIso() } : { second_alert_kz: currentKz, second_alert_at: nowIso() };
      // Claim the SMS: only one concurrent search can move alerts_sent from N to N + 1.
      const [claimed] = await store.update('price_alerts', { id: `eq.${alert.id}`, alerts_sent: `eq.${alert.alerts_sent}`, status: 'eq.active' }, {
        ...seen,
        ...mark,
        alerts_sent: number,
        ...(number === 2 ? { status: 'done' } : {}),
      });
      if (!claimed) continue;
      try {
        await sendAndRecord(env, store, {
          phone: alert.customer.phone,
          text: smsText.priceDrop({
            origin: alert.origin,
            destination: alert.destination,
            originName: alert.origin_name,
            destinationName: alert.destination_name,
            departureDate: alert.departure_date,
            returnDate: alert.return_date,
            from: fromKz,
            to: currentKz,
            link: linkFor(alert, base),
          }),
          category: 'TRANSACTIONAL',
          purpose: 'price_drop',
          idempotencyKey: `alert-${alert.id}-${number}`,
        }, deps);
        sent += 1;
      } catch (error) {
        // SMS not sent: give the alert back so a later search can try again (same idempotency key).
        console.error('price alert sms failed', alert.id, error?.code || error?.message);
        const undo = number === 1 ? { first_alert_kz: null, first_alert_at: null } : { second_alert_kz: null, second_alert_at: null };
        await store.update('price_alerts', { id: `eq.${alert.id}`, alerts_sent: `eq.${number}` }, { ...undo, alerts_sent: alert.alerts_sent, status: 'active' }).catch(() => {});
      }
    }
    return sent;
  } catch (error) {
    console.error('price alerts check failed', error?.message || error);
    return 0;
  }
}

// ── Admin ────────────────────────────────────────────────────────────────────
const pageParams = url => ({
  limit: Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30)),
  offset: Math.max(0, Number(url.searchParams.get('offset')) || 0),
});

export async function listAlerts(request, env, ctx, deps) {
  await requireAdmin(request, env, deps);
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const store = db(env, deps.fetcher);
  const params = { select: '*,customer:customers(id,name,phone)', order: 'created_at.desc', ...pageParams(url) };
  if (STATUSES.has(status)) params.status = `eq.${status}`;
  if (status === 'notified') params.alerts_sent = 'gt.0';
  const count = filter => store.selectCount('price_alerts', { select: 'id', limit: 1, ...filter }).then(r => r.total).catch(() => null);
  const [{ rows, total }, active, notified, done] = await Promise.all([
    store.selectCount('price_alerts', params),
    count({ status: 'eq.active' }),
    count({ alerts_sent: 'gt.0' }),
    count({ status: 'eq.done' }),
  ]);
  return json({ rows, total, stats: { active, notified, done }, rules: { firstDropKz: FIRST_DROP_KZ, secondDropKz: SECOND_DROP_KZ } });
}

export async function alertAction(request, env, ctx, deps) {
  assertSameOrigin(request);
  const session = await requireAdmin(request, env, deps);
  const id = deps.params[0];
  if (!UUID.test(id || '')) throw new HttpError(404, 'Aviso não encontrado.', 'NOT_FOUND');
  const body = await readJson(request, 2000);
  const action = String(body.action || '');
  const store = db(env, deps.fetcher);
  const alert = await store.one('price_alerts', { select: '*', id: `eq.${id}` });
  if (!alert) throw new HttpError(404, 'Aviso não encontrado.', 'NOT_FOUND');
  let patch;
  if (action === 'cancel') {
    if (alert.status !== 'active') throw new HttpError(409, 'Este aviso já não está activo.', 'INVALID_STATE');
    patch = { status: 'cancelled' };
  } else if (action === 'reactivate') {
    if (alert.status !== 'cancelled') throw new HttpError(409, 'Só um aviso cancelado pode ser reactivado.', 'INVALID_STATE');
    if (alert.departure_date < new Date().toISOString().slice(0, 10)) throw new HttpError(409, 'A data da viagem já passou.', 'INVALID_STATE');
    patch = { status: alert.alerts_sent >= 2 ? 'done' : 'active' };
  } else {
    throw new HttpError(400, 'Acção desconhecida.', 'UNKNOWN_ACTION');
  }
  const [row] = await store.update('price_alerts', { id: `eq.${id}` }, patch);
  await store.insert('admin_audit', { admin_id: session.customer.id, action: `alert.${action}`, target: id, details: { status: row.status } }, { returning: false })
    .catch(error => console.error('audit not saved:', error.message));
  return json({ alert: row });
}
