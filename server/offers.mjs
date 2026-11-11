// Integrity of prices between search and payment.
// Every offer returned by /api/flights/search is signed (HMAC) together with the
// query and searchedAt. Checkout only accepts signed, recent offers, so the
// browser can never change a price, a flight or the outbound/return pairing.

import { HttpError } from './http.mjs';
import { base64url, fromBase64url, hmacHex, timingSafeEqual } from './crypto.mjs';

export const OFFER_MAX_AGE_MS = 30 * 60 * 1000;
export const QUOTE_TTL_MS = 15 * 60 * 1000;

export function safeLogo(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/flights/airline_logos/') ? url.href : null;
  } catch {
    return null;
  }
}

export const signedQuery = q => ({
  origin: q.origin,
  destination: q.destination,
  departureDate: q.departureDate,
  returnDate: q.returnDate ?? null,
  passengers: q.passengers,
  // Only when there are children: the signatures of adult searches stay as they were.
  ...(q.children ? { children: q.children } : {}),
  cabin: q.cabin,
  ...(q.airlines ? { airlines: q.airlines } : {}),
  stops: q.stops ?? 0,
  departureToken: q.departureToken ?? null,
});

const text = value => (typeof value === 'string' ? value : '');
const number = value => (Number.isFinite(value) ? value : 0);

export function coreOffer(offer) {
  return {
    id: text(offer?.id),
    airline: text(offer?.airline),
    amount: Number(offer?.amount),
    currency: text(offer?.currency),
    duration: number(offer?.duration),
    stops: number(offer?.stops),
    cabin: text(offer?.cabin),
    departureToken: typeof offer?.departureToken === 'string' ? offer.departureToken : null,
    bookingToken: typeof offer?.bookingToken === 'string' ? offer.bookingToken : null,
    segments: (Array.isArray(offer?.segments) ? offer.segments : []).map(segment => ({
      airline: text(segment?.airline),
      number: text(segment?.number),
      from: text(segment?.from),
      to: text(segment?.to),
      departure: text(segment?.departure),
      arrival: text(segment?.arrival),
      duration: number(segment?.duration),
    })),
    layovers: (Array.isArray(offer?.layovers) ? offer.layovers : []).map(layover => ({
      airport: text(layover?.airport),
      name: text(layover?.name),
      duration: number(layover?.duration),
      overnight: Boolean(layover?.overnight),
    })),
  };
}

const payload = (query, offer, searchedAt) => JSON.stringify([1, signedQuery(query), coreOffer(offer), String(searchedAt)]);

export const signOffer = (secret, query, offer, searchedAt) => hmacHex(secret, payload(query, offer, searchedAt));

export async function signResult(secret, result, q) {
  const query = signedQuery(q);
  const offers = await Promise.all(result.offers.map(async offer => ({ ...offer, sig: await signOffer(secret, query, offer, result.searchedAt) })));
  return { ...result, query, offers };
}

const invalid = () => {
  throw new HttpError(400, 'Os dados da viagem não são válidos. Volta aos resultados e escolhe o voo novamente.', 'INVALID_ITINERARY');
};

async function checkLeg(secret, leg, now) {
  if (!leg || typeof leg !== 'object' || !leg.offer || typeof leg.offer !== 'object' || !leg.query || typeof leg.query !== 'object' ||
      typeof leg.searchedAt !== 'string' || typeof leg.offer.sig !== 'string') invalid();
  const expected = await signOffer(secret, leg.query, leg.offer, leg.searchedAt);
  if (!timingSafeEqual(expected, leg.offer.sig)) invalid();
  const age = now - Date.parse(leg.searchedAt);
  if (!Number.isFinite(age) || age < -120000) invalid();
  if (age > OFFER_MAX_AGE_MS) {
    throw new HttpError(409, 'Os preços desta pesquisa expiraram. Volta aos resultados para os actualizar.', 'OFFER_EXPIRED');
  }
  const offer = coreOffer(leg.offer);
  if (!offer.segments.length) invalid();
  // Logos are display-only and not signed: keep only the trusted Google host.
  const stored = {
    ...offer,
    logo: safeLogo(leg.offer.logo),
    segments: offer.segments.map((segment, index) => ({ ...segment, logo: safeLogo(leg.offer.segments[index]?.logo) })),
  };
  return { query: signedQuery(leg.query), offer, stored, searchedAt: leg.searchedAt, sig: leg.offer.sig };
}

export async function verifyItinerary(secret, itinerary, { now = Date.now() } = {}) {
  const outbound = await checkLeg(secret, itinerary?.outbound, now);
  if (outbound.query.departureToken) invalid();
  const roundTrip = Boolean(outbound.query.returnDate);
  let inbound = null;
  if (roundTrip) {
    inbound = await checkLeg(secret, itinerary?.inbound, now);
    const a = outbound.query;
    const b = inbound.query;
    const sameTrip = ['origin', 'destination', 'departureDate', 'returnDate', 'passengers', 'cabin'].every(key => a[key] === b[key]) && (a.children || 0) === (b.children || 0);
    // The return list must come from the departure token of this exact outbound.
    if (!sameTrip || !b.departureToken || b.departureToken !== outbound.offer.departureToken) invalid();
  } else if (itinerary?.inbound) {
    invalid();
  }
  const final = roundTrip ? inbound.offer : outbound.offer;
  if (!(final.amount > 0) || final.currency !== 'BRL') invalid();
  return { roundTrip, outbound, inbound, query: outbound.query, priceBrl: final.amount };
}

export async function makeQuote(secret, data) {
  const body = base64url(JSON.stringify(data));
  return `${body}.${await hmacHex(secret, `quote.${body}`)}`;
}

export async function readQuote(secret, token, now = Date.now()) {
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature || !timingSafeEqual(signature, await hmacHex(secret, `quote.${body}`))) {
    throw new HttpError(400, 'A cotação não é válida. Revê a viagem novamente.', 'INVALID_QUOTE');
  }
  const data = JSON.parse(fromBase64url(body));
  if (!(data.exp > now)) {
    throw new HttpError(409, 'A cotação expirou. Revê o preço actualizado antes de pagar.', 'QUOTE_EXPIRED');
  }
  return data;
}
