// SerpApi usage control, shared by flight searches and calendar prices:
// - shared cache of flight searches (Supabase flight_cache), so every server instance and
//   visitor reuses a search for 25 minutes (the in-memory cache lives in one instance only);
// - pause after a quota error (HTTP 429): no provider calls for 10 minutes, on every instance;
// - plan and usage of the SerpApi account for the admin (Account API: free, not a search).

import { db, hasSupabase } from './supabase.mjs';
import { defer } from './http.mjs';
import { sha256Hex } from './crypto.mjs';
import { searchApiOn } from './searchapi.mjs';

// Offers stay buyable for 30 minutes (OFFER_MAX_AGE_MS): a shared result is reused for 25.
export const FLIGHT_SHARE_MS = 25 * 60 * 1000;
export const PAUSE_MS = 10 * 60 * 1000;
const PAUSE_CHECK_MS = 30 * 1000;
const ACCOUNT_CACHE_MS = 60 * 1000;

const nowIso = () => new Date().toISOString();
const timeLuanda = new Intl.DateTimeFormat('pt-PT', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Luanda' });

// ── Shared flight cache ──────────────────────────────────────────────────────
export async function sharedFlight(env, deps, key) {
  if (!hasSupabase(env)) return null;
  try {
    const row = await db(env, deps.fetcher).one('flight_cache', {
      select: 'data,expires_at',
      cache_key: `eq.${await sha256Hex(key)}`,
      expires_at: `gt.${nowIso()}`,
    });
    return row?.data && typeof row.data === 'object' ? row.data : null;
  } catch {
    // The shared cache is an optimisation: without it the provider answers.
    return null;
  }
}

export function shareFlight(env, ctx, deps, key, data) {
  if (!hasSupabase(env) || !data?.searchedAt) return;
  const expires = Date.parse(data.searchedAt) + FLIGHT_SHARE_MS;
  if (!(expires > Date.now())) return;
  // Stored without the per-answer fields (cached, age): each reuse computes them again.
  const stored = { ...data };
  delete stored.cached;
  delete stored.age;
  defer(ctx, (async () => db(env, deps.fetcher).upsert('flight_cache', [{
    cache_key: await sha256Hex(key),
    data: stored,
    created_at: nowIso(),
    expires_at: new Date(expires).toISOString(),
  }], 'cache_key'))());
}

// ── Pause after a quota error ────────────────────────────────────────────────
let pause = { until: 0, checkedAt: 0 };

export const pauseMessage = until =>
  `As pesquisas de voos estão em pausa por alguns minutos. Tenta novamente às ${timeLuanda.format(new Date(until))} ou fala connosco no WhatsApp.`;

// Time (ms) until which provider calls are paused, or 0. Reads the shared state every 30 s, also
// during a local pause: a pause started elsewhere, or ended in the panel, reaches every instance.
export async function pausedUntil(env, deps = {}) {
  const active = () => (pause.until > Date.now() ? pause.until : 0);
  if (!hasSupabase(env) || Date.now() - pause.checkedAt < PAUSE_CHECK_MS) return active();
  pause.checkedAt = Date.now();
  try {
    const row = await db(env, deps.fetcher).one('app_settings', { select: 'value', key: 'eq.provider_pause' });
    const until = Date.parse(row?.value?.until || '') || 0;
    pause.until = until > Date.now() ? until : 0;
  } catch {
    // Shared state unreadable: the local pause, if any, stays.
  }
  return active();
}

export function pauseProvider(env, ctx, deps = {}, reason = 'limit') {
  const until = Date.now() + PAUSE_MS;
  pause = { until, checkedAt: Date.now() };
  console.error('flight provider paused until', new Date(until).toISOString(), reason);
  if (hasSupabase(env)) {
    defer(ctx, db(env, deps.fetcher).upsert('app_settings', [{
      key: 'provider_pause',
      value: { until: new Date(until).toISOString(), reason, at: nowIso() },
      updated_at: nowIso(),
    }], 'key'));
  }
  return until;
}

export async function resumeProvider(env, deps = {}) {
  pause = { until: 0, checkedAt: Date.now() };
  if (hasSupabase(env)) await db(env, deps.fetcher).remove('app_settings', { key: 'eq.provider_pause' });
}

// ── Flight provider account (admin) ──────────────────────────────────────────
let account = { value: null, until: 0 };
const number = v => (v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);

// Plan and usage of the provider in use (free account calls, never a search). The answers also carry
// the api_key and the e-mail, which never leave the server.
export async function providerAccount(env, deps = {}) {
  const viaSearchApi = searchApiOn(env);
  if (!viaSearchApi && !env.SERPAPI_KEY) return null;
  if (account.until > Date.now()) return account.value;
  let value = null;
  try {
    const url = new URL(viaSearchApi ? 'https://www.searchapi.io/api/v1/me' : 'https://serpapi.com/account.json');
    url.searchParams.set('api_key', viaSearchApi ? env.SEARCHAPI_KEY : env.SERPAPI_KEY);
    const response = await (deps.fetcher || fetch)(url, { signal: AbortSignal.timeout(8000) });
    const data = await response.json().catch(() => null);
    if (response.ok && data && !data.error && viaSearchApi) {
      // SearchApi: monthly allowance of the plan plus remaining_credits (credits outside the plan).
      const monthly = number(data.account?.monthly_allowance);
      const used = number(data.account?.current_month_usage);
      const extra = number(data.account?.remaining_credits);
      value = {
        provider: 'SearchApi',
        plan: null,
        monthly,
        used,
        left: monthly === null ? extra : Math.max(0, monthly - (used || 0)) + (extra || 0),
        extra,
        lastHour: number(data.api_usage?.searches_this_hour),
        hourLimit: number(data.api_usage?.hourly_rate_limit),
      };
    } else if (response.ok && data && !data.error) {
      value = {
        provider: 'SerpApi',
        plan: typeof data.plan_name === 'string' ? data.plan_name.slice(0, 60) : null,
        monthly: number(data.searches_per_month),
        used: number(data.this_month_usage),
        left: number(data.total_searches_left ?? data.plan_searches_left),
        extra: number(data.extra_credits),
        lastHour: number(data.last_hour_searches),
        hourLimit: number(data.account_rate_limit_per_hour),
      };
    }
  } catch {
    value = null;
  }
  account = { value, until: Date.now() + ACCOUNT_CACHE_MS };
  return value;
}
