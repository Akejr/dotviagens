// All /api/* routes of the Worker. Handlers receive (request, env, ctx, deps)
// where deps.fetcher is the HTTP client (mockable) and deps.params the URL groups.

import { HttpError, json, defer, clientIp, userAgent, cleanText } from './http.mjs';
import { handleSearch } from './flights.mjs';
import { handleCalendar } from './calendar.mjs';
import { db, hasSupabase } from './supabase.mjs';
import { hmacHex } from './crypto.mjs';
import { requestOtp, verifyOtp, me, logout, getSession } from './auth.mjs';
import { rateEndpoint } from './rates.mjs';
import { quote, createBooking, listMyBookings, getMyBooking, checkBooking, retryPayment, wizaCallback, sweep } from './bookings.mjs';
import { sharedFlight, shareFlight, pausedUntil, pauseProvider, pauseMessage } from './provider.mjs';
import { createAlert, checkAlerts, listAlerts, alertAction } from './alerts.mjs';
import * as admin from './admin.mjs';

// Daily-salted visitor hash: counts unique visitors without storing IPs.
async function visitorOf(env, request) {
  const day = new Date().toISOString().slice(0, 10);
  return (await hmacHex(String(env.AUTH_SECRET || 'dot-viagens'), `v:${day}:${clientIp(request)}:${userAgent(request)}`)).slice(0, 16);
}

// Country of the visitor: Cloudflare (request.cf) or Vercel (x-vercel-ip-country).
const countryOf = request => {
  const code = request.cf?.country || request.headers.get('x-vercel-ip-country') || '';
  return /^[A-Z]{2}$/.test(code) ? code : null;
};

// Approximate city of the visitor (IP geolocation, shown in the admin next to the visitor):
// Cloudflare request.cf.city, or Vercel's x-vercel-ip-city with non-ASCII characters percent-encoded.
const decoded = value => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
const cityOf = request => cleanText(request.cf?.city || decoded(request.headers.get('x-vercel-ip-city') || ''), 60) || null;

async function customerOf(request, env, deps) {
  try {
    return (await getSession(request, env, deps))?.customer?.id ?? null;
  } catch {
    return null;
  }
}

async function logSearch(env, request, info, deps) {
  if (!hasSupabase(env)) return;
  const { q, meta } = info;
  const prices = info.offers.map(offer => offer.amount).filter(Number.isFinite);
  const sid = meta?.sid ?? null;
  const jid = meta?.jid ?? null;
  await db(env, deps.fetcher).insert('search_logs', {
    origin: q.origin,
    destination: q.destination,
    departure_date: q.departureDate,
    return_date: q.returnDate,
    passengers: q.passengers,
    kind: meta?.kind ?? null,
    has_token: Boolean(q.departureToken),
    cached: info.cached,
    status: info.status,
    offers_count: info.offers.length,
    min_price_brl: prices.length ? Math.min(...prices) : null,
    error_code: info.errorCode,
    duration_ms: info.durationMs,
    visitor: await visitorOf(env, request),
    session_id: sid,
    // One admin feed row per customer search: neighbour dates and returns share the key.
    journey_id: jid,
    journey_key: jid || (sid ? `${sid}|${q.origin}|${q.destination}|${q.passengers}` : null),
    country: countryOf(request),
    city: cityOf(request),
    customer_id: await customerOf(request, env, deps),
  }, { returning: false });
}

// Calendar prices cost SerpApi searches: only real provider calls are logged.
async function logCalendar(env, request, info, deps) {
  if (!hasSupabase(env)) return;
  const { q } = info;
  const amounts = info.prices.map(price => price.amount);
  await db(env, deps.fetcher).insert('search_logs', {
    origin: q.origin,
    destination: q.destination,
    departure_date: q.fixedOutbound || q.start,
    return_date: null,
    passengers: q.passengers,
    kind: 'calendar',
    has_token: false,
    cached: false,
    status: info.status,
    offers_count: info.prices.length,
    min_price_brl: amounts.length ? Math.min(...amounts) : null,
    error_code: info.errorCode,
    duration_ms: info.durationMs,
    visitor: await visitorOf(env, request),
    country: countryOf(request),
    city: cityOf(request),
    customer_id: await customerOf(request, env, deps),
  }, { returning: false });
}

