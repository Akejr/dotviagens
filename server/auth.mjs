// Phone + OTP access (Nsangu SMS) and cookie sessions stored in Supabase.
// Customers and admins use the same flow; admins need role = 'admin'
// (bootstrapped from ADMIN_PHONES or granted in the dashboard).

import {
  HttpError, json, readJson, assertSameOrigin, parseCookies, cookie, isHttps,
  clientIp, userAgent, cleanText, cleanEmail,
} from './http.mjs';
import { db, hasSupabase } from './supabase.mjs';
import { normalizePhone, maskPhone, isMovicel } from './phone.mjs';
import { hmacHex, otpCode, randomToken, sha256Hex } from './crypto.mjs';
import { smsText } from './sms.mjs';
import { sendAndRecord } from './notify.mjs';

export const SESSION_COOKIE = 'dot_session';
const OTP_TTL_S = 300;
const RESEND_S = 60;
const PHONE_PER_HOUR = 5;
const IP_PER_HOUR = 20;
// Protects the SMS wallet: codes sent by the whole site per hour (OTP_HOURLY_LIMIT overrides).
const GLOBAL_PER_HOUR = 300;
const CUSTOMER_DAYS = 30;
const ADMIN_HOURS = 12;
const sessionCache = new Map();

const OTP_RESULTS = {
  invalid: [400, 'Código incorrecto. Confirma o SMS e tenta novamente.'],
  expired: [400, 'O código expirou. Pede um novo código.'],
  locked: [429, 'Demasiadas tentativas. Pede um novo código.'],
  missing: [400, 'Pede um código primeiro.'],
};

export function secret(env, name = 'AUTH_SECRET') {
  const value = env[name];
  if (!value || String(value).length < 16) {
    throw new HttpError(503, 'O sistema de acesso ainda não está configurado.', 'AUTH_NOT_CONFIGURED');
  }
  return String(value);
}

export const adminPhones = env =>
  new Set(String(env.ADMIN_PHONES || '').split(/[\s,;]+/).map(normalizePhone).filter(Boolean));

export const publicCustomer = customer =>
  customer ? { id: customer.id, phone: customer.phone, name: customer.name || '', email: customer.email || '', role: customer.role } : null;

const purposeOf = value => (['login', 'checkout', 'admin'].includes(value) ? value : 'login');

export async function ipHash(request, env) {
  return (await hmacHex(secret(env), `ip:${clientIp(request)}`)).slice(0, 32);
}

export async function requestOtp(request, env, ctx, deps) {
  assertSameOrigin(request);
  const body = await readJson(request, 2000);
  const phone = normalizePhone(body.phone);
  if (!phone) {
    throw new HttpError(400, 'Indica um número de telemóvel angolano válido, com 9 dígitos começados por 9.', 'INVALID_PHONE');
  }
  const purpose = purposeOf(body.purpose);
  const key = secret(env);
  const store = db(env, deps.fetcher);
  const now = Date.now();
  const hourAgo = new Date(now - 3600e3).toISOString();
  const ip = await ipHash(request, env);
  const [byPhone, byIp] = await Promise.all([
    store.select('otp_codes', { select: 'created_at', phone: `eq.${phone}`, created_at: `gte.${hourAgo}`, order: 'created_at.desc' }),
    store.select('otp_codes', { select: 'id', ip_hash: `eq.${ip}`, created_at: `gte.${hourAgo}` }),
  ]);
  const wait = byPhone[0] ? RESEND_S - Math.floor((now - Date.parse(byPhone[0].created_at)) / 1000) : 0;
  if (wait > 0) throw new HttpError(429, `Aguarda ${wait} segundos para pedires um novo código.`, 'OTP_WAIT', { resendIn: wait });
  if (byPhone.length >= PHONE_PER_HOUR || byIp.length >= IP_PER_HOUR) {
    throw new HttpError(429, 'Pediste demasiados códigos. Tenta novamente dentro de uma hora.', 'OTP_LIMIT');
  }

  const hourlyLimit = Number(env.OTP_HOURLY_LIMIT) > 0 ? Number(env.OTP_HOURLY_LIMIT) : GLOBAL_PER_HOUR;
  const { total: sentLastHour } = await store.selectCount('otp_codes', { select: 'id', created_at: `gte.${hourAgo}`, limit: 1 });
  if (sentLastHour >= hourlyLimit) {
    console.error('otp global hourly limit reached', sentLastHour);
    throw new HttpError(429, 'O envio de códigos está temporariamente limitado. Tenta novamente dentro de alguns minutos.', 'OTP_GLOBAL_LIMIT');
  }

  if (purpose === 'admin') {
    const customer = await store.one('customers', { select: 'role,blocked', phone: `eq.${phone}` });
    const allowed = adminPhones(env).has(phone) || (customer?.role === 'admin' && !customer.blocked);
    // Same answer for unknown numbers (sender hint derived from the network), so the admin list cannot be discovered.
    if (!allowed) {
      return json({ ok: true, expiresIn: OTP_TTL_S, resendIn: RESEND_S, maskedPhone: maskPhone(phone), sender: isMovicel(phone) ? '46554' : null });
    }
  }

  const code = otpCode();
  const [row] = await store.insert('otp_codes', {
    phone,
    purpose,
    code_hash: await hmacHex(key, `${phone}:${code}`),
    expires_at: new Date(now + OTP_TTL_S * 1000).toISOString(),
    ip_hash: ip,
  });
  try {
    const message = await sendAndRecord(env, store, {
      phone, text: smsText.otp(code), category: 'OTP', purpose: 'otp', idempotencyKey: `otp-${row.id}`,
    }, deps);
    const sender = purpose === 'admin' ? (isMovicel(phone) ? '46554' : null) : message?.from ?? null;
    return json({ ok: true, expiresIn: OTP_TTL_S, resendIn: RESEND_S, maskedPhone: maskPhone(phone), sender });
  } catch (error) {
    // A code that never left must not count against the resend limit.
    await store.remove('otp_codes', { id: `eq.${row.id}` }).catch(() => {});
    throw new HttpError(502, error?.message || 'Não foi possível enviar o SMS agora. Tenta novamente dentro de momentos.', 'SMS_FAILED');
  }
}

