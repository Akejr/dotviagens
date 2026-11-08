// Minimal PostgREST client for Supabase, used only on the server with the
// secret (service role) key. Row Level Security blocks every other role.

import { HttpError } from './http.mjs';

export const supabaseKey = env => env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
export const hasSupabase = env => Boolean(env.SUPABASE_URL && supabaseKey(env));

const encode = params =>
  Object.entries(params || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');

const parse = text => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// PostgREST filter values come from users in admin searches: keep only safe characters.
export const searchTerm = value =>
  String(value ?? '').normalize('NFC').replace(/[^\p{L}\p{N}@.+\- ]/gu, '').trim().slice(0, 60);

export function db(env, fetcher = fetch) {
  if (!hasSupabase(env)) {
    throw new HttpError(503, 'A base de dados ainda não está configurada.', 'DB_NOT_CONFIGURED');
  }
  const base = `${String(env.SUPABASE_URL).replace(/\/+$/, '')}/rest/v1`;
  const key = supabaseKey(env);
  // New sb_secret_ keys are not JWTs and go only in the apikey header.
  const auth = { apikey: key, ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}) };

  async function call(method, path, { params, body, prefer, count = false } = {}) {
    const query = encode(params);
    const url = `${base}/${path}${query ? `?${query}` : ''}`;
    const headers = { ...auth, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const preferences = [prefer, count ? 'count=exact' : ''].filter(Boolean).join(',');
    if (preferences) headers.Prefer = preferences;
    let response;
    try {
      response = await fetcher(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new HttpError(503, 'A base de dados não respondeu. Tenta novamente.', 'DB_UNAVAILABLE');
    }
    const text = await response.text();
    const data = text ? parse(text) : null;
    if (!response.ok) {
      console.error('supabase error', method, path, response.status, data?.code, data?.message);
      if (response.status === 409 || data?.code === '23505') throw new HttpError(409, 'Registo duplicado.', 'DB_CONFLICT');
      throw new HttpError(502, 'Erro na base de dados. Tenta novamente.', data?.code || 'DB_ERROR');
    }
    if (count) {
      const total = Number((response.headers.get('content-range') || '').split('/')[1]);
      return { rows: data || [], total: Number.isFinite(total) ? total : (data || []).length };
    }
    return data;
  }

  return {
    select: (table, params) => call('GET', table, { params }),
    selectCount: (table, params) => call('GET', table, { params, count: true }),
    one: async (table, params) => (await call('GET', table, { params: { ...params, limit: 1 } }))?.[0] ?? null,
    insert: (table, rows, { returning = true } = {}) =>
      call('POST', table, { body: rows, prefer: returning ? 'return=representation' : 'return=minimal' }),
    upsert: (table, rows, onConflict, { returning = false } = {}) =>
      call('POST', table, {
        params: { on_conflict: onConflict },
        body: rows,
        prefer: `resolution=merge-duplicates,${returning ? 'return=representation' : 'return=minimal'}`,
      }),
    update: (table, params, patch) => call('PATCH', table, { params, body: patch, prefer: 'return=representation' }),
    remove: (table, params) => call('DELETE', table, { params, prefer: 'return=minimal' }),
    rpc: (name, args = {}) => call('POST', `rpc/${name}`, { body: args }),
  };
}
