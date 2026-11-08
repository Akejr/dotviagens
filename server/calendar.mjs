// Indicative price per day for the date pickers (SerpApi Google Flights Calendar API).
// One provider call per month view, memoised for 30 minutes. Prices stay in BRL:
// the browser applies the câmbio do dia and the DOT fee, like every other price.

import { airports } from './airport-codes.mjs';
import { HttpError, json, readJson, assertSameOrigin, isoDate, defer } from './http.mjs';
import { noResults } from './flights.mjs';
import { db, hasSupabase } from './supabase.mjs';

const DAY_MS = 86400000;
const MAX_AHEAD_DAYS = 330;
// Return calendar: return dates priced up to ~2 months after the fixed departure.
const MAX_SPAN_DAYS = 62;
// Memory cache per server instance, then a cache shared by every instance and visitor
// (Supabase table calendar_cache): a month seen by anyone opens instantly for 6 hours.
const TTL_MS = 30 * 60 * 1000;
const SHARED_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 300;
const memo = new Map();
const pending = new Map();

const addDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const lastDayOf = month => {
  const [year, index] = month.split('-').map(Number);
  return new Date(Date.UTC(year, index, 0)).toISOString().slice(0, 10);
};

// type 'oneway': price per departure day. type 'return' + tripDays: round-trip total per
// departure day for a trip of that length. type 'return' + fixedOutbound: round-trip
// total per return day, departing on fixedOutbound.
export function validateCalendar(body, now = Date.now()) {
  const fail = message => {
    throw new HttpError(400, message, 'INVALID_CALENDAR');
  };
  const { origin, destination, type, month } = body || {};
  if (!airports.has(origin) || !airports.has(destination) || origin === destination) fail('Escolhe aeroportos diferentes da lista.');
  const passengers = body.passengers ?? 1;
  if (!Number.isInteger(passengers) || passengers < 1 || passengers > 4) fail('Pesquisa disponível para 1 a 4 adultos.');
  if (type !== 'oneway' && type !== 'return') fail('Tipo de viagem inválido.');
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail('Mês inválido.');
  const today = new Date(now).toISOString().slice(0, 10);
  const lastBookable = addDays(today, MAX_AHEAD_DAYS);
  let fixedOutbound = null;
  let tripDays = null;
  if (type === 'return') {
    if (body.fixedOutbound != null) {
      if (!isoDate(body.fixedOutbound) || body.fixedOutbound < today || body.fixedOutbound > lastBookable) fail('Confirma a data de ida.');
      fixedOutbound = body.fixedOutbound;
    } else {
      tripDays = body.tripDays ?? 7;
      if (!Number.isInteger(tripDays) || tripDays < 1 || tripDays > 60) fail('Duração da viagem inválida.');
    }
  }
  const monthStart = `${month}-01`;
  let start = monthStart < today ? today : monthStart;
  let end = lastDayOf(month);
  if (end > lastBookable) end = lastBookable;
  if (fixedOutbound) {
    // The provider departs on date_range_start and prices each return date until date_range_end.
    start = fixedOutbound;
    const limit = addDays(fixedOutbound, MAX_SPAN_DAYS);
    if (end > limit) end = limit;
  }
  return { origin, destination, passengers, type, month, monthStart, start, end, fixedOutbound, tripDays, empty: end < start || end < monthStart };
}

