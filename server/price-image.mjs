// Admin "Imagem de preços": the cheapest days of a month for one route, drawn as an image in the
// panel (public/admin.js) to send to a customer. Two steps, so each request stays under the 60 s a
// function may run: the month's calendar (indicative price of every departure day; in a round trip,
// the cheapest trip of minDays to maxDays), then the real search of each cheapest day (airline and
// exact price, 1 search per day, logged with kind "image").

import { HttpError, json, readJson, assertSameOrigin, isoDate } from './http.mjs';
import { requireAdmin } from './auth.mjs';
import { isPlace } from './places.mjs';
import { CABINS } from './flights.mjs';
import { currentRate, currentMarkup, priceAoa, luandaToday } from './rates.mjs';
import { withPromo } from './promo.mjs';
import { pausedUntil, pauseProvider, pauseMessage } from './provider.mjs';
import { searchApiOn, searchApiSpanCalendar } from './searchapi.mjs';
import { safeLogo } from './offers.mjs';
import { inner, call } from './ai.mjs';

const DAY_MS = 86400000;
const MAX_AHEAD_DAYS = 330;
const MAX_SPAN_DAYS = 21;
const addDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const lastDayOf = month => {
  const [year, index] = month.split('-').map(Number);
  return new Date(Date.UTC(year, index, 0)).toISOString().slice(0, 10);
};
const between = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

async function pricing(env, deps) {
  const [rate, markup] = await Promise.all([currentRate(env, deps).catch(() => null), currentMarkup(env, deps)]);
  if (!rate?.rate) throw new HttpError(409, 'Define primeiro o câmbio do dia em Câmbio e preço.', 'NO_RATE');
  return { rate: rate.rate, markupBp: markup.markupBp };
}
const kzOf = (brl, prices) => withPromo(priceAoa(brl, prices.rate, prices.markupBp)).amountAoa;

function travellers(body, fail) {
  const passengers = body.passengers ?? 1;
  if (!Number.isInteger(passengers) || passengers < 1 || passengers > 4) fail('Escolhe de 1 a 4 adultos.');
  const cabin = body.cabin ?? 'economy';
  if (!Object.hasOwn(CABINS, cabin)) fail('Classe de viagem inválida.');
  return { passengers, cabin };
}

export function validateImage(body, now = Date.now()) {
  const fail = message => {
    throw new HttpError(400, message, 'INVALID_IMAGE');
  };
  const { origin, destination, month, type } = body || {};
  if (!isPlace(origin) || !isPlace(destination) || origin === destination) fail('Escolhe a origem e o destino da lista.');
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail('Escolhe o mês.');
  if (type !== 'oneway' && type !== 'return') fail('Escolhe só ida ou ida e volta.');
  const today = new Date(now).toISOString().slice(0, 10);
  const lastBookable = addDays(today, MAX_AHEAD_DAYS);
  const start = `${month}-01` < today ? today : `${month}-01`;
  const end = lastDayOf(month) > lastBookable ? lastBookable : lastDayOf(month);
  if (end < start) fail('Esse mês já passou ou ainda não está à venda.');
  let minDays = null;
  let maxDays = null;
  if (type === 'return') {
    minDays = body.minDays;
    maxDays = body.maxDays ?? minDays;
    if (!Number.isInteger(minDays) || minDays < 1 || minDays > 60) fail('A duração mínima vai de 1 a 60 dias.');
    if (!Number.isInteger(maxDays) || maxDays < minDays || maxDays > 90) fail('A duração máxima tem de ser igual ou maior do que a mínima.');
    if (maxDays - minDays > MAX_SPAN_DAYS) fail(`Entre a duração mínima e a máxima cabem no máximo ${MAX_SPAN_DAYS} dias.`);
  }
  return { origin, destination, month, type, start, end, minDays, maxDays, lastReturn: lastBookable, ...travellers(body, fail) };
}

