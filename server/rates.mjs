// Daily exchange rate set by the admin: 1 BRL = rate Kz.
// Search prices stay in BRL internally. Final price = BRL x rate (rounded up to the
// kwanza) + DOT service fee (MARKUP_BP basis points of that value, rounded up).

import { json } from './http.mjs';
import { db, hasSupabase } from './supabase.mjs';

// DOT service fee: 1100 basis points = 11% of the converted value.
export const MARKUP_BP = 1100;

let cache = null;

export async function currentRate(env, deps = {}, { fresh = false } = {}) {
  if (!hasSupabase(env)) return null;
  if (!fresh && cache && cache.until > Date.now()) return cache.value;
  const row = await db(env, deps.fetcher).one('exchange_rates', { select: 'rate,effective_date,created_at', order: 'created_at.desc' });
  const value = row ? { rate: Number(row.rate), effectiveDate: row.effective_date, updatedAt: row.created_at } : null;
  cache = { value, until: Date.now() + 60000 };
  return value;
}

export const forgetRate = () => {
  cache = null;
};

// Integer arithmetic (cents x rate/10000) avoids floating point surprises.
export function toKz(brl, rate) {
  const cents = BigInt(Math.round(Number(brl) * 100));
  const scaledRate = BigInt(Math.round(Number(rate) * 10000));
  const divisor = 1000000n;
  return Number((cents * scaledRate + divisor - 1n) / divisor);
}

// Converted value, DOT fee and the total charged (the only value customers see).
export function priceAoa(brl, rate, markupBp = MARKUP_BP) {
  const baseAoa = toKz(brl, rate);
  const feeAoa = Number((BigInt(baseAoa) * BigInt(markupBp) + 9999n) / 10000n);
  return { baseAoa, feeAoa, amountAoa: baseAoa + feeAoa, markupBp };
}

export const luandaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Luanda' }).format(new Date());

export async function rateEndpoint(request, env, ctx, deps) {
  const value = await currentRate(env, deps).catch(() => null);
  return json({
    base: 'BRL',
    quote: 'AOA',
    rate: value?.rate ?? null,
    markupBp: MARKUP_BP,
    effectiveDate: value?.effectiveDate ?? null,
    updatedAt: value?.updatedAt ?? null,
  }, 200, { 'Cache-Control': 'public, max-age=60' });
}
