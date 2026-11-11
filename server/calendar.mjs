// Indicative price per day for the date pickers (Google Flights Calendar via SearchApi, or SerpApi).
// SerpApi: one provider call per month view; SearchApi round trips: 3 parts. Memoised 30 minutes. Prices stay in BRL:
// the browser applies the câmbio do dia and the DOT fee, like every other price.

import { airports } from './airport-codes.mjs';
import { HttpError, json, readJson, assertSameOrigin, isoDate, defer } from './http.mjs';
import { noResults } from './flights.mjs';
import { db, hasSupabase } from './supabase.mjs';
import { pausedUntil, pauseProvider, pauseMessage } from './provider.mjs';
import { searchApiOn, searchApiCalendar, calendarParts } from './searchapi.mjs';

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
  // Part of the month (SearchApi round trips only; ignored otherwise).
  const part = body.part ?? null;
  if (part !== null && (!Number.isInteger(part) || part < 0 || part > 9)) fail('Parte do mês inválida.');
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
  return { origin, destination, passengers, type, month, monthStart, start, end, fixedOutbound, tripDays, part, empty: end < start || end < monthStart };
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

async function fetchPrices(env, q, key, fetcher, hooks, onLimit = () => 0) {
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
    if (searchApiOn(env)) {
      ({ response, data } = await searchApiCalendar(env, q, fetcher));
    } else {
      response = await fetcher(url, { signal: AbortSignal.timeout(30000) });
      data = await response.json();
    }
  } catch {
    throw fail(502, 'Os preços do calendário não estão disponíveis agora.', 'PROVIDER_UNAVAILABLE');
  }
  if (response.status === 401 || response.status === 403) throw fail(502, `A ${searchApiOn(env) ? 'SearchApi' : 'SerpApi'} recusou a chave de acesso.`, 'PROVIDER_AUTH');
  if (response.status === 429) {
    // Quota or hourly limit reached: the provider is paused for a few minutes on every instance.
    const until = onLimit();
    throw fail(429, until ? pauseMessage(until) : 'Os preços do calendário não estão disponíveis agora.', 'PROVIDER_LIMIT');
  }
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
  const answer = (prices, cached, extra = {}) => json({
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
    ...extra,
  });
  if (q.empty) return answer([], true);
  const viaSearchApi = searchApiOn(env);
  // SearchApi round trips come in parts (see searchapi.mjs): without `part` the answer only says how
  // many there are (no provider call); the browser then asks every part at once and shows each one
  // as it arrives. Each part is cached on its own (its dates are in the cache key).
  const parts = viaSearchApi ? calendarParts(q) : null;
  if (parts && q.part === null) return answer([], false, { parts: parts.length });
  if (parts) {
    if (q.part >= parts.length) throw new HttpError(400, 'Parte do mês inválida.', 'INVALID_CALENDAR');
    [q.start, q.end] = parts[q.part];
  }
  if (!viaSearchApi && !env.SERPAPI_KEY) throw new HttpError(503, 'A pesquisa ainda não está configurada.', 'SEARCH_NOT_CONFIGURED');
  // SearchApi months are cached apart from the SerpApi ones (memory and calendar_cache).
  const key = (viaSearchApi ? 'searchapi|' : '') + cacheKey(q);
  const saved = memo.get(key);
  if (saved && saved.until > Date.now()) return answer(await withRealPrices(env, deps, q, saved.prices), true);
  if (!pending.has(key)) {
    pending.set(key, (async () => {
      const shared = await sharedPrices(env, deps, key);
      if (shared) {
        remember(key, shared.prices, Math.min(Date.parse(shared.expires_at), Date.now() + TTL_MS));
        return { prices: shared.prices, cached: true };
      }
      const paused = await pausedUntil(env, deps);
      if (paused > Date.now()) throw new HttpError(503, pauseMessage(paused), 'PROVIDER_PAUSED');
      const prices = await fetchPrices(env, q, key, deps.fetcher, hooks, () => pauseProvider(env, ctx, deps, 'limit'));
      shareLater(env, ctx, deps, key, prices);
      return { prices, cached: false };
    })().finally(() => pending.delete(key)));
  }
  const result = await pending.get(key);
  return answer(await withRealPrices(env, deps, q, result.prices), result.cached);
}

// Google's calendar can miss the cheaper itineraries of a route (Luanda–Havana showed 31 650 BRL
// while the searches found 7 871): a day searched by any visitor in the last 6 hours shows the
// lowest price really found, when it is below the calendar. Applied when answering, never stored.
// Per adult, like the calendar. Never fails the calendar.
const TRIP_LENGTHS = [3, 5, 7, 10, 14, 21, 30, 45, 60]; // Same list as public/price-calendar.js.
const standardTripDays = days => TRIP_LENGTHS.reduce((best, n) => (Math.abs(n - days) < Math.abs(best - days) ? n : best), TRIP_LENGTHS[0]);
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export async function withRealPrices(env, deps, q, prices) {
  if (!hasSupabase(env)) return prices;
  try {
    const range = (column, from, to) => `(${column}.gte.${from},${column}.lte.${to})`;
    const rows = await db(env, deps.fetcher).select('search_logs', {
      select: 'departure_date,return_date,passengers,min_price_brl',
      origin: `eq.${q.origin}`,
      destination: `eq.${q.destination}`,
      or: '(kind.is.null,kind.neq.calendar)', // neq alone would also drop the rows without kind.
      has_token: 'is.false',
      status: 'eq.ok',
      created_at: `gte.${new Date(Date.now() - SHARED_TTL_MS).toISOString()}`,
      ...(q.type === 'oneway' ? { return_date: 'is.null' } : { return_date: 'not.is.null' }),
      ...(q.fixedOutbound ? { departure_date: `eq.${q.fixedOutbound}`, and: range('return_date', q.start, q.end) } : { and: range('departure_date', q.start, q.end) }),
      limit: 500,
    });
    const best = new Map();
    for (const row of rows) {
      const amount = Number(row.min_price_brl) / Math.max(1, Number(row.passengers) || 1);
      if (!(amount > 0)) continue;
      if (q.type === 'return' && !q.fixedOutbound && standardTripDays(daysBetween(row.departure_date, row.return_date)) !== q.tripDays) continue;
      const date = q.fixedOutbound ? row.return_date : row.departure_date;
      if (date < q.start || date > q.end) continue;
      if (!best.has(date) || amount < best.get(date).amount) best.set(date, { date, amount, low: false, outboundDate: row.departure_date, returnDate: row.return_date || null });
    }
    if (!best.size) return prices;
    const merged = new Map(prices.map(price => [price.date, price]));
    for (const [date, real] of best) if (!merged.has(date) || real.amount < merged.get(date).amount) merged.set(date, real);
    return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return prices;
  }
}
