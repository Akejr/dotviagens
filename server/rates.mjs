// Daily exchange rate set by the admin: 1 BRL = rate Kz.
// Search prices stay in BRL internally. Final price = BRL x rate (rounded up to the
// kwanza) + DOT service fee (markup in basis points of that value, rounded up).
// The fee is set in the admin (Câmbio e preço) and stored in app_settings.markup_bp.

import { json } from './http.mjs';
import { db, hasSupabase } from './supabase.mjs';

// Fee used until the admin sets one (and if the setting cannot be read): 1100 bp = 11%.
export const DEFAULT_MARKUP_BP = 1100;
export const MARKUP_BP = DEFAULT_MARKUP_BP;
// Accepted range in the admin: 0% to 50%.
export const MAX_MARKUP_BP = 5000;

const CACHE_MS = 60000;
let cache = null;
let markupCache = null;

export async function currentRate(env, deps = {}, { fresh = false } = {}) {
  if (!hasSupabase(env)) return null;
  if (!fresh && cache && cache.until > Date.now()) return cache.value;
  const row = await db(env, deps.fetcher).one('exchange_rates', { select: 'rate,effective_date,created_at', order: 'created_at.desc' });
  const value = row ? { rate: Number(row.rate), effectiveDate: row.effective_date, updatedAt: row.created_at } : null;
  cache = { value, until: Date.now() + CACHE_MS };
  return value;
}

export const validMarkup = bp => Number.isInteger(bp) && bp >= 0 && bp <= MAX_MARKUP_BP;

// DOT fee in basis points. Falls back to the default when the setting is missing or unreadable,
// so prices never stop because of it.
export async function currentMarkup(env, deps = {}, { fresh = false } = {}) {
  if (!hasSupabase(env)) return { markupBp: DEFAULT_MARKUP_BP, updatedAt: null, editor: null };
  if (!fresh && markupCache && markupCache.until > Date.now()) return markupCache.value;
  const row = await db(env, deps.fetcher)
    .one('app_settings', { select: 'value,updated_at,editor:customers(name,phone)', key: 'eq.markup_bp' })
    .catch(() => null);
  const bp = Number(row?.value);
  const value = {
    markupBp: validMarkup(bp) ? bp : DEFAULT_MARKUP_BP,
    updatedAt: row?.updated_at ?? null,
    editor: row?.editor ?? null,
  };
  markupCache = { value, until: Date.now() + CACHE_MS };
  return value;
}

export const forgetRate = () => {
  cache = null;
  markupCache = null;
};

// Integer arithmetic (cents x rate/10000) avoids floating point surprises.
export function toKz(brl, rate) {
  const cents = BigInt(Math.round(Number(brl) * 100));
  const scaledRate = BigInt(Math.round(Number(rate) * 10000));
  const divisor = 1000000n;
  return Number((cents * scaledRate + divisor - 1n) / divisor);
}

// Converted value, DOT fee and the total charged (the only value customers see).
export function priceAoa(brl, rate, markupBp = DEFAULT_MARKUP_BP) {
  const baseAoa = toKz(brl, rate);
  const feeAoa = Number((BigInt(baseAoa) * BigInt(markupBp) + 9999n) / 10000n);
  return { baseAoa, feeAoa, amountAoa: baseAoa + feeAoa, markupBp };
}

export const luandaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Luanda' }).format(new Date());

export async function rateEndpoint(request, env, ctx, deps) {
  const [value, markup] = await Promise.all([
    currentRate(env, deps).catch(() => null),
    currentMarkup(env, deps).catch(() => ({ markupBp: DEFAULT_MARKUP_BP })),
  ]);
  return json({
    base: 'BRL',
    quote: 'AOA',
    rate: value?.rate ?? null,
    markupBp: markup.markupBp,
    effectiveDate: value?.effectiveDate ?? null,
    updatedAt: value?.updatedAt ?? null,
  }, 200, { 'Cache-Control': 'public, max-age=60' });
}