export async function verifyOtp(request, env, ctx, deps) {
  assertSameOrigin(request);
  const body = await readJson(request, 4000);
  const phone = normalizePhone(body.phone);
  const code = String(body.code ?? '').replace(/\D/g, '');
  if (!phone || code.length !== 6) throw new HttpError(400, 'Indica o código de 6 dígitos que recebeste por SMS.', 'INVALID_CODE');
  const purpose = purposeOf(body.purpose);
  const key = secret(env);
  const store = db(env, deps.fetcher);
  const result = await store.rpc('verify_otp', { p_phone: phone, p_code_hash: await hmacHex(key, `${phone}:${code}`) });
  if (result !== 'ok') {
    const [status, message] = OTP_RESULTS[result] || OTP_RESULTS.invalid;
    throw new HttpError(status, message, `OTP_${String(result).toUpperCase()}`);
  }

  const name = cleanText(body.name, 80) || null;
  const email = body.email ? cleanEmail(body.email) : null;
  const bootstrapAdmin = adminPhones(env).has(phone);
  let customer = await store.one('customers', { select: '*', phone: `eq.${phone}` });
  if (!customer) {
    try {
      [customer] = await store.insert('customers', { phone, name, email, role: bootstrapAdmin ? 'admin' : 'customer' });
    } catch (error) {
      if (error.code !== 'DB_CONFLICT') throw error;
      customer = await store.one('customers', { select: '*', phone: `eq.${phone}` });
    }
  }
  const patch = { last_login_at: new Date().toISOString() };
  if (name) patch.name = name;
  if (email) patch.email = email;
  if (bootstrapAdmin && customer.role !== 'admin') patch.role = 'admin';
  [customer] = await store.update('customers', { id: `eq.${customer.id}` }, patch);

  if (customer.blocked) throw new HttpError(403, 'Este acesso está bloqueado. Fala com a equipa DOT.', 'BLOCKED');
  if (purpose === 'admin' && customer.role !== 'admin') {
    throw new HttpError(403, 'Este número não tem acesso de administrador.', 'NOT_ADMIN');
  }

  const token = randomToken(32);
  const maxAge = purpose === 'admin' ? ADMIN_HOURS * 3600 : CUSTOMER_DAYS * 86400;
  await store.insert('sessions', {
    customer_id: customer.id,
    token_hash: await sha256Hex(token),
    expires_at: new Date(Date.now() + maxAge * 1000).toISOString(),
    user_agent: userAgent(request),
  }, { returning: false });
  return json({ customer: publicCustomer(customer) }, 200, {
    'Set-Cookie': cookie(SESSION_COOKIE, token, { maxAge, secure: isHttps(request) }),
  });
}

export async function getSession(request, env, deps) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token || token.length > 100 || !hasSupabase(env)) return null;
  const hash = await sha256Hex(token);
  const hit = sessionCache.get(hash);
  if (hit && hit.until > Date.now()) return hit.value;
  const row = await db(env, deps.fetcher).one('sessions', {
    select: 'id,expires_at,revoked_at,customer:customers(id,phone,name,email,role,blocked)',
    token_hash: `eq.${hash}`,
  });
  const valid = row && !row.revoked_at && Date.parse(row.expires_at) > Date.now() && row.customer && !row.customer.blocked;
  const value = valid ? { id: row.id, hash, customer: row.customer } : null;
  sessionCache.set(hash, { value, until: Date.now() + 15000 });
  if (sessionCache.size > 500) sessionCache.delete(sessionCache.keys().next().value);
  return value;
}

export function forgetSessionsOf(customerId) {
  for (const [hash, entry] of sessionCache) if (entry.value?.customer?.id === customerId) sessionCache.delete(hash);
}

export async function requireUser(request, env, deps) {
  const session = await getSession(request, env, deps);
  if (!session) throw new HttpError(401, 'Inicia sessão com o teu número de telemóvel.', 'AUTH_REQUIRED');
  return session;
}

export async function requireAdmin(request, env, deps) {
  const session = await getSession(request, env, deps);
  if (!session) throw new HttpError(401, 'Inicia sessão como administrador.', 'AUTH_REQUIRED');
  if (session.customer.role !== 'admin') throw new HttpError(403, 'Esta área é reservada à equipa DOT.', 'NOT_ADMIN');
  return session;
}

export async function me(request, env, ctx, deps) {
  const session = await getSession(request, env, deps).catch(() => null);
  return json({ customer: publicCustomer(session?.customer) });
}

export async function logout(request, env, ctx, deps) {
  assertSameOrigin(request);
  const session = await getSession(request, env, deps).catch(() => null);
  if (session) {
    await db(env, deps.fetcher).update('sessions', { id: `eq.${session.id}` }, { revoked_at: new Date().toISOString() });
    sessionCache.delete(session.hash);
  }
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, '', { maxAge: 0, secure: isHttps(request) }) });
}