// Step 1: indicative price of every departure day of the month (2 to 5 provider requests).
export async function priceImageCalendar(request, env, ctx, deps) {
  assertSameOrigin(request);
  await requireAdmin(request, env, deps);
  const q = validateImage(await readJson(request, 2000));
  if (!searchApiOn(env)) throw new HttpError(503, 'A imagem de preços precisa da SearchApi (SEARCHAPI_KEY).', 'SEARCH_NOT_CONFIGURED');
  const prices = await pricing(env, deps);
  const paused = await pausedUntil(env, deps);
  if (paused > Date.now()) throw new HttpError(503, pauseMessage(paused), 'PROVIDER_PAUSED');
  const unavailable = () => new HttpError(502, 'O calendário de preços não respondeu. Tenta outra vez.', 'PROVIDER_ERROR');
  let result;
  try {
    result = await searchApiSpanCalendar(env, q, deps.fetcher);
  } catch {
    throw unavailable();
  }
  if (result.response.status === 429) {
    const until = await pauseProvider(env, ctx, deps, 'limit');
    throw new HttpError(429, until ? pauseMessage(until) : 'Limite da SearchApi atingido.', 'PROVIDER_LIMIT');
  }
  if (result.response.status === 401 || result.response.status === 403) throw new HttpError(502, 'A SearchApi recusou a chave de acesso.', 'PROVIDER_AUTH');
  if (!result.response.ok) throw unavailable();
  const best = new Map();
  for (const row of result.data.prices) {
    const amount = Number(row.price);
    if (!isoDate(row.outbound_date) || row.outbound_date < q.start || row.outbound_date > q.end || !(amount > 0)) continue;
    if (!best.has(row.outbound_date) || amount < best.get(row.outbound_date).amount) best.set(row.outbound_date, { amount, returnDate: row.return_date || null });
  }
  const days = [...best].sort(([a], [b]) => a.localeCompare(b)).map(([date, { amount, returnDate }]) => ({
    date,
    returnDate,
    nights: returnDate ? between(date, returnDate) : null,
    priceKz: kzOf(amount, prices),
  }));
  return json({ query: { ...q, lastReturn: undefined }, days, requests: result.requests, failedRequests: result.failed || 0, generatedAt: new Date().toISOString(), today: luandaToday() });
}

// Airline logos as data URLs: the image is drawn on a canvas, which cannot be exported with
// pictures from another site.
async function logoData(fetcher, url) {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(6000) });
    const type = response.headers.get('content-type') || 'image/png';
    if (!response.ok || !type.startsWith('image/')) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 200000) return null;
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return `data:${type};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

// Step 2: the real search of one day (1 search): cheapest flight, its airlines and logos.
export async function priceImageDay(request, env, ctx, deps) {
  assertSameOrigin(request);
  await requireAdmin(request, env, deps);
  const body = await readJson(request, 2000);
  const fail = message => {
    throw new HttpError(400, message, 'INVALID_IMAGE');
  };
  if (!isPlace(body.origin) || !isPlace(body.destination) || body.origin === body.destination) fail('Origem ou destino inválidos.');
  if (!isoDate(body.departureDate) || (body.returnDate != null && (!isoDate(body.returnDate) || body.returnDate <= body.departureDate))) fail('Datas inválidas.');
  const { passengers, cabin } = travellers(body, fail);
  const prices = await pricing(env, deps);
  const search = { origin: body.origin, destination: body.destination, departureDate: body.departureDate, ...(body.returnDate ? { returnDate: body.returnDate } : {}), passengers, cabin, stops: 0, kind: 'image', ...(typeof body.jid === 'string' ? { jid: body.jid } : {}) };
  const result = await call(deps.search, inner(request, '/api/flights/search', search), env, ctx, deps);
  if (!result.ok) throw new HttpError(result.status || 502, result.data?.error || 'A pesquisa falhou.', result.data?.code || 'SEARCH_FAILED');
  const offer = [...(result.data.offers || [])].sort((a, b) => a.amount - b.amount)[0];
  if (!offer) return json({ date: body.departureDate, returnDate: body.returnDate || null, found: false });
  const airlines = [...new Set(offer.segments.map(s => s.airline).filter(Boolean))];
  const logoUrls = [...new Set(offer.segments.map(s => safeLogo(s.logo)).filter(Boolean))].slice(0, 2);
  const logos = (await Promise.all((logoUrls.length ? logoUrls : [safeLogo(offer.logo)].filter(Boolean)).map(url => logoData(deps.fetcher, url)))).filter(Boolean);
  return json({
    date: body.departureDate,
    returnDate: body.returnDate || null,
    found: true,
    priceKz: kzOf(offer.amount, prices),
    airlines,
    logos,
    stops: offer.stops,
    duration: offer.duration,
  });
}
