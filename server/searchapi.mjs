// SearchApi.io (Google Flights and Google Flights Calendar): the flight provider whenever
// SEARCHAPI_KEY is set; FLIGHTS_PROVIDER=serpapi goes back to SerpApi (SERPAPI_KEY). The answers
// are converted to the SerpApi format that the rest of the server reads, so logs, shared caches,
// the pause after a quota error and the price alerts work the same with both providers.

import { placeId, calendarId, severalAirports, airportsPerSide } from './places.mjs';

const BASE = 'https://www.searchapi.io/api/v1/search';
const DAY_MS = 86400000;
// Calendar months in as few requests as possible (each request is 1 credit). Smaller blocks in
// parallel were not faster (round trip in 7 blocks: 17.7 s, against 16-25 s in 3), only dearer.
// Round trip: at most 200 departure x return combinations per request, so 3 blocks of ~11 days.
const ROUND_TRIP_BLOCK_DAYS = 14;
// A country (several airports): blocks of up to 5 days (25 combinations, ~24 s). 10 days took 65 s
// with Lisboa, Porto e Faro (11/11/2026), more than the 60 s a request may last on Vercel.
const SEVERAL_AIRPORTS_BLOCK_DAYS = 5;
const ONE_WAY_BLOCK_DAYS = 200;
// Each calendar request may take up to 50 s (the function may run 60 s; the browser waits 58 s).
// With 30 s, 116 of 430 requests failed on 11/11/2026: most answered between 10 and 30 s.
export const CALENDAR_TIMEOUT_MS = 50000;
const roundTripBlockDays = q => (severalAirports(q) ? SEVERAL_AIRPORTS_BLOCK_DAYS : ROUND_TRIP_BLOCK_DAYS);

export const searchApiOn = env => Boolean(env.SEARCHAPI_KEY) && String(env.FLIGHTS_PROVIDER || '').toLowerCase() !== 'serpapi';
export const providerName = env => (searchApiOn(env) ? 'SearchApi' : 'SerpApi');

const addDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

// start..end (inclusive) in the fewest blocks of at most `size` days, of nearly equal length.
export function blocks(start, end, size) {
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
  if (!(days > 0)) return [];
  const count = Math.ceil(days / size);
  const list = [];
  let from = start;
  for (let index = 0; index < count; index++) {
    const length = Math.floor(days / count) + (index < days % count ? 1 : 0);
    const to = addDays(from, length - 1);
    list.push([from, to]);
    from = addDays(to, 1);
  }
  return list;
}
const noFlights = data => typeof data?.error === 'string' && /(hasn.t returned|didn.t return) any results/i.test(data.error);

// Never log this URL: it carries the api_key.
function requestUrl(env, params) {
  const target = new URL(BASE);
  target.search = new URLSearchParams({ travel_class: 'economy', ...params, currency: 'BRL', hl: 'pt', gl: 'pt', api_key: env.SEARCHAPI_KEY }).toString();
  return target;
}

// Same search as SerpApi: one way, round trip, or the returns of a chosen outbound (departure_token).
// show_cheapest_flights: the prices of Google Flights' "Mais baratos" tab, the ones people compare with.
// The default ("Melhores") left flights out and priced the same flights higher (11 Nov 2026:
// NBJ-WDH 21-29 Dec R$ 5,998 instead of TAAG direct R$ 4,922; TP 298 NBJ-LIS R$ 2,512 instead of R$ 2,141).
// The returns step needs it too: without it, an outbound of this mode answers no returns.
// separate_tickets=1 hides separate and self-transfer tickets (e.g. Lufthansa + Ryanair + Iberia to
// Lisbon), which that tab adds and the site cannot flag: one ticket per trip, as before.
export function searchApiFlightsUrl(env, q) {
  return requestUrl(env, {
    engine: 'google_flights',
    departure_id: placeId(q.origin),
    arrival_id: placeId(q.destination),
    outbound_date: q.departureDate,
    ...(q.returnDate ? { return_date: q.returnDate } : {}),
    flight_type: q.returnDate ? 'round_trip' : 'one_way',
    ...(q.departureToken ? { departure_token: q.departureToken } : {}),
    adults: String(q.passengers),
    ...(q.children ? { children: String(q.children) } : {}),
    travel_class: q.cabin || 'economy',
    stops: q.stops === 1 ? 'nonstop' : 'any',
    show_cheapest_flights: 'true',
    separate_tickets: '1',
  });
}