export function normalizeCalendar(data, q) {
  const byDate = new Map();
  for (const row of Array.isArray(data?.prices) ? data.prices : []) {
    const amount = Number(row?.price);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const outboundDate = [row.outbound_date, row.departure_date, row.date].find(isoDate) || null;
    const returnDate = isoDate(row.return_date) ? row.return_date : null;
    const date = q.fixedOutbound ? returnDate : outboundDate;
    if (!date || date < q.start || date > q.end || date < q.monthStart) continue;
    if (q.fixedOutbound && outboundDate && outboundDate !== q.fixedOutbound) continue;
    const previous = byDate.get(date);
    if (!previous || amount < previous.amount) {
      byDate.set(date, { date, amount, low: row.low_price === true, outboundDate, returnDate });
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchPrices(env, q, key, fetcher, hooks) {
  const started = Date.now();
  const report = (status, prices = [], errorCode = null) => {
    try {
      hooks.onCalendar?.({ q, status, errorCode, prices, durationMs: Date.now() - started });
    } catch {
      // Logging never changes the answer.
    }
  };
  const fail = (status, message, code) => {
    report('error', [], code);
    return new HttpError(status, message, code);
  };
  // Never log this URL: it carries the api_key.
  const url = new URL('https://serpapi.com/search.json');
  url.search = new URLSearchParams({
    engine: 'google_flights_calendar',
    api_key: env.SERPAPI_KEY,
    departure_id: q.origin,
    arrival_id: q.destination,
    type: q.type === 'return' ? '1' : '2',
    date_range_start: q.start,
    date_range_end: q.end,
    ...(q.fixedOutbound ? { fixed_outbound_date: 'true' } : {}),
    ...(q.tripDays ? { round_trip_days: String(q.tripDays) } : {}),
    travel_class: '1',
    adults: String(q.passengers),
    currency: 'BRL',
    hl: 'pt',
    gl: 'pt',
  }).toString();
  let response;
  let data;
  try {
    response = await fetcher(url, { signal: AbortSignal.timeout(30000) });
    data = await response.json();
  } catch {
    throw fail(502, 'Os preços do calendário não estão disponíveis agora.', 'PROVIDER_UNAVAILABLE');
  }
  if (response.status === 401 || response.status === 403) throw fail(502, 'A SerpApi recusou a chave de acesso.', 'PROVIDER_AUTH');
  if (response.status === 429) throw fail(429, 'O limite de pesquisas da SerpApi foi atingido.', 'PROVIDER_LIMIT');
  if (!response.ok || (data?.error && !noResults(data))) throw fail(502, 'Os preços do calendário não estão disponíveis agora.', 'PROVIDER_ERROR');
  const prices = normalizeCalendar(data, q);
  remember(key, prices, Date.now() + TTL_MS);
  report(prices.length ? 'ok' : 'empty', prices);
  return prices;
}

function remember(key, prices, until) {
  if (memo.size >= MAX_ENTRIES) memo.delete(memo.keys().next().value);
  memo.set(key, { prices, until });
}

async function sharedPrices(env, deps, key) {
  if (!hasSupabase(env)) return null;
  try {
    const row = await db(env, deps.fetcher).one('calendar_cache', { select: 'prices,expires_at', cache_key: `eq.${key}`, expires_at: `gt.${new Date().toISOString()}` });
    return row && Array.isArray(row.prices) ? row : null;
  } catch {
    // The shared cache is an optimisation: without it the provider answers.
    return null;
  }
}

function shareLater(env, ctx, deps, key, prices) {
  if (!hasSupabase(env)) return;
  defer(ctx, db(env, deps.fetcher).upsert('calendar_cache', {
    cache_key: key,
    prices,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + SHARED_TTL_MS).toISOString(),
  }, 'cache_key'));
}

const cacheKey = q => [q.origin, q.destination, q.passengers, q.type, q.start, q.end, q.fixedOutbound || '', q.tripDays || ''].join('|');

export async function handleCalendar(request, env, ctx, deps, hooks = {}) {
  assertSameOrigin(request);
  const q = validateCalendar(await readJson(request, 2000));
  const answer = (prices, cached) => json({
    currency: 'BRL',
    type: q.type,
    month: q.month,
    start: q.start,
    end: q.end,
    fixedOutbound: q.fixedOutbound,
    tripDays: q.tripDays,
    passengers: q.passengers,
    prices,
    cached,
  });
  if (q.empty) return answer([], true);
  if (!env.SERPAPI_KEY) throw new HttpError(503, 'A pesquisa ainda não está configurada.', 'SEARCH_NOT_CONFIGURED');
  const key = cacheKey(q);
  const saved = memo.get(key);
  if (saved && saved.until > Date.now()) return answer(saved.prices, true);
  if (!pending.has(key)) {
    pending.set(key, (async () => {
      const shared = await sharedPrices(env, deps, key);
      if (shared) {
        remember(key, shared.prices, Math.min(Date.parse(shared.expires_at), Date.now() + TTL_MS));
        return { prices: shared.prices, cached: true };
      }
      const prices = await fetchPrices(env, q, key, deps.fetcher, hooks);
      shareLater(env, ctx, deps, key, prices);
      return { prices, cached: false };
    })().finally(() => pending.delete(key)));
  }
  const result = await pending.get(key);
  return answer(result.prices, result.cached);
}
