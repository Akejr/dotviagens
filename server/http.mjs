// Shared HTTP helpers for the Worker API. Every error that reaches the browser
// carries a safe Portuguese message; internal details stay in the server log.

export class HttpError extends Error {
  constructor(status, message, code = 'ERROR', extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const json = (data, status = 200, headers = {}) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

export async function readJson(request, limit = 16000) {
  const type = request.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'Pedido inválido.', 'UNSUPPORTED_MEDIA_TYPE');
  }
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, 'Pedido demasiado grande.', 'TOO_LARGE');
  try {
    const value = JSON.parse(text || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    return value;
  } catch {
    throw new HttpError(400, 'Pedido inválido.', 'BAD_JSON');
  }
}

// Browsers always send Origin on cross-site POST. Same-origin requests either
// omit it or send our own origin; anything else is refused.
export function assertSameOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    throw new HttpError(403, 'Pedido não permitido.', 'FORBIDDEN_ORIGIN');
  }
}

export function parseCookies(request) {
  const cookies = {};
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // Ignore malformed cookies instead of failing the whole request.
    }
  }
  return cookies;
}

export const isHttps = request => new URL(request.url).protocol === 'https:';

export function cookie(name, value, { maxAge, secure }) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

// Public base URL used in payment callbacks and return links.
export function publicOrigin(request, env) {
  return String(env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/+$/, '');
}

export const clientIp = request =>
  request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'local';

export const userAgent = request => (request.headers.get('user-agent') || '').slice(0, 200);

// Runs work after the response when the runtime supports it, never throwing.
export function defer(ctx, promise) {
  const safe = Promise.resolve(promise).catch(error => console.error('deferred task failed:', error?.message || error));
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(safe);
  return safe;
}

export const isoDate = value =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;

export function cleanText(value, max = 120) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function cleanEmail(value) {
  const email = cleanText(value, 160).toLowerCase();
  return /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i.test(email) ? email : null;
}