// SearchApi sends the date and the time apart ("2026-12-18" + "13:40"); SerpApi sends "2026-12-18 13:40".
const joinTime = airport => (airport?.date && airport.time && !String(airport.time).includes(' ') ? { ...airport, time: `${airport.date} ${airport.time}` } : airport);
const adaptOffer = offer => ({
  ...offer,
  flights: Array.isArray(offer?.flights)
    ? offer.flights.map(flight => ({ ...flight, departure_airport: joinTime(flight.departure_airport), arrival_airport: joinTime(flight.arrival_airport) }))
    : offer?.flights,
});
export const adaptFlights = data => (data && typeof data === 'object'
  ? { ...data, best_flights: (data.best_flights || []).map(adaptOffer), other_flights: (data.other_flights || []).map(adaptOffer) }
  : data);

// Parts of a round-trip month (N days), asked one by one by the browser so the calendar fills in as
// they arrive. Null when the month fits one request (one way, fixed departure, a few days left).
export function calendarParts(q) {
  if (q.type !== 'return' || q.fixedOutbound || q.empty) return null;
  const list = blocks(q.start, q.end, roundTripBlockDays(q));
  return list.length > 1 ? list : null;
}

// One month of the calendar as {response, data: {prices: [{outbound_date, return_date, price}]}} (SerpApi format).
// One way and fixed departure: 1 request. Round trip of N days: 3 blocks of ~11 departure days
// (a country: up to 7 blocks of ~5 days).
export async function searchApiCalendar(env, q, fetcher) {
  // A country goes as its main airports separated by commas (places.mjs, calendarId).
  const take = airportsPerSide(q.origin, q.destination);
  const common = { engine: 'google_flights_calendar', departure_id: calendarId(q.origin, take), arrival_id: calendarId(q.destination, take), adults: String(q.passengers), travel_class: q.cabin || 'economy', stops: 'any' };
  const requests = [];
  if (q.type !== 'return') {
    for (const [from, to] of blocks(q.start, q.end, ONE_WAY_BLOCK_DAYS)) {
      requests.push({ ...common, flight_type: 'one_way', outbound_date: from, outbound_date_start: from, outbound_date_end: to });
    }
  } else if (q.fixedOutbound) {
    const first = q.start > q.monthStart ? q.start : q.monthStart;
    requests.push({
      ...common,
      flight_type: 'round_trip',
      outbound_date: q.fixedOutbound,
      outbound_date_start: q.fixedOutbound,
      outbound_date_end: q.fixedOutbound,
      return_date: first,
      return_date_start: first,
      return_date_end: q.end,
    });
  } else {
    for (const [from, to] of blocks(q.start, q.end, roundTripBlockDays(q))) {
      requests.push({
        ...common,
        flight_type: 'round_trip',
        outbound_date: from,
        return_date: addDays(from, q.tripDays),
        outbound_date_start: from,
        outbound_date_end: to,
        return_date_start: addDays(from, q.tripDays),
        return_date_end: addDays(to, q.tripDays),
      });
    }
  }
  // SearchApi answers in 5 to 45 s: each part has CALENDAR_TIMEOUT_MS (the browser waits 58 s).
  const answers = await Promise.all(requests.map(async params => {
    try {
      const response = await fetcher(requestUrl(env, params), { signal: AbortSignal.timeout(CALENDAR_TIMEOUT_MS) });
      return { response, data: await response.json().catch(() => null) };
    } catch {
      return { response: { ok: false, status: 504 }, data: null };
    }
  }));
  const good = answers.filter(({ response, data }) => response.ok && data && (!data.error || noFlights(data)));
  // A slow or failed part only leaves its days without a price; when every part fails, the error is returned.
  if (!good.length) return answers.find(({ response }) => [401, 403, 429].includes(response.status)) || answers[0];
  const prices = [];
  for (const { data } of good) {
    for (const row of Array.isArray(data.calendar) ? data.calendar : []) {
      // Round trip of N days: only the trips of exactly that length.
      if (q.type === 'return' && !q.fixedOutbound && row.return !== addDays(row.departure, q.tripDays)) continue;
      prices.push({ outbound_date: row.departure, return_date: row.return || null, price: row.price, low_price: row.is_lowest_price === true });
    }
  }
  return { response: { ok: true, status: 200 }, data: { prices } };
}