const search = (request, env, ctx, deps) =>
  handleSearch(request, env, deps.fetcher, {
    onSearch: info => defer(ctx, logSearch(env, request, info, deps)),
    // Shared cache of searches (all instances, 25 min) and pause after a SerpApi quota error.
    cacheGet: key => sharedFlight(env, deps, key),
    pausedUntil: () => pausedUntil(env, deps),
    pauseMessage,
    onLimit: () => pauseProvider(env, ctx, deps, 'limit'),
    // A fresh result is shared with the other instances and follows the price alerts of this trip.
    onFresh: (q, result, key) => {
      shareFlight(env, ctx, deps, key, result);
      if (!q.departureToken && result.offers.length) defer(ctx, checkAlerts(env, q, result, deps, request));
    },
  });

const calendar = (request, env, ctx, deps) =>
  handleCalendar(request, env, ctx, deps, { onCalendar: info => defer(ctx, logCalendar(env, request, info, deps)) });

const REF = 'DOT-\\d{6}-\\d{5,}';
const UUID = '[0-9a-fA-F-]{36}';

const routes = [
  ['POST', '/api/flights/search', search],
  ['POST', '/api/flights/calendar', calendar],
  ['GET', '/api/rate', rateEndpoint],
  ['POST', '/api/auth/otp/request', requestOtp],
  ['POST', '/api/auth/otp/verify', verifyOtp],
  ['GET', '/api/auth/me', me],
  ['POST', '/api/auth/logout', logout],
  ['POST', '/api/alerts', createAlert],
  ['POST', '/api/checkout/quote', quote],
  ['POST', '/api/bookings', createBooking],
  ['GET', '/api/bookings', listMyBookings],
  ['GET', `/api/bookings/(${REF})`, getMyBooking],
  ['POST', `/api/bookings/(${REF})/check`, checkBooking],
  ['POST', `/api/bookings/(${REF})/pay`, retryPayment],
  ['POST', '/api/payments/wiza/callback', wizaCallback],
  ['POST', '/api/internal/sweep', sweep],
  // Vercel Cron Jobs call GET with "Authorization: Bearer <CRON_SECRET>".
  ['GET', '/api/internal/sweep', sweep],
  ['GET', '/api/admin/live', admin.live],
  ['GET', '/api/admin/overview', admin.overview],
  ['GET', '/api/admin/rates', admin.listRates],
  ['POST', '/api/admin/rates', admin.addRate],
  ['POST', '/api/admin/pricing', admin.setMarkup],
  ['POST', '/api/admin/provider/resume', admin.resumeSearches],
  ['GET', '/api/admin/alerts', listAlerts],
  ['POST', `/api/admin/alerts/(${UUID})`, alertAction],
  ['GET', '/api/admin/searches', admin.searches],
  ['GET', '/api/admin/searches/calls', admin.searchCalls],
  ['GET', '/api/admin/bookings', admin.listBookings],
  ['GET', `/api/admin/bookings/(${REF})`, admin.bookingDetail],
  ['POST', `/api/admin/bookings/(${REF})/action`, admin.bookingAction],
  ['GET', '/api/admin/customers', admin.listCustomers],
  ['POST', `/api/admin/customers/(${UUID})`, admin.updateCustomer],
  ['GET', '/api/admin/sms', admin.listSms],
  ['POST', `/api/admin/sms/(${UUID})/refresh`, admin.refreshSms],
  ['GET', '/api/admin/audit', admin.listAudit],
  ['POST', '/api/admin/sweep', admin.adminSweep],
].map(([method, path, handler]) => [method, new RegExp(`^${path}$`), handler]);

export async function handleApi(request, env, ctx, deps = {}) {
  const { pathname } = new URL(request.url);
  const matches = routes.filter(([, pattern]) => pattern.test(pathname));
  if (!matches.length) return json({ error: 'Endereço não encontrado.', code: 'NOT_FOUND' }, 404);
  const route = matches.find(([method]) => method === request.method);
  if (!route) {
    return json({ error: 'Método não permitido.', code: 'METHOD_NOT_ALLOWED' }, 405, { Allow: [...new Set(matches.map(([method]) => method))].join(', ') });
  }
  const [, pattern, handler] = route;
  const fetcher = deps.fetcher || ((...args) => fetch(...args));
  try {
    return await handler(request, env, ctx, { fetcher, params: pathname.match(pattern).slice(1) });
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message, code: error.code, ...error.extra }, error.status);
    console.error('api error', request.method, pathname, error?.message || error);
    return json({ error: 'Ocorreu um erro inesperado. Tenta novamente.', code: 'INTERNAL' }, 500);
  }
}
